import * as http from 'node:http';
import * as vscode from 'vscode';
import type { TokenStore } from './token.ts';
import type { AccountInfo } from './types.ts';
import {
  DEFAULT_SSO_PORT,
  OAUTH_CLIENT_ID,
  OAUTH_DEFAULT_SCOPE,
  OAUTH_AUTH_PATH,
  generatePKCE,
  generateRandomHex,
  renderAuthHtml,
  exchangeOAuthCode,
} from './pkce.ts';

export interface SSOLoginOptions {
  baseUrl: string;
  tokenStore: TokenStore;
  log?: vscode.LogOutputChannel;
  preferredPort?: number;
}

export interface SSOLoginResult {
  success: boolean;
  account?: AccountInfo;
  error?: string;
}

/**
 * Executes the seamless in-IDE OAuth loopback flow.
 *
 * 1. Spawns an ephemeral HTTP listener on 127.0.0.1 (default port 54321 with fallback).
 * 2. Opens the browser to Lorikeet Talon OAuth authorize endpoint with PKCE + state.
 * 3. Catches callback redirect, sends a branded success page to the browser.
 * 4. Exchanges the auth code for a scoped access token (`lkmcp_...`).
 * 5. Saves the token and account profile securely into SecretStorage.
 */
export async function loginSSO(options: SSOLoginOptions): Promise<SSOLoginResult> {
  const { baseUrl, tokenStore, log, preferredPort = DEFAULT_SSO_PORT } = options;

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Lory Security: Sign In via Talon SSO',
      cancellable: true,
    },
    async (progress, cancellationToken) => {
      progress.report({ message: 'Starting local OAuth callback listener...' });

      const state = generateRandomHex(16);
      const pkce = generatePKCE();

      return new Promise<SSOLoginResult>((resolve) => {
        let server: http.Server | null = null;
        let timeoutHandle: NodeJS.Timeout | null = null;
        let resolved = false;

        const cleanup = () => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
          }
          if (server) {
            try {
              server.close();
            } catch {
              // Ignore close error
            }
            server = null;
          }
        };

        const finish = (result: SSOLoginResult) => {
          if (!resolved) {
            resolved = true;
            cleanup();
            resolve(result);
          }
        };

        cancellationToken.onCancellationRequested(() => {
          log?.info('SSO login was cancelled by user.');
          finish({ success: false, error: 'Sign in cancelled by user.' });
        });

        // Set a 2-minute timeout for browser authentication
        timeoutHandle = setTimeout(() => {
          log?.warn('SSO login timed out after 120 seconds.');
          finish({ success: false, error: 'SSO login timed out. Please try again.' });
        }, 120_000);

        server = http.createServer(async (req, res) => {
          try {
            const reqUrl = new URL(req.url || '/', `http://127.0.0.1`);
            if (reqUrl.pathname !== '/callback') {
              res.writeHead(404, { 'Content-Type': 'text/plain' });
              res.end('Not Found');
              return;
            }

            const incomingState = reqUrl.searchParams.get('state');
            const code = reqUrl.searchParams.get('code');
            const token = reqUrl.searchParams.get('token') || reqUrl.searchParams.get('access_token');
            const ssoToken = reqUrl.searchParams.get('sso_token');
            const authError = reqUrl.searchParams.get('error_description') || reqUrl.searchParams.get('error');

            if (authError) {
              res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(renderAuthHtml(false, `Authentication failed: ${authError}`));
              finish({ success: false, error: authError });
              return;
            }

            if (incomingState !== state) {
              res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(renderAuthHtml(false, 'CSRF verification failed: state mismatch.'));
              finish({ success: false, error: 'State mismatch (possible CSRF attempt)' });
              return;
            }

            const rawAuth = code || token || ssoToken;
            if (!rawAuth) {
              res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(renderAuthHtml(false, 'Missing authorization code or token parameter.'));
              finish({ success: false, error: 'No authorization credentials returned from SSO' });
              return;
            }

            // Render success page to the browser
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderAuthHtml(true, 'Authentication successful! You can close this window and return to VS Code.'));

            progress.report({ message: 'Exchanging authorization code for access token...' });

            let accessToken = rawAuth;
            let userEmail: string | undefined;
            let companyName: string | undefined;
            let companyId: string | undefined;

            if (code) {
              // Exchange code for token
              const redirectUri = `http://127.0.0.1:${actualPort}/callback`;
              const exchangeResult = await exchangeOAuthCode(
                baseUrl,
                code,
                redirectUri,
                pkce.verifier,
                (msg) => log?.error(msg)
              );
              if (exchangeResult) {
                accessToken = exchangeResult.accessToken;
                userEmail = exchangeResult.userEmail;
                companyName = exchangeResult.companyName;
                companyId = exchangeResult.companyId;
              }
            }

            const account: AccountInfo = {
              userEmail: userEmail || 'authenticated-user@lorikeetsecurity.com',
              companyName: companyName || 'Lorikeet Security Organization',
              companyId,
              tier: 'subscription',
              token: accessToken,
              authenticatedAt: new Date().toISOString(),
            };

            await tokenStore.setToken(accessToken, account);
            log?.info(`SSO authentication successful for ${account.userEmail} (${account.companyName})`);
            finish({ success: true, account });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log?.error(`Error handling OAuth loopback: ${msg}`);
            try {
              res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(renderAuthHtml(false, `Internal error: ${msg}`));
            } catch {
              // Ignore write failure
            }
            finish({ success: false, error: msg });
          }
        });

        let actualPort = preferredPort;

        const startListener = (portToTry: number) => {
          server!.listen(portToTry, '127.0.0.1', () => {
            const addr = server!.address();
            if (typeof addr === 'object' && addr !== null) {
              actualPort = addr.port;
            }
            log?.info(`OAuth loopback server listening on http://127.0.0.1:${actualPort}/callback`);

            const redirectUri = `http://127.0.0.1:${actualPort}/callback`;
            const authUrl =
              `${baseUrl.replace(/\/+$/, '')}${OAUTH_AUTH_PATH}` +
              `?response_type=code` +
              `&client_id=${encodeURIComponent(OAUTH_CLIENT_ID)}` +
              `&redirect_uri=${encodeURIComponent(redirectUri)}` +
              `&state=${encodeURIComponent(state)}` +
              `&code_challenge=${encodeURIComponent(pkce.challenge)}` +
              `&code_challenge_method=S256` +
              `&scope=${encodeURIComponent(OAUTH_DEFAULT_SCOPE)}`;

            progress.report({ message: 'Opening browser to authorize with Lorikeet Security...' });
            void vscode.env.openExternal(vscode.Uri.parse(authUrl));
          });
        };

        server.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE' && actualPort === preferredPort) {
            log?.warn(`Port ${preferredPort} in use; falling back to dynamic ephemeral port.`);
            actualPort = 0;
            startListener(0);
          } else {
            const message = `Failed to start local OAuth loopback server: ${err.message}`;
            log?.error(message);
            finish({ success: false, error: message });
          }
        });

        startListener(preferredPort);
      });
    }
  );
}
