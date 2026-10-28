import * as vscode from 'vscode';

import { DIAGNOSTIC_SOURCE, findingOf } from './diagnostics.ts';
import type { Finding } from './types.ts';

/**
 * Quick fixes on a Lory diagnostic.
 *
 * Three actions, in the order a developer wants them: take the fix, understand
 * the finding, or silence it. Nothing here edits code without being chosen --
 * `isPreferred` is deliberately not set, because an AI-proposed security fix
 * should never be what a bulk "fix all" lands on.
 */
export class LoryCodeActionProvider implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  };

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== DIAGNOSTIC_SOURCE) {
        continue;
      }
      const finding = findingOf(diagnostic);
      if (!finding) {
        continue;
      }

      if (finding.fix) {
        actions.push(this.applyFix(document, diagnostic, finding));
        actions.push(this.previewFix(document, diagnostic, finding));
      }
      actions.push(this.explain(diagnostic, finding));
      actions.push(this.reportFalsePositive(document, diagnostic, finding));
      actions.push(this.suppressLine(document, diagnostic, finding));
    }

    return actions;
  }

  private applyFix(
    document: vscode.TextDocument,
    diagnostic: vscode.Diagnostic,
    finding: Finding
  ): vscode.CodeAction {
    const action = new vscode.CodeAction(
      `Lory: apply fix for ${finding.title}`,
      vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diagnostic];

    // Replace whole lines, not the diagnostic's range: the range starts at the
    // first non-whitespace character so the squiggle skips the indent, but a
    // replacement has to own the indent or the fix lands double-indented.
    const startLine = diagnostic.range.start.line;
    const endLine = diagnostic.range.end.line;
    const replaceRange = new vscode.Range(
      new vscode.Position(startLine, 0),
      document.lineAt(endLine).range.end
    );

    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, replaceRange, stripTrailingNewline(finding.fix!));
    action.edit = edit;

    if (finding.fix_note) {
      action.command = {
        command: 'lory.showOutput',
        title: finding.fix_note,
      };
    }

    return action;
  }

  private previewFix(
    document: vscode.TextDocument,
    diagnostic: vscode.Diagnostic,
    finding: Finding
  ): vscode.CodeAction {
    const action = new vscode.CodeAction(
      `Lory: preview fix diff for ${finding.title}`,
      vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diagnostic];
    action.command = {
      command: 'lory.previewFix',
      title: 'Preview Fix Diff',
      arguments: [document, finding],
    };
    return action;
  }

  private reportFalsePositive(
    document: vscode.TextDocument,
    diagnostic: vscode.Diagnostic,
    finding: Finding
  ): vscode.CodeAction {
    const action = new vscode.CodeAction(
      `Lory: report false positive for ${finding.title}`,
      vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diagnostic];
    action.command = {
      command: 'lory.reportFalsePositive',
      title: 'Report False Positive',
      arguments: [document, finding],
    };
    return action;
  }

  private explain(diagnostic: vscode.Diagnostic, finding: Finding): vscode.CodeAction {
    const action = new vscode.CodeAction(
      `Lory: explain ${finding.title}`,
      vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diagnostic];
    action.command = {
      command: 'lory.explainFinding',
      title: 'Explain',
      arguments: [finding],
    };
    return action;
  }

  private suppressLine(
    document: vscode.TextDocument,
    diagnostic: vscode.Diagnostic,
    finding: Finding
  ): vscode.CodeAction {
    const action = new vscode.CodeAction(
      'Lory: ignore this finding',
      vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diagnostic];

    const line = document.lineAt(diagnostic.range.start.line);
    const indent = line.text.slice(0, line.firstNonWhitespaceCharacterIndex);
    const comment = commentFor(document.languageId, `lory-ignore ${finding.title}`);

    const edit = new vscode.WorkspaceEdit();
    edit.insert(
      document.uri,
      new vscode.Position(line.lineNumber, 0),
      `${indent}${comment}\n`
    );
    action.edit = edit;

    return action;
  }
}

/** Render a finding as Markdown for the explanation panel. */
export function explanationMarkdown(finding: Finding): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.supportHtml = false;

  md.appendMarkdown(`### ${finding.title}\n\n`);
  md.appendMarkdown(
    `**Severity:** ${finding.severity} · **Confidence:** ${finding.confidence}`
  );
  if (finding.cwe) {
    const id = finding.cwe.replace(/^CWE-/i, '');
    md.appendMarkdown(
      ` · [${finding.cwe}](https://cwe.mitre.org/data/definitions/${id}.html)`
    );
  }
  md.appendMarkdown(`\n\n${finding.detail}\n`);

  if (finding.fix) {
    md.appendMarkdown('\n**Suggested fix**\n');
    md.appendCodeblock(stripTrailingNewline(finding.fix));
  }
  if (finding.fix_note) {
    md.appendMarkdown(`\n${finding.fix_note}\n`);
  }

  return md;
}

function stripTrailingNewline(text: string): string {
  return text.replace(/\r?\n$/, '');
}

/**
 * Line-comment syntax per language.
 *
 * Only languages in the default `lory.languages` list are covered; anything
 * else gets `//`, which is wrong for a handful but harmless -- the developer
 * sees the inserted line immediately and can fix it.
 */
function commentFor(languageId: string, text: string): string {
  switch (languageId) {
    case 'python':
    case 'ruby':
    case 'shellscript':
    case 'yaml':
    case 'dockerfile':
    case 'terraform':
    case 'powershell':
      return `# ${text}`;
    case 'sql':
      return `-- ${text}`;
    case 'html':
    case 'vue':
    case 'svelte':
      return `<!-- ${text} -->`;
    default:
      return `// ${text}`;
  }
}
