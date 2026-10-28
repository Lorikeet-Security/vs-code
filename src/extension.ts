import * as vscode from 'vscode';

import { Analyzer } from './analyzer.ts';
import { LoryCodeActionProvider, explanationMarkdown } from './actions.ts';
import { LoryClient } from './client.ts';
import { readConfig, scanBlocker, setActivePolicyStore } from './config.ts';
import { ConsentGate } from './consent.ts';
import { StatusBar } from './status.ts';
import { TokenStore } from './token.ts';
import { PolicyStore } from './policyStore.ts';
import { WorkspaceScanner } from './workspace.ts';
import { loginSSO } from './auth.ts';
import {
  LoryDiffProvider,
  FIX_SCHEME,
  previewFindingFix,
  applyFixToDocument,
  reportFalsePositive,
} from './diff.ts';
import {
  LoryFindingsTreeProvider,
  LoryAssetsTreeProvider,
  LoryAccountTreeProvider,
  FindingTreeItem,
  type AssetTreeItem,
} from './treeview.ts';
import type { Finding } from './types.ts';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('Lory', { log: true });

  const policyStore = new PolicyStore();
  setActivePolicyStore(policyStore);
  context.subscriptions.push(policyStore, await policyStore.initialise());

  const config = readConfig();

  const tokens = new TokenStore(context.secrets);
  context.subscriptions.push(tokens, await tokens.initialise());

  const client = new LoryClient({
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
    userAgent: `lory-vscode/${version(context)}`,
    token: tokens.current(),
  });

  // Setting the token in another window or via SSO takes effect immediately without a reload.
  context.subscriptions.push(
    tokens.onDidChange((token) => {
      client.update({ token });
      log.info(token ? 'Access token configured.' : 'Access token cleared.');
      const active = vscode.window.activeTextEditor?.document;
      analyzer.refreshState(active);
    })
  );

  const consent = new ConsentGate(context.globalState);
  const analyzer = new Analyzer(client, consent, tokens, log);
  const status = new StatusBar();
  const scanner = new WorkspaceScanner(client, consent, tokens, analyzer, log);
  const diffProvider = new LoryDiffProvider();

  context.subscriptions.push(
    log,
    analyzer,
    status,
    diffProvider,
    vscode.workspace.registerTextDocumentContentProvider(FIX_SCHEME, diffProvider)
  );
  context.subscriptions.push(analyzer.onStateChange((state) => status.render(state)));

  // ── TreeView Providers ───────────────────────────────────────────────

  const findingsTreeProvider = new LoryFindingsTreeProvider(analyzer);
  const assetsTreeProvider = new LoryAssetsTreeProvider(analyzer);
  const accountTreeProvider = new LoryAccountTreeProvider(tokens);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('lory.findingsView', findingsTreeProvider),
    vscode.window.registerTreeDataProvider('lory.assetsView', assetsTreeProvider),
    vscode.window.registerTreeDataProvider('lory.accountView', accountTreeProvider)
  );

  // ── Editor events ────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.contentChanges.length === 0) {
        return;
      }
      analyzer.schedule(event.document);
    }),

    vscode.workspace.onDidSaveTextDocument((document) => {
      const cfg = readConfig(document.uri);
      // 'manual' means exactly that. 'type' still scans on save so the file is
      // reviewed whole even when the last edit was inside a debounce window.
      if (cfg.scanOn !== 'manual') {
        void analyzer.scan({ document });
      }
    }),

    vscode.workspace.onDidCloseTextDocument((document) => analyzer.forget(document)),

    vscode.window.onDidChangeActiveTextEditor((editor) => {
      updateContext(editor?.document);
      analyzer.refreshState(editor?.document);
    }),

    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('lory')) {
        return;
      }
      const next = readConfig();
      client.update({ baseUrl: next.baseUrl, timeoutMs: next.timeoutMs });
      // Filter settings change what is displayed rather than what is found, so
      // the visible findings are re-filtered in place instead of re-requested.
      analyzer.invalidateCache();
      const active = vscode.window.activeTextEditor?.document;
      if (active) {
        analyzer.rerender(active);
        updateContext(active);
        analyzer.refreshState(active);
      }
      findingsTreeProvider.refresh();
      assetsTreeProvider.refresh();
    })
  );

  // ── Commands ─────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('lory.scanFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showInformationMessage('Open a file for Lory to review.');
        return;
      }
      await analyzer.scan({ document: editor.document, explicit: true });
    }),

    vscode.commands.registerCommand('lory.scanSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        void vscode.window.showInformationMessage('Select the code for Lory to review.');
        return;
      }
      // Whole lines only: a review of half a statement has no context to work
      // with, and the line numbers must line up with the document either way.
      const selection = new vscode.Range(
        new vscode.Position(editor.selection.start.line, 0),
        editor.document.lineAt(editor.selection.end.line).range.end
      );
      await analyzer.scan({ document: editor.document, range: selection, explicit: true });
    }),

    vscode.commands.registerCommand('lory.scanWorkspace', async () => {
      await scanner.scanWorkspace();
    }),

    vscode.commands.registerCommand('lory.clearFile', () => {
      const document = vscode.window.activeTextEditor?.document;
      if (document) {
        analyzer.clear(document);
      }
    }),

    vscode.commands.registerCommand('lory.clearAll', () => analyzer.clearAll()),

    vscode.commands.registerCommand('lory.showOutput', () => log.show(true)),

    vscode.commands.registerCommand('lory.refreshFindings', () => {
      findingsTreeProvider.refresh();
      assetsTreeProvider.refresh();
      accountTreeProvider.refresh();
    }),

    vscode.commands.registerCommand('lory.toggleAutoScan', async () => {
      const settings = vscode.workspace.getConfiguration('lory');
      const current = settings.get<string>('scanOn', 'type');
      const next = current === 'type' ? 'save' : 'type';
      await settings.update('scanOn', next, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(
        next === 'type'
          ? 'Lory will review while you type.'
          : 'Lory will review on save only.'
      );
    }),

    vscode.commands.registerCommand('lory.resetConsent', async () => {
      await consent.reset();
      analyzer.clearAll();
      void vscode.window.showInformationMessage(
        'Lory will ask again before sending code for review.'
      );
    }),

    vscode.commands.registerCommand(
      'lory.explainFinding',
      async (arg: Finding | FindingTreeItem) => {
        const finding = arg instanceof FindingTreeItem ? arg.finding : arg;
        await showExplanation(finding);
      }
    ),

    vscode.commands.registerCommand(
      'lory.previewFix',
      async (first: vscode.TextDocument | FindingTreeItem, second?: Finding) => {
        let doc: vscode.TextDocument;
        let finding: Finding;
        if (second) {
          doc = first as vscode.TextDocument;
          finding = second;
        } else {
          const item = first as FindingTreeItem;
          doc = await vscode.workspace.openTextDocument(item.uri);
          finding = item.finding;
        }
        await previewFindingFix(doc, finding, diffProvider);
      }
    ),

    vscode.commands.registerCommand(
      'lory.applyFindingFix',
      async (first: vscode.TextDocument | FindingTreeItem, second?: Finding) => {
        let doc: vscode.TextDocument;
        let finding: Finding;
        if (second) {
          doc = first as vscode.TextDocument;
          finding = second;
        } else {
          const item = first as FindingTreeItem;
          doc = await vscode.workspace.openTextDocument(item.uri);
          finding = item.finding;
        }
        await applyFixToDocument(doc, finding);
      }
    ),

    vscode.commands.registerCommand(
      'lory.reportFalsePositive',
      async (first: vscode.TextDocument | FindingTreeItem, second?: Finding) => {
        let doc: vscode.TextDocument;
        let finding: Finding;
        if (second) {
          doc = first as vscode.TextDocument;
          finding = second;
        } else {
          const item = first as FindingTreeItem;
          doc = await vscode.workspace.openTextDocument(item.uri);
          finding = item.finding;
        }
        const cfg = readConfig(doc.uri);
        await reportFalsePositive(doc, finding, cfg.baseUrl, log);
      }
    ),

    vscode.commands.registerCommand('lory.scanAsset', async (item: AssetTreeItem) => {
      const doc = await vscode.workspace.openTextDocument(item.uri);
      await analyzer.scan({ document: doc, explicit: true });
    }),

    vscode.commands.registerCommand('lory.login', async () => {
      const cfg = readConfig();
      const result = await loginSSO({ baseUrl: cfg.baseUrl, tokenStore: tokens, log });
      if (result.success && result.account) {
        void vscode.window.showInformationMessage(
          `🦜 Authenticated with Lorikeet Security as ${result.account.userEmail} (${result.account.companyName}).`
        );
      } else if (!result.success && result.error) {
        void vscode.window.showErrorMessage(`SSO Authentication failed: ${result.error}`);
      }
    }),

    vscode.commands.registerCommand('lory.setToken', async () => {
      if (await tokens.prompt()) {
        void vscode.window.showInformationMessage(
          'Lory access token saved. Your rate limit is now keyed to the token.'
        );
      }
    }),

    vscode.commands.registerCommand('lory.clearToken', async () => {
      await tokens.clear();
      void vscode.window.showInformationMessage(
        'Lory access token removed. Set a new access token to reactivate reviews.'
      );
    }),

    vscode.commands.registerCommand('lory.openDashboard', async () => {
      await vscode.env.openExternal(
        vscode.Uri.parse('https://lorikeetsecurity.com/talon/dashboard/mcp')
      );
    }),

    vscode.commands.registerCommand('lory.subscribe', async () => {
      await vscode.env.openExternal(
        vscode.Uri.parse('https://lorikeetsecurity.com/pricing')
      );
    })
  );

  // ── Providers ────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      readConfig().languages.map((language) => ({ language })),
      new LoryCodeActionProvider(),
      LoryCodeActionProvider.metadata
    )
  );

  updateContext(vscode.window.activeTextEditor?.document);
  log.info(`Lory active. Endpoint: ${client.reviewUrl}`);
}

export function deactivate(): void {
  // Everything is registered in context.subscriptions and disposed by VS Code.
}

/** Drives the `lory.canScan` when-clause on the editor title button. */
function updateContext(document: vscode.TextDocument | undefined): void {
  const canScan =
    document !== undefined && scanBlocker(document, readConfig(document.uri)) === null;
  void vscode.commands.executeCommand('setContext', 'lory.canScan', canScan);
}

/**
 * Show a finding's full explanation.
 *
 * A webview would be heavier and a modal would block; the Markdown preview of a
 * virtual document reuses the editor the developer is already looking at.
 */
async function showExplanation(finding: Finding): Promise<void> {
  const markdown = explanationMarkdown(finding).value;
  const document = await vscode.workspace.openTextDocument({
    content: markdown,
    language: 'markdown',
  });
  await vscode.window.showTextDocument(document, {
    preview: true,
    viewColumn: vscode.ViewColumn.Beside,
  });
  await vscode.commands.executeCommand('markdown.showPreview');
}

function version(context: vscode.ExtensionContext): string {
  return (context.extension.packageJSON as { version?: string }).version ?? '0.0.0';
}
