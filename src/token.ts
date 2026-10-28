import * as vscode from 'vscode';
import type { AccountInfo } from './types.ts';

const SECRET_KEY = 'lory.accessToken';
const ACCOUNT_KEY = 'lory.accountInfo';

/** Minted by the portal's MCP page; OAuth access tokens share the prefix. */
const TOKEN_PATTERN = /^lkmcp_[A-Za-z0-9_-]{8,}$/;

/**
 * Storage for the required Lorikeet Security `lkmcp_` access token and account metadata.
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

  private readonly onAccountChangedEmitter = new vscode.EventEmitter<AccountInfo | undefined>();
  readonly onDidChangeAccount = this.onAccountChangedEmitter.event;

  private cached: string | undefined;
  private cachedAccount: AccountInfo | undefined;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  /** Load the persisted token and start watching for external changes. */
  async initialise(): Promise<vscode.Disposable> {
    this.cached = await this.read();
    this.cachedAccount = await this.readAccount();
    return this.secrets.onDidChange(async (event) => {
      if (event.key === SECRET_KEY) {
        this.cached = await this.read();
        this.onChanged.fire(this.cached);
      } else if (event.key === ACCOUNT_KEY) {
        this.cachedAccount = await this.readAccount();
        this.onAccountChangedEmitter.fire(this.cachedAccount);
      }
    });
  }

  /** The token as of the last load. Synchronous so the client can read it cheaply. */
  current(): string | undefined {
    return this.cached;
  }

  getAccountInfo(): AccountInfo | undefined {
    return this.cachedAccount;
  }

  private async read(): Promise<string | undefined> {
    const value = await this.secrets.get(SECRET_KEY);
    return value && value.trim() !== '' ? value.trim() : undefined;
  }

  private async readAccount(): Promise<AccountInfo | undefined> {
    const raw = await this.secrets.get(ACCOUNT_KEY);
    if (!raw) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as AccountInfo;
    } catch {
      return undefined;
    }
  }

  /** Directly save a token programmatically (e.g. via SSO OAuth loopback flow). */
  async setToken(token: string, info?: AccountInfo): Promise<void> {
    const cleanToken = token.trim();
    await this.secrets.store(SECRET_KEY, cleanToken);
    this.cached = cleanToken;
    this.onChanged.fire(this.cached);

    if (info) {
      await this.setAccountInfo(info);
    }
  }

  async setAccountInfo(info: AccountInfo | undefined): Promise<void> {
    this.cachedAccount = info;
    if (info) {
      await this.secrets.store(ACCOUNT_KEY, JSON.stringify(info));
    } else {
      await this.secrets.delete(ACCOUNT_KEY);
    }
    this.onAccountChangedEmitter.fire(this.cachedAccount);
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

    await this.setToken(entered.trim(), {
      token: entered.trim(),
      authenticatedAt: new Date().toISOString(),
      tier: 'manual',
    });
    return true;
  }

  async clear(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
    await this.secrets.delete(ACCOUNT_KEY);
    this.cached = undefined;
    this.cachedAccount = undefined;
    this.onChanged.fire(undefined);
    this.onAccountChangedEmitter.fire(undefined);
  }

  dispose(): void {
    this.onChanged.dispose();
    this.onAccountChangedEmitter.dispose();
  }
}

