import * as crypto from 'node:crypto';

export const DEFAULT_SSO_PORT = 54321;
export const OAUTH_CLIENT_ID = 'nXAJUzhrz6lh6MoWskBKVg';
export const OAUTH_DEFAULT_SCOPE = 'findings:read kb:read compliance:read';
export const OAUTH_AUTH_PATH = '/talon/mcp/oauth/authorize';
export const OAUTH_TOKEN_PATH = '/talon/mcp/oauth/token';

export interface PKCEPair {
  verifier: string;
  challenge: string;
}

export function generatePKCE(): PKCEPair {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function generateRandomHex(bytes = 16): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Exchanges authorization code and PKCE verifier at the Talon OAuth token endpoint.
 */
export async function exchangeOAuthCode(
  baseUrl: string,
  code: string,
  redirectUri: string,
  verifier: string,
  logError?: (msg: string) => void
): Promise<{
  accessToken: string;
  userEmail?: string | undefined;
  companyName?: string | undefined;
  companyId?: string | undefined;
} | null> {
  const tokenUrl = `${baseUrl.replace(/\/+$/, '')}${OAUTH_TOKEN_PATH}`;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: OAUTH_CLIENT_ID,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });

  try {
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const errText = await res.text();
      logError?.(`Token exchange HTTP ${res.status}: ${errText}`);
      return null;
    }

    const data = (await res.json()) as Record<string, unknown>;
    const accessToken = typeof data.access_token === 'string' ? data.access_token : undefined;
    if (!accessToken) {
      logError?.('Token exchange did not return access_token in response.');
      return null;
    }

    return {
      accessToken,
      userEmail: typeof data.user_email === 'string' ? data.user_email : undefined,
      companyName: typeof data.company_name === 'string' ? data.company_name : undefined,
      companyId: typeof data.company_id === 'string' ? data.company_id : undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError?.(`Token exchange failed: ${msg}`);
    return null;
  }
}

/**
 * Renders an HTML page matching Lorikeet brand colors and styling.
 */
export function renderAuthHtml(success: boolean, message: string): string {
  const title = success ? 'Authentication Successful' : 'Authentication Failed';
  const color = success ? '#34d399' : '#f87171';
  const badgeColor = success ? '#ba5663' : '#ef4444';
  const badgeText = success ? 'Lorikeet Talon Connected' : 'Error';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} | Lorikeet Security</title>
  <style>
    :root {
      --bg: #0a1628;
      --card: #142b49;
      --border: #1a375d;
      --crimson: #ba5663;
      --crimson-glow: rgba(186, 86, 99, 0.4);
      --text: #f8fafc;
      --muted: #94a3b8;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 20px;
      box-sizing: border-box;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 40px 32px;
      max-width: 440px;
      width: 100%;
      text-align: center;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6);
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      background: rgba(10, 22, 40, 0.7);
      padding: 6px 16px;
      border-radius: 9999px;
      border: 1px solid var(--border);
      margin-bottom: 24px;
      font-size: 0.85rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      color: #fff;
    }
    h1 {
      font-size: 1.5rem;
      font-weight: 700;
      margin: 0 0 12px;
      color: ${color};
    }
    p {
      color: var(--muted);
      font-size: 0.95rem;
      line-height: 1.5;
      margin: 0 0 20px;
    }
    .badge {
      display: inline-block;
      padding: 8px 18px;
      background: ${badgeColor};
      color: #fff;
      border-radius: 9999px;
      font-size: 0.85rem;
      font-weight: 600;
      box-shadow: 0 4px 12px var(--crimson-glow);
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="brand">
      <svg width="20" height="22" viewBox="0 0 28 32" fill="none">
        <path d="M14 1.5L2 6.5V15C2 22.5 7.1 29.1 14 31C20.9 29.1 26 22.5 26 15V6.5L14 1.5Z" fill="#142b49" stroke="#1a375d" stroke-width="1.2"/>
        <path d="M14 1.5V31C20.9 29.1 26 22.5 26 15V6.5L14 1.5Z" fill="#ba5663" fill-opacity="0.3"/>
        <path d="M14 7.5C15.2 11.5 15.2 15.5 14 19.5" stroke="#ba5663" stroke-width="2" stroke-linecap="round"/>
      </svg>
      LORIKEET SECURITY
    </div>
    <h1>${title}</h1>
    <p>${message}</p>
    <div class="badge">${badgeText}</div>
  </div>
</body>
</html>`;
}
