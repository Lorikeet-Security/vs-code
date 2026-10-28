import * as vscode from 'vscode';
import type { LoryClient } from './client.ts';
import type { ConsentGate } from './consent.ts';
import type { TokenStore } from './token.ts';
import type { Analyzer } from './analyzer.ts';
import { readConfig, scanBlocker, isExcluded } from './config.ts';
import type { Finding, Severity, WorkspaceScanSummary } from './types.ts';

export interface WorkspaceScanOptions {
  concurrency?: number;
}

/**
 * Crawls and batch-reviews files across open workspace folders.
 *
 * Honors .gitignore, .loryignore, and lory.exclude patterns.
 * Limits concurrency to avoid overwhelming the client or server rate limits,
 * streams progress to the VS Code notification bar, and aggregates findings into
 * the Problems panel and the Lory Security TreeView.
 */
export class WorkspaceScanner {
  constructor(
    private readonly client: LoryClient,
    private readonly consent: ConsentGate,
    private readonly tokens: TokenStore,
    private readonly analyzer: Analyzer,
    private readonly log: vscode.LogOutputChannel
  ) {}

  async scanWorkspace(options?: WorkspaceScanOptions): Promise<WorkspaceScanSummary | null> {
    const config = readConfig();
    const concurrency = Math.max(1, Math.min(options?.concurrency ?? 4, 8));

    if (!config.enable) {
      void vscode.window.showInformationMessage('Lory is disabled (lory.enable).');
      return null;
    }

    if (!this.tokens.current()) {
      const choice = await vscode.window.showInformationMessage(
        'Lory requires an active Lorikeet Security access token to scan the workspace.',
        'Sign In with SSO',
        'Set Access Token',
        'Subscribe / Pricing'
      );
      if (choice === 'Sign In with SSO') {
        void vscode.commands.executeCommand('lory.login');
      } else if (choice === 'Set Access Token') {
        await this.tokens.prompt();
      } else if (choice === 'Subscribe / Pricing') {
        await vscode.env.openExternal(vscode.Uri.parse('https://lorikeetsecurity.com/pricing'));
      }
      return null;
    }

    if (!(await this.consent.ensure(false))) {
      void vscode.window.showInformationMessage(
        'Lory needs consent to review code. Workspace scan cancelled.'
      );
      return null;
    }

    const startTime = Date.now();
    this.log.info('Starting Lory Workspace Security Scan...');

    return vscode.window.withProgress<WorkspaceScanSummary | null>(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Lory Security: Scanning Workspace',
        cancellable: true,
      },
      async (progress, cancellationToken) => {
        progress.report({ message: 'Discovering project files...' });

        // Find candidate files matching .gitignore automatically via findFiles
        const allUris = await vscode.workspace.findFiles(
          '**/*',
          '**/{node_modules,.git,vendor,dist,build,out}/**',
          2000,
          cancellationToken
        );

        if (cancellationToken.isCancellationRequested) {
          this.log.info('Workspace scan cancelled before file processing.');
          return null;
        }

        // Filter files against lory.exclude, .loryignore, line counts, and configured languages
        const candidateUris: vscode.Uri[] = [];
        for (const uri of allUris) {
          if (isExcluded(uri, config.exclude)) {
            continue;
          }
          candidateUris.push(uri);
        }

        this.log.info(`Discovered ${candidateUris.length} eligible file(s) for review.`);
        if (candidateUris.length === 0) {
          void vscode.window.showInformationMessage(
            'No eligible source files found to scan in the current workspace.'
          );
          return null;
        }

        let scannedCount = 0;
        let totalFindings = 0;
        let errors = 0;
        const findingsBySeverity: Record<Severity, number> = {
          critical: 0,
          high: 0,
          medium: 0,
          low: 0,
          info: 0,
        };

        const queue = [...candidateUris];
        const total = queue.length;

        const worker = async (): Promise<void> => {
          while (queue.length > 0 && !cancellationToken.isCancellationRequested) {
            const uri = queue.shift();
            if (!uri) {
              break;
            }

            try {
              const document = await vscode.workspace.openTextDocument(uri);
              const fileConfig = readConfig(document.uri);
              const blocker = scanBlocker(document, fileConfig);
              if (blocker) {
                this.log.debug(`Skipping ${vscode.workspace.asRelativePath(uri)}: ${blocker}`);
                continue;
              }

              const relPath = vscode.workspace.asRelativePath(uri);
              const text = document.getText();
              const payload = {
                code: text,
                language: document.languageId,
                filename: uri.path.split('/').pop() || 'file',
                start_line: 1,
                stream: false,
              };

              const abortController = new AbortController();
              const cancelSub = cancellationToken.onCancellationRequested(() => {
                abortController.abort();
              });

              let resultFindings: Finding[] = [];
              try {
                const result = await this.client.review(payload, abortController.signal);
                resultFindings = result.findings;
              } finally {
                cancelSub.dispose();
              }

              if (cancellationToken.isCancellationRequested) {
                break;
              }

              this.analyzer.applyWorkspaceScanResult(document, resultFindings, fileConfig);
              scannedCount++;

              for (const f of resultFindings) {
                totalFindings++;
                findingsBySeverity[f.severity] = (findingsBySeverity[f.severity] ?? 0) + 1;
              }

              const percent = Math.round((scannedCount / total) * 100);
              progress.report({
                increment: 100 / total,
                message: `[${percent}%] (${scannedCount}/${total}) ${relPath} - ${resultFindings.length} issue(s)`,
              });
            } catch (err) {
              errors++;
              const msg = err instanceof Error ? err.message : String(err);
              this.log.warn(`Failed scanning ${vscode.workspace.asRelativePath(uri)}: ${msg}`);
            }
          }
        };

        // Run worker pool
        const workers: Promise<void>[] = [];
        for (let i = 0; i < concurrency; i++) {
          workers.push(worker());
        }
        await Promise.all(workers);

        const durationMs = Date.now() - startTime;
        const summary: WorkspaceScanSummary = {
          totalFiles: total,
          filesScanned: scannedCount,
          totalFindings,
          findingsBySeverity,
          durationMs,
          errors,
        };

        this.log.info(
          `Workspace scan complete in ${(durationMs / 1000).toFixed(1)}s: ` +
            `${scannedCount} files reviewed, ${totalFindings} findings detected.`
        );

        if (cancellationToken.isCancellationRequested) {
          void vscode.window.showInformationMessage(
            `Workspace scan stopped: scanned ${scannedCount} files with ${totalFindings} findings before cancellation.`
          );
        } else {
          const breakdown =
            `${findingsBySeverity.critical} Critical, ` +
            `${findingsBySeverity.high} High, ` +
            `${findingsBySeverity.medium} Medium, ` +
            `${findingsBySeverity.low} Low`;

          const msg = totalFindings === 0
            ? `🦜 Lory Workspace Scan: All ${scannedCount} files clean. No vulnerabilities found!`
            : `🦜 Lory Workspace Scan: ${scannedCount} files scanned, ${totalFindings} findings detected (${breakdown}).`;

          const action = totalFindings > 0 ? 'View Findings' : undefined;
          void vscode.window.showInformationMessage(msg, ...(action ? [action] : [])).then((chosen) => {
            if (chosen === 'View Findings') {
              void vscode.commands.executeCommand('lory.findingsView.focus');
            }
          });
        }

        return summary;
      }
    );
  }
}
