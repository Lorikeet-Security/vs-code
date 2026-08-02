import { createHash } from 'node:crypto';
import * as vscode from 'vscode';

import { type LoryClient, LoryError } from './client.ts';
import { passesFilter, readConfig, scanBlocker, type LoryConfig } from './config.ts';
import { anchor, isSuppressed, toDiagnostic, type AnchoredFinding } from './diagnostics.ts';
import type { ConsentGate } from './consent.ts';
import { SEVERITY_RANK, type Finding, type ReviewRequest } from './types.ts';

export interface ScanRequest {
  document: vscode.TextDocument;
  /** Review only these lines. Absent means the whole file. */
  range?: vscode.Range;
  /** User asked for this directly, so it may prompt and may bypass the cache. */
  explicit?: boolean;
}

export interface ScanState {
  status: 'idle' | 'scanning' | 'error' | 'needs-consent';
  message?: string;
  counts: Record<string, number>;
}

type StateListener = (state: ScanState) => void;

/**
 * Owns the review lifecycle: when to scan, what to send, what to keep.
 *
 * One in-flight review per document. A new edit aborts the old request rather
 * than racing it, because the old answer is already anchored to line numbers
 * that have moved.
 */
export class Analyzer implements vscode.Disposable {
  private readonly diagnostics: vscode.DiagnosticCollection;
  private readonly debounces = new Map<string, NodeJS.Timeout>();
  private readonly inflight = new Map<string, AbortController>();
  /** Document key -> content hash of the last completed review. */
  private readonly reviewed = new Map<string, string>();
  /** Document key -> findings currently displayed, for the code action provider. */
  private readonly anchored = new Map<string, AnchoredFinding[]>();
  private readonly listeners = new Set<StateListener>();
  /** Error kinds already surfaced, so a background retry loop cannot spam toasts. */
  private readonly warned = new Set<string>();
  private state: ScanState = { status: 'idle', counts: {} };

  constructor(
    private readonly client: LoryClient,
    private readonly consent: ConsentGate,
    private readonly log: vscode.LogOutputChannel
  ) {
    this.diagnostics = vscode.languages.createDiagnosticCollection('lory');
  }

  onStateChange(listener: StateListener): vscode.Disposable {
    this.listeners.add(listener);
    listener(this.state);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  findingsFor(document: vscode.TextDocument): AnchoredFinding[] {
    return this.anchored.get(key(document)) ?? [];
  }

  /** Queue a debounced review. Called on every keystroke, so it must stay cheap. */
  schedule(document: vscode.TextDocument): void {
    const config = readConfig(document.uri);
    if (config.scanOn !== 'type' || scanBlocker(document, config) !== null) {
      return;
    }

    const id = key(document);
    const existing = this.debounces.get(id);
    if (existing) {
      clearTimeout(existing);
    }

    this.debounces.set(
      id,
      setTimeout(() => {
        this.debounces.delete(id);
        void this.scan({ document });
      }, config.debounceMs)
    );
  }

  /**
   * Run a review now.
   *
   * Safe to call concurrently for different documents; a second call for the
   * same document cancels the first.
   */
  async scan(request: ScanRequest): Promise<void> {
    const { document, range, explicit = false } = request;
    const config = readConfig(document.uri);

    const blocker = scanBlocker(document, config);
    if (blocker) {
      if (explicit) {
        void vscode.window.showInformationMessage(blocker);
      }
      return;
    }

    if (!(await this.consent.ensure(!explicit))) {
      this.publishState({
        status: 'needs-consent',
        message: 'Lory needs permission to send code for review.',
        counts: {},
      });
      return;
    }

    const id = key(document);
    const text = range ? document.getText(range) : document.getText();
    if (text.trim() === '') {
      return;
    }

    const startLine = range ? range.start.line + 1 : 1;
    const hash = hashOf(text, startLine, config);

    // The same bytes always produce the same review, so re-sending them costs a
    // request and returns what is already on screen. An explicit scan overrides
    // this: asking again is how a developer retries a failed or stale review.
    if (!explicit && this.reviewed.get(id) === hash) {
      return;
    }

    this.cancel(id);
    const controller = new AbortController();
    this.inflight.set(id, controller);

    // Anchoring is done against the version the review was requested for. If the
    // document changes underneath, the results are dropped rather than applied
    // to lines that no longer hold the reviewed code.
    const version = document.version;
    const collected: Finding[] = [];
    const payload: ReviewRequest = {
      code: text,
      language: document.languageId,
      filename: basename(document.uri),
      start_line: startLine,
      stream: config.stream,
    };

    this.publishState({ status: 'scanning', counts: this.state.counts });
    this.log.info(
      `Reviewing ${payload.filename} (${document.languageId}, ` +
        `lines ${startLine}-${startLine + text.split('\n').length - 1})`
    );

    try {
      const result = await this.client.review(
        payload,
        controller.signal,
        config.stream
          ? (finding) => {
              collected.push(finding);
              if (document.version === version) {
                this.render(document, collected, config);
              }
            }
          : undefined
      );

      if (controller.signal.aborted) {
        return;
      }
      if (document.version !== version) {
        this.log.debug('Document changed during review; discarding results.');
        return;
      }

      this.reviewed.set(id, hash);
      this.render(document, result.findings, config);
      this.log.info(
        `${result.findings.length} finding(s) in ${payload.filename}. ${result.summary}` +
          (result.meta?.tier ? ` [${result.meta.tier} tier]` : '')
      );
      // A review got through, so whatever was previously broken is not any more.
      this.warned.clear();
      this.publishState({ status: 'idle', counts: this.countsFor(document) });
    } catch (err) {
      if (err instanceof LoryError && err.kind === 'cancelled') {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`Review failed: ${message}`);
      this.publishState({ status: 'error', message, counts: this.state.counts });
      this.warn(err, explicit);
    } finally {
      if (this.inflight.get(id) === controller) {
        this.inflight.delete(id);
      }
    }
  }

  /**
   * Surface a failure the developer can act on, at most once per kind.
   *
   * Rate limiting and a rejected token are both configuration problems rather
   * than transient blips, so they are worth a notification -- but the on-type
   * trigger retries on every pause, and a toast per keystroke is worse than the
   * original problem. The latch clears on the next successful review.
   */
  private warn(err: unknown, explicit: boolean): void {
    if (!(err instanceof LoryError)) {
      return;
    }
    if (err.kind !== 'rate-limit' && err.kind !== 'auth') {
      return;
    }
    // An explicit scan always answers, even if the same warning was already
    // shown: the developer just asked, and silence would read as a no-op.
    if (!explicit && this.warned.has(err.kind)) {
      return;
    }
    this.warned.add(err.kind);

    const setToken = 'Set token';
    void vscode.window
      .showWarningMessage(err.message, ...(err.kind === 'auth' ? [setToken] : []))
      .then((choice) => {
        if (choice === setToken) {
          void vscode.commands.executeCommand('lory.setToken');
        }
      });
  }

  /** Apply findings to the document, dropping suppressed and filtered ones. */
  private render(
    document: vscode.TextDocument,
    findings: Finding[],
    config: LoryConfig
  ): void {
    const anchoredFindings: AnchoredFinding[] = [];
    const diagnostics: vscode.Diagnostic[] = [];

    const ordered = [...findings].sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.line - b.line
    );

    for (const finding of ordered) {
      if (!passesFilter(finding, config) || isSuppressed(document, finding)) {
        continue;
      }
      const range = anchor(document, finding);
      if (!range) {
        this.log.debug(`Dropping finding on line ${finding.line}: no longer anchorable.`);
        continue;
      }
      anchoredFindings.push({ finding, range });
      diagnostics.push(toDiagnostic(finding, range));
    }

    this.anchored.set(key(document), anchoredFindings);
    this.diagnostics.set(document.uri, diagnostics);
  }

