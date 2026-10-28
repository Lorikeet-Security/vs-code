import * as vscode from 'vscode';

import type { ScanState } from './analyzer.ts';

/**
 * The status bar item.
 *
 * A background reviewer that shows nothing is indistinguishable from a broken
 * one, so this always says which of the four states it is in: working, clean,
 * found something, or blocked.
 */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.name = 'Lory';
    this.item.show();
  }

  render(state: ScanState): void {
    switch (state.status) {
      case 'needs-token':
        this.item.text = '$(key) Lory: Activate';
        this.item.tooltip =
          'Lory requires an active Lorikeet Security access token. Click to set your token.';
        this.item.command = 'lory.setToken';
        this.item.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.warningBackground'
        );
        return;

      case 'scanning':
        this.item.text = '$(sync~spin) Lory';
        this.item.tooltip = 'Lory is reviewing this file.';
        this.item.command = 'lory.showOutput';
        this.item.backgroundColor = undefined;
        return;

      case 'needs-consent':
        this.item.text = '$(shield) Lory: allow';
        this.item.tooltip =
          'Lory needs permission to send code for review. Run Lory: Scan Active File to decide.';
        this.item.command = 'lory.scanFile';
        this.item.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.warningBackground'
        );
        return;

      case 'error':
        this.item.text = '$(shield) Lory: error';
        this.item.tooltip = state.message ?? 'The last review failed.';
        this.item.command = 'lory.showOutput';
        this.item.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.warningBackground'
        );
        return;

      case 'idle': {
        const total = Object.values(state.counts).reduce((a, b) => a + b, 0);
        const worst = worstSeverity(state.counts);

        this.item.backgroundColor =
          worst === 'critical' || worst === 'high'
            ? new vscode.ThemeColor('statusBarItem.errorBackground')
            : undefined;

        if (total === 0) {
          this.item.text = '$(shield) Lory';
          this.item.tooltip = 'No findings in this file.';
        } else {
          this.item.text = `$(shield) Lory: ${total}`;
          this.item.tooltip = describe(state.counts);
        }
        this.item.command = 'workbench.actions.view.problems';
      }
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}

function worstSeverity(counts: Record<string, number>): string | undefined {
  for (const severity of ['critical', 'high', 'medium', 'low', 'info']) {
    if ((counts[severity] ?? 0) > 0) {
      return severity;
    }
  }
  return undefined;
}

function describe(counts: Record<string, number>): string {
  const parts: string[] = [];
  for (const severity of ['critical', 'high', 'medium', 'low', 'info']) {
    const n = counts[severity] ?? 0;
    if (n > 0) {
      parts.push(`${n} ${severity}`);
    }
  }
  return parts.join(', ');
}
