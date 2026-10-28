import * as vscode from 'vscode';
import type { Finding } from './types.ts';

export const FIX_SCHEME = 'lory-fix';

/**
 * TextDocumentContentProvider providing virtual documents representing
 * proposed code fixes for side-by-side diff previews.
 */
export class LoryDiffProvider implements vscode.TextDocumentContentProvider {
  private readonly previews = new Map<string, string>();
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.previews.get(uri.toString()) ?? '';
  }

  setPreview(uri: vscode.Uri, content: string): void {
    this.previews.set(uri.toString(), content);
    this.onDidChangeEmitter.fire(uri);
  }

  clearPreview(uri: vscode.Uri): void {
    this.previews.delete(uri.toString());
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
    this.previews.clear();
  }
}

/**
 * Generates the full file content with the finding's proposed fix applied.
 */
export function generateFixedContent(
  document: vscode.TextDocument,
  finding: Finding
): string | null {
  if (!finding.fix) {
    return null;
  }

  const startLine = finding.line - 1;
  const endLine = (finding.end_line ?? finding.line) - 1;

  if (startLine < 0 || startLine >= document.lineCount) {
    return null;
  }

  const clampedEndLine = Math.min(Math.max(startLine, endLine), document.lineCount - 1);
  const startOffset = document.offsetAt(new vscode.Position(startLine, 0));
  const endOffset = document.offsetAt(document.lineAt(clampedEndLine).range.end);

  const fullText = document.getText();
  const before = fullText.slice(0, startOffset);
  const after = fullText.slice(endOffset);

  const cleanFix = finding.fix.replace(/\r?\n$/, '');
  return before + cleanFix + after;
}

/**
 * Opens a side-by-side diff preview between the real document and the proposed fix,
 * prompting the user to accept or reject the fix.
 */
export async function previewFindingFix(
  document: vscode.TextDocument,
  finding: Finding,
  diffProvider: LoryDiffProvider
): Promise<void> {
  if (!finding.fix) {
    void vscode.window.showInformationMessage(
      `No automated quick-fix available for "${finding.title}".`
    );
    return;
  }

  const fixedContent = generateFixedContent(document, finding);
  if (fixedContent === null) {
    void vscode.window.showErrorMessage(
      `Unable to anchor fix for "${finding.title}": file has changed.`
    );
    return;
  }

  const query = `finding=${encodeURIComponent(finding.title)}&t=${Date.now()}`;
  const previewUri = vscode.Uri.from({
    scheme: FIX_SCHEME,
    path: document.uri.path,
    query,
  });

  diffProvider.setPreview(previewUri, fixedContent);

  const title = `Original ↔ Lory Fix: ${finding.title}`;
  await vscode.commands.executeCommand('vscode.diff', document.uri, previewUri, title, {
    preview: true,
  });

  const choice = await vscode.window.showInformationMessage(
    `Lory suggested fix for "${finding.title}". Apply this fix?`,
    'Apply Fix',
    'Keep Original'
  );

  if (choice === 'Apply Fix') {
    await applyFixToDocument(document, finding);
    diffProvider.clearPreview(previewUri);
  }
}

/**
 * Applies a finding's fix directly to a text document.
 */
export async function applyFixToDocument(
  document: vscode.TextDocument,
  finding: Finding
): Promise<boolean> {
  if (!finding.fix) {
    return false;
  }

  const startLine = finding.line - 1;
  const endLine = Math.min(
    (finding.end_line ?? finding.line) - 1,
    document.lineCount - 1
  );

  if (startLine < 0 || startLine >= document.lineCount) {
    return false;
  }

  const replaceRange = new vscode.Range(
    new vscode.Position(startLine, 0),
    document.lineAt(endLine).range.end
  );

  const cleanFix = finding.fix.replace(/\r?\n$/, '');
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, replaceRange, cleanFix);

  const success = await vscode.workspace.applyEdit(edit);
  if (success) {
    void vscode.window.showInformationMessage(
      `Fix applied for "${finding.title}".`
    );
  }
  return success;
}

/**
 * Reports a false positive to the Lorikeet PTaaS triage queue.
 */
export async function reportFalsePositive(
  document: vscode.TextDocument,
  finding: Finding,
  baseUrl: string,
  log?: vscode.LogOutputChannel
): Promise<void> {
  const note = await vscode.window.showInputBox({
    title: `Report False Positive: ${finding.title}`,
    prompt: 'Optionally explain why this is a false positive (e.g. validated upstream):',
    placeHolder: 'e.g. Input is sanitized by regex guard on line 42',
    ignoreFocusOut: true,
  });

  if (note === undefined) {
    return; // User cancelled
  }

  const cleanBase = baseUrl.replace(/\/+$/, '');
  const triageUrl =
    `${cleanBase}/talon/dashboard/mcp?action=report_fp` +
    `&title=${encodeURIComponent(finding.title)}` +
    `&cwe=${encodeURIComponent(finding.cwe ?? '')}` +
    `&severity=${encodeURIComponent(finding.severity)}` +
    `&file=${encodeURIComponent(vscode.workspace.asRelativePath(document.uri))}` +
    `&line=${finding.line}` +
    `&note=${encodeURIComponent(note.trim())}`;

  log?.info(`Reporting false positive for ${finding.title} in ${document.uri.fsPath}`);
  await vscode.env.openExternal(vscode.Uri.parse(triageUrl));

  void vscode.window.showInformationMessage(
    `Reported false positive for "${finding.title}". Thank you for improving Lory accuracy!`
  );
}
