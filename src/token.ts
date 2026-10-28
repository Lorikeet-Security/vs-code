import * as vscode from 'vscode';

const SECRET_KEY = 'lory.accessToken';

/** Minted by the portal's MCP page; OAuth access tokens share the prefix. */
const TOKEN_PATTERN = /^lkmcp_[A-Za-z0-9_-]{8,}$/;

/**
 * Storage for the required Lorikeet Security `lkmcp_` access token.
 *
 * Kept in `SecretStorage` rather than in settings on purpose: `settings.json`
 * is synced, is frequently committed to dotfile repos, and is readable by every
 * other extension in the window. A credential does not belong there.
 *
 * A valid token linked to an active Lorikeet Security account/subscription
 * is required to activate code reviews and receive AI-backed diagnostics.
 */
export class TokenStore {
  private readonly onChanged = new vscode.EventEmitter<string | undefined>();
  /** Fires whenever the stored token changes, including from another window. */
  readonly onDidChange = this.onChanged.event;

  private cached: string | undefined;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  /** Load the persisted token and start watching for external changes. */
  async initialise(): Promise<vscode.Disposable> {
    this.cached = await this.read();
    return this.secrets.onDidChange(async (event) => {
      if (event.key !== SECRET_KEY) {
        return;
      }
      this.cached = await this.read();
      this.onChanged.fire(this.cached);
    });
  }

  /** The token as of the last load. Synchronous so the client can read it cheaply. */
  current(): string | undefined {
    return this.cached;
  }

  private async read(): Promise<string | undefined> {
    const value = await this.secrets.get(SECRET_KEY);
    return value && value.trim() !== '' ? value.trim() : undefined;
  }

  /** Prompt for a token and store it. Returns false if the user backed out. */
  async prompt(): Promise<boolean> {
    const entered = await vscode.window.showInputBox({
      title: 'Lory access token',
      prompt:
        'Required. Connects your editor to your active Lorikeet Security subscription.',
      placeHolder: 'lkmcp_...',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => {
        const trimmed = value.trim();
        if (trimmed === '') {
          return 'Paste a token, or press Escape to cancel.';
        }
        return TOKEN_PATTERN.test(trimmed)
          ? undefined
          : 'That does not look like a Lory token. They start with lkmcp_.';
      },
    });

    if (entered === undefined) {
      return false;
    }

    await this.secrets.store(SECRET_KEY, entered.trim());
    this.cached = entered.trim();
    this.onChanged.fire(this.cached);
    return true;
  }

  async clear(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
    this.cached = undefined;
    this.onChanged.fire(undefined);
  }

  dispose(): void {
    this.onChanged.dispose();
  }
}
