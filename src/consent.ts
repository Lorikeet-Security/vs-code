import * as vscode from 'vscode';

const CONSENT_KEY = 'lory.codeSharingConsent';

/**
 * Explicit, revocable consent before any source leaves the machine.
 *
 * Reviewing code means uploading it. That is obvious to whoever installed the
 * extension and not at all obvious to the developer who inherits the settings,
 * so the first review always asks, and the answer is stored globally so it is
 * asked once per machine rather than once per workspace.
 */
export class ConsentGate {
  /** In-flight prompt, so ten queued reviews raise one dialog rather than ten. */
  private pending: Promise<boolean> | null = null;

  constructor(private readonly state: vscode.Memento) {}

  granted(): boolean {
    return this.state.get<boolean>(CONSENT_KEY) === true;
  }

  async reset(): Promise<void> {
    await this.state.update(CONSENT_KEY, undefined);
  }

  /**
   * Resolve to true when review may proceed.
   *
   * `silent` callers (the on-type trigger) never raise a dialog: interrupting
   * someone mid-keystroke with a modal is how an extension gets uninstalled.
   * The status bar advertises the pending decision instead, and the explicit
   * Scan command is what asks.
   */
  async ensure(silent: boolean): Promise<boolean> {
    if (this.granted()) {
      return true;
    }
    if (silent) {
      return false;
    }
    if (this.pending) {
      return this.pending;
    }

    this.pending = this.prompt().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async prompt(): Promise<boolean> {
    const allow = 'Review my code';
    const never = 'Not now';

    const choice = await vscode.window.showInformationMessage(
      'Lory reviews code by sending the file you are editing to Lorikeet Security for analysis.',
      {
        modal: true,
        detail:
          'Only the file being reviewed is sent, along with its name and language. ' +
          'Nothing is stored after the review and no other file, credential, or ' +
          'repository metadata is read.\n\n' +
          'Use lory.exclude to keep specific paths from ever being sent.',
      },
      allow,
      never
    );

    if (choice === allow) {
      await this.state.update(CONSENT_KEY, true);
      return true;
    }
    return false;
  }
}
