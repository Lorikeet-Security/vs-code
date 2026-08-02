import * as vscode from 'vscode';

import type { Finding, Severity } from './types.ts';

export const DIAGNOSTIC_SOURCE = 'Lory';

/** Comment developers write to silence a finding on the following line. */
const IGNORE_NEXT_LINE = /lory-ignore(?:-next-line)?\b/i;
/** Comment that silences every finding in the file. */
const IGNORE_FILE = /lory-ignore-file\b/i;

/**
 * A finding plus where it actually landed.
 *
 * The range is resolved once, against the document version the review was
 * requested for, and carried alongside so the code action provider does not
 * have to re-derive it from a document that may have moved on.
 */
export interface AnchoredFinding {
  finding: Finding;
  range: vscode.Range;
}

/**
 * Severity mapping.
 *
 * `critical` and `high` are Errors because they represent a reachable attacker
 * path and belong in the same visual weight as a broken build. `info` is a Hint
 * so it renders as a faint underline rather than adding to the problem count.
 */
export function toDiagnosticSeverity(severity: Severity): vscode.DiagnosticSeverity {
  switch (severity) {
    case 'critical':
    case 'high':
      return vscode.DiagnosticSeverity.Error;
    case 'medium':
      return vscode.DiagnosticSeverity.Warning;
    case 'low':
      return vscode.DiagnosticSeverity.Information;
    case 'info':
      return vscode.DiagnosticSeverity.Hint;
  }
}

/**
 * Resolve a finding's line numbers to a range in the document.
 *
 * The range covers the first non-whitespace character to the end of the last
 * line, so the squiggle sits under the statement rather than under the indent.
 * Returns null when the line no longer exists, which happens when the developer
 * deleted code while the review was in flight.
 */
export function anchor(document: vscode.TextDocument, finding: Finding): vscode.Range | null {
  const startLine = finding.line - 1;
  if (startLine < 0 || startLine >= document.lineCount) {
    return null;
  }

  const endLine = Math.min(
    (finding.end_line ?? finding.line) - 1,
    document.lineCount - 1
  );

  const start = document.lineAt(startLine);
  const end = document.lineAt(Math.max(startLine, endLine));

  // An entirely blank target line means the code moved out from under the
  // finding; anchoring there would point at nothing.
  if (start.isEmptyOrWhitespace && startLine === endLine) {
    return null;
  }

  return new vscode.Range(
    new vscode.Position(startLine, start.firstNonWhitespaceCharacterIndex),
    new vscode.Position(end.lineNumber, end.text.length)
  );
}

/** True when the developer has silenced this finding with a comment. */
export function isSuppressed(document: vscode.TextDocument, finding: Finding): boolean {
  if (fileSuppressed(document)) {
    return true;
  }

  const targetLine = finding.line - 1;
  if (targetLine < 0 || targetLine >= document.lineCount) {
    return false;
  }

  // Accept the marker at the end of the offending line or on the line above it,
  // which is where both eslint-disable styles put it.
  if (IGNORE_NEXT_LINE.test(document.lineAt(targetLine).text)) {
    return true;
  }
  if (targetLine > 0 && IGNORE_NEXT_LINE.test(document.lineAt(targetLine - 1).text)) {
    return true;
  }
  return false;
}

/** A `lory-ignore-file` marker anywhere in the first 20 lines disables the file. */
function fileSuppressed(document: vscode.TextDocument): boolean {
  const limit = Math.min(20, document.lineCount);
  for (let i = 0; i < limit; i++) {
    if (IGNORE_FILE.test(document.lineAt(i).text)) {
      return true;
    }
  }
  return false;
}

export function toDiagnostic(finding: Finding, range: vscode.Range): vscode.Diagnostic {
  const diagnostic = new vscode.Diagnostic(
    range,
    formatMessage(finding),
    toDiagnosticSeverity(finding.severity)
  );

  diagnostic.source = DIAGNOSTIC_SOURCE;

  // The code renders as a clickable chip in the Problems panel. Linking it to
  // MITRE gives the developer the canonical description without a search.
  if (finding.cwe) {
    diagnostic.code = {
      value: finding.cwe,
      target: vscode.Uri.parse(
        `https://cwe.mitre.org/data/definitions/${finding.cwe.replace(/^CWE-/i, '')}.html`
      ),
    };
  } else {
    diagnostic.code = finding.severity;
  }

  // Carried so the code action provider can recover the full finding from a
  // diagnostic VS Code hands back to it.
  (diagnostic as vscode.Diagnostic & { lory?: Finding }).lory = finding;

  return diagnostic;
}

/**
 * The Problems-panel message.
 *
 * Severity and confidence are inlined because the panel shows only this string:
 * an icon says "error" but not "critical", and a developer triaging a list
 * needs to know which findings Lory was unsure about.
 */
function formatMessage(finding: Finding): string {
  const parts = [`${finding.title} [${finding.severity}`];
  if (finding.confidence !== 'high') {
    parts.push(`, ${finding.confidence} confidence`);
  }
  parts.push(']');

  let message = parts.join('');
  if (finding.detail) {
    message += `\n${finding.detail}`;
  }
  if (finding.fix_note) {
    message += `\nFix: ${finding.fix_note}`;
  }
  return message;
}

/** Recover the finding attached to a diagnostic, if it is one of ours. */
export function findingOf(diagnostic: vscode.Diagnostic): Finding | undefined {
  if (diagnostic.source !== DIAGNOSTIC_SOURCE) {
    return undefined;
  }
  return (diagnostic as vscode.Diagnostic & { lory?: Finding }).lory;
}