  private countsFor(document: vscode.TextDocument): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const { finding } of this.findingsFor(document)) {
      counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
    }
    return counts;
  }

  /** Recompute the status bar for whichever document is now in front. */
  refreshState(document: vscode.TextDocument | undefined): void {
    if (this.state.status === 'scanning') {
      return;
    }
    this.publishState({
      status: 'idle',
      counts: document ? this.countsFor(document) : {},
    });
  }

  clear(document: vscode.TextDocument): void {
    const id = key(document);
    this.cancel(id);
    this.diagnostics.delete(document.uri);
    this.anchored.delete(id);
    this.reviewed.delete(id);
    this.refreshState(document);
  }

  clearAll(): void {
    for (const controller of this.inflight.values()) {
      controller.abort();
    }
    this.inflight.clear();
    for (const timer of this.debounces.values()) {
      clearTimeout(timer);
    }
    this.debounces.clear();
    this.diagnostics.clear();
    this.anchored.clear();
    this.reviewed.clear();
    this.publishState({ status: 'idle', counts: {} });
  }

  /** Forget cached hashes so the next scan re-reviews. Used when settings change. */
  invalidateCache(): void {
    this.reviewed.clear();
  }

  /** Re-apply filters and suppressions to what is already on screen. */
  rerender(document: vscode.TextDocument): void {
    const existing = this.anchored.get(key(document));
    if (!existing || existing.length === 0) {
      return;
    }
    this.render(
      document,
      existing.map((a) => a.finding),
      readConfig(document.uri)
    );
  }

  forget(document: vscode.TextDocument): void {
    const id = key(document);
    this.cancel(id);
    this.anchored.delete(id);
    this.reviewed.delete(id);
    // Diagnostics for a closed file are dropped by VS Code for untitled docs but
    // persist for files, which is what makes the Problems panel useful after a
    // scan. They are cleared explicitly by the Clear commands.
  }

  private cancel(id: string): void {
    const timer = this.debounces.get(id);
    if (timer) {
      clearTimeout(timer);
      this.debounces.delete(id);
    }
    this.inflight.get(id)?.abort();
    this.inflight.delete(id);
  }

  private publishState(state: ScanState): void {
    this.state = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }

  dispose(): void {
    this.clearAll();
    this.diagnostics.dispose();
    this.listeners.clear();
  }
}

function key(document: vscode.TextDocument): string {
  return document.uri.toString();
}

function basename(uri: vscode.Uri): string {
  const parts = uri.path.split('/');
  return parts[parts.length - 1] || 'untitled';
}

/**
 * Cache key.
 *
 * Covers the settings that change what comes back, so tightening
 * `minimumSeverity` and scanning again is not a silent no-op.
 */
function hashOf(text: string, startLine: number, config: LoryConfig): string {
  return createHash('sha256')
    .update(`${startLine} ${config.minimumSeverity} ${config.minimumConfidence} `)
    .update(text)
    .digest('hex');
}
