import * as vscode from 'vscode';

import { matchesAny } from './glob.ts';
import {
  CONFIDENCE_RANK,
  SEVERITY_RANK,
  type Confidence,
  type Finding,
  type Severity,
  isConfidence,
  isSeverity,
} from './types.ts';

export type ScanTrigger = 'type' | 'save' | 'manual';

export interface LoryConfig {
  enable: boolean;
  baseUrl: string;
  scanOn: ScanTrigger;
  debounceMs: number;
  minimumSeverity: Severity;
  minimumConfidence: Confidence;
  languages: string[];
  exclude: string[];
  maxFileLines: number;
  stream: boolean;
  timeoutMs: number;
}

/**
 * Read settings for a specific document.
 *
 * Scoped per resource so a monorepo can review its services and ignore its
 * generated clients through folder-level settings.
 */
export function readConfig(scope?: vscode.Uri): LoryConfig {
  const c = vscode.workspace.getConfiguration('lory', scope ?? null);

  const severity = c.get<string>('minimumSeverity', 'low');
  const confidence = c.get<string>('minimumConfidence', 'low');

  return {
    enable: c.get<boolean>('enable', true),
    baseUrl: c.get<string>('baseUrl', 'https://lorikeetsecurity.com').replace(/\/+$/, ''),
    scanOn: readTrigger(c.get<string>('scanOn', 'type')),
    debounceMs: clamp(c.get<number>('debounceMs', 1500), 400, 15000),
    minimumSeverity: isSeverity(severity) ? severity : 'low',
    minimumConfidence: isConfidence(confidence) ? confidence : 'low',
    languages: c.get<string[]>('languages', []),
    exclude: c.get<string[]>('exclude', []),
    // The server refuses more than 1600 lines; clamping here turns a wasted
    // round trip into a local skip with a clear reason.
    maxFileLines: clamp(c.get<number>('maxFileLines', 1500), 50, 1600),
    stream: c.get<boolean>('stream', true),
    timeoutMs: clamp(c.get<number>('timeoutMs', 60000), 5000, 180000),
  };
}

function readTrigger(value: string): ScanTrigger {
  return value === 'save' || value === 'manual' ? value : 'type';
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

/** True when the finding clears both the severity and confidence floors. */
export function passesFilter(finding: Finding, config: LoryConfig): boolean {
  return (
    SEVERITY_RANK[finding.severity] <= SEVERITY_RANK[config.minimumSeverity] &&
    CONFIDENCE_RANK[finding.confidence] <= CONFIDENCE_RANK[config.minimumConfidence]
  );
}

/**
 * Decide whether a document may be sent for review.
 *
 * Returns a human-readable reason when it may not, so the status bar and the
 * manual command can say why nothing happened rather than failing silently.
 */
export function scanBlocker(
  document: vscode.TextDocument,
  config: LoryConfig
): string | null {
  if (!config.enable) {
    return 'Lory is disabled for this file (lory.enable).';
  }
  // Untitled buffers are fine to review; other non-file schemes are not. A
  // git: diff view or an output channel is a read-only projection, and marking
  // it up helps nobody.
  if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') {
    return `Lory does not review ${document.uri.scheme}: documents.`;
  }
  if (!config.languages.includes(document.languageId)) {
    return `Lory is not configured for ${document.languageId} (lory.languages).`;
  }
  if (isExcluded(document.uri, config.exclude)) {
    return 'This file matches a lory.exclude pattern.';
  }
  if (document.lineCount > config.maxFileLines) {
    return `File is ${document.lineCount} lines, over the ${config.maxFileLines} line limit. Select a region and run Lory: Scan Selection.`;
  }
  if (document.getText().trim() === '') {
    return 'File is empty.';
  }
  return null;
}

export function isExcluded(uri: vscode.Uri, patterns: string[]): boolean {
  // Checked against both forms: a workspace-relative pattern like `dist/**`
  // only matches the relative path, while an absolute pattern a user pasted in
  // only matches fsPath.
  return matchesAny(patterns, vscode.workspace.asRelativePath(uri, false), uri.fsPath);
}
