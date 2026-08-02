import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, test } from 'node:test';

import { LoryClient, LoryError } from './client.ts';
import type { Finding } from './types.ts';

type Handler = (body: string) => {
  status?: number;
  headers?: Record<string, string>;
  body: string;
};

let handler: Handler = () => ({ body: '{}' });
let lastRequest = { body: '', accept: '', userAgent: '', authorization: '' };

const server: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    lastRequest = {
      body: Buffer.concat(chunks).toString(),
      accept: req.headers.accept ?? '',
      userAgent: req.headers['user-agent'] ?? '',
      authorization: req.headers.authorization ?? '',
    };
    const result = handler(lastRequest.body);
    res.writeHead(result.status ?? 200, {
      'Content-Type': 'application/json',
      ...result.headers,
    });
    res.end(result.body);
  });
});

const listening = new Promise<number>((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    resolve((server.address() as { port: number }).port);
  });
});

after(() => server.close());

async function client(): Promise<LoryClient> {
  const port = await listening;
  return new LoryClient({
    baseUrl: `http://127.0.0.1:${port}`,
    timeoutMs: 5000,
    userAgent: 'lory-vscode/test',
  });
}

const NEVER_ABORTS = new AbortController().signal;

test('the request carries the documented fields', async () => {
  handler = () => ({ body: JSON.stringify({ success: true, findings: [], summary: 'clean' }) });

  const c = await client();
  await c.review(
    { code: 'x = 1', language: 'python', filename: 'a.py', start_line: 10, stream: false },
    NEVER_ABORTS
  );

  const sent = JSON.parse(lastRequest.body);
  assert.equal(sent.code, 'x = 1');
  assert.equal(sent.language, 'python');
  assert.equal(sent.filename, 'a.py');
  assert.equal(sent.start_line, 10);
  assert.equal(sent.stream, false, 'no onFinding callback means no streaming');
  assert.equal(lastRequest.userAgent, 'lory-vscode/test');
});

test('the review url is built from the base url', async () => {
  const c = await client();
  assert.ok(c.reviewUrl.endsWith('/ptaas/ajax/lory-code-review.php'));
});

test('a non-streaming reply is parsed and malformed findings are dropped', async () => {
  handler = () => ({
    body: JSON.stringify({
      success: true,
      summary: 'one issue',
      findings: [
        {
          line: 42,
          severity: 'high',
          title: 'SQL injection',
          detail: 'concatenated',
          confidence: 'high',
          cwe: 'CWE-89',
        },
        { line: 0, title: 'bogus line' },
        { line: 7 },
        'not an object',
      ],
    }),
  });

  const c = await client();
  const result = await c.review({ code: 'q' }, NEVER_ABORTS);

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.line, 42);
  assert.equal(result.findings[0]?.cwe, 'CWE-89');
  assert.equal(result.summary, 'one issue');
});

test('a streaming reply delivers findings as they arrive', async () => {
  handler = () => ({
    headers: { 'Content-Type': 'text/event-stream' },
    body:
      'event: finding\ndata: {"line":3,"severity":"critical","title":"Hardcoded key","detail":"d","confidence":"high"}\n\n' +
      'event: finding\ndata: {"line":9,"severity":"low","title":"Weak hash","detail":"d","confidence":"medium"}\n\n' +
      'event: done\ndata: {"summary":"two issues","count":2}\n\n',
  });

  const streamed: Finding[] = [];
  const c = await client();
  const result = await c.review({ code: 'q' }, NEVER_ABORTS, (f) => streamed.push(f));

  assert.equal(lastRequest.accept, 'text/event-stream');
  assert.deepEqual(
    streamed.map((f) => f.line),
    [3, 9],
    'each finding is handed over before the review ends'
  );
  assert.equal(result.findings.length, 2);
  assert.equal(result.summary, 'two issues');
});

test('an error event fails the review rather than returning a partial prefix', async () => {
  handler = () => ({
    headers: { 'Content-Type': 'text/event-stream' },
    body:
      'event: finding\ndata: {"line":3,"severity":"high","title":"One","detail":"d","confidence":"high"}\n\n' +
      'event: error\ndata: {"error":"AI service temporarily unavailable. Please try again."}\n\n',
  });

  const c = await client();
  await assert.rejects(
    () => c.review({ code: 'q' }, NEVER_ABORTS, () => undefined),
    (err: LoryError) => {
      assert.equal(err.kind, 'server');
      assert.match(err.message, /temporarily unavailable/);
      return true;
    }
  );
});

test('a streaming request that the server answers as JSON still parses', async () => {
  // The endpoint falls back to a JSON error body when it rejects the request
  // before switching to SSE.
  handler = () => ({ body: JSON.stringify({ success: false, error: 'No code provided' }) });

  const c = await client();
  await assert.rejects(
    () => c.review({ code: 'q' }, NEVER_ABORTS, () => undefined),
    (err: LoryError) => {
      assert.equal(err.kind, 'server');
      assert.equal(err.message, 'No code provided');
      return true;
    }
  );
});

test('HTTP 429 is reported as rate limiting with the retry hint', async () => {
  handler = () => ({
    status: 429,
    headers: { 'Retry-After': '60' },
    body: JSON.stringify({ success: false, error: 'Rate limit exceeded.' }),
  });

  const c = await client();
  await assert.rejects(
    () => c.review({ code: 'q' }, NEVER_ABORTS),
    (err: LoryError) => {
      assert.equal(err.kind, 'rate-limit');
      assert.match(err.message, /60s/);
      return true;
    }
  );
});

test('a 5xx is a server error, not a protocol error', async () => {
  handler = () => ({ status: 503, body: 'gateway down' });
  const c = await client();
  await assert.rejects(
    () => c.review({ code: 'q' }, NEVER_ABORTS),
    (err: LoryError) => err.kind === 'server'
  );
});

test('a non-JSON 200 body is a protocol error', async () => {
  handler = () => ({ body: '<html>login</html>' });
  const c = await client();
  await assert.rejects(
    () => c.review({ code: 'q' }, NEVER_ABORTS),
    (err: LoryError) => err.kind === 'protocol'
  );
});

test('a 200 with no findings array is a protocol error, not a clean file', async () => {
  handler = () => ({ body: JSON.stringify({ success: true, summary: 'ok' }) });
  const c = await client();
  await assert.rejects(
    () => c.review({ code: 'q' }, NEVER_ABORTS),
    (err: LoryError) => err.kind === 'protocol'
  );
});

test('an already-aborted signal cancels rather than reporting a transport failure', async () => {
  handler = () => ({ body: JSON.stringify({ success: true, findings: [] }) });
  const controller = new AbortController();
  controller.abort();

  const c = await client();
  await assert.rejects(
    () => c.review({ code: 'q' }, controller.signal),
    (err: LoryError) => err.kind === 'cancelled'
  );
});

test('no Authorization header is sent when there is no token', async () => {
  handler = () => ({ body: JSON.stringify({ success: true, findings: [] }) });
  const c = await client();
  await c.review({ code: 'q' }, NEVER_ABORTS);
  assert.equal(lastRequest.authorization, '', 'anonymous requests must stay anonymous');
});

test('a token is sent as a bearer credential', async () => {
  handler = () => ({ body: JSON.stringify({ success: true, findings: [] }) });
  const port = await listening;
  const c = new LoryClient({
    baseUrl: `http://127.0.0.1:${port}`,
    timeoutMs: 5000,
    userAgent: 'lory-vscode/test',
    token: 'lkmcp_abcdefgh12345678',
  });

  await c.review({ code: 'q' }, NEVER_ABORTS);
  assert.equal(lastRequest.authorization, 'Bearer lkmcp_abcdefgh12345678');
});

test('update() swaps the token without rebuilding the client', async () => {
  handler = () => ({ body: JSON.stringify({ success: true, findings: [] }) });
  const c = await client();

  c.update({ token: 'lkmcp_rotated00000000' });
  await c.review({ code: 'q' }, NEVER_ABORTS);
  assert.equal(lastRequest.authorization, 'Bearer lkmcp_rotated00000000');

  c.update({ token: undefined });
  await c.review({ code: 'q' }, NEVER_ABORTS);
  assert.equal(lastRequest.authorization, '', 'clearing the token drops the header');
});

test('HTTP 401 is an auth error pointing at the token command', async () => {
  handler = () => ({
    status: 401,
    body: JSON.stringify({ success: false, error: 'Token is invalid, expired, or revoked.' }),
  });

  const c = await client();
  await assert.rejects(
    () => c.review({ code: 'q' }, NEVER_ABORTS),
    (err: LoryError) => {
      assert.equal(err.kind, 'auth');
      assert.match(err.message, /Set Access Token/);
      return true;
    }
  );
});

test('a 429 without a token suggests one; with a token it does not', async () => {
  handler = () => ({
    status: 429,
    headers: { 'Retry-After': '30', 'X-RateLimit-Limit': '30' },
    body: JSON.stringify({ success: false, error: 'Rate limit exceeded.' }),
  });

  const anon = await client();
  await assert.rejects(
    () => anon.review({ code: 'q' }, NEVER_ABORTS),
    (err: LoryError) => {
      assert.match(err.message, /30\/min/);
      assert.match(err.message, /token raises the ceiling/);
      return true;
    }
  );

  const port = await listening;
  const withToken = new LoryClient({
    baseUrl: `http://127.0.0.1:${port}`,
    timeoutMs: 5000,
    userAgent: 'lory-vscode/test',
    token: 'lkmcp_abcdefgh12345678',
  });
  await assert.rejects(
    () => withToken.review({ code: 'q' }, NEVER_ABORTS),
    (err: LoryError) => {
      assert.doesNotMatch(err.message, /token raises the ceiling/);
      return true;
    }
  );
});

test('the tier is carried back through meta', async () => {
  handler = () => ({
    body: JSON.stringify({
      success: true,
      findings: [],
      summary: '',
      meta: { start_line: 1, end_line: 5, model: 'claude-haiku-4-5', tier: 'token' },
    }),
  });

  const c = await client();
  const result = await c.review({ code: 'q' }, NEVER_ABORTS);
  assert.equal(result.meta?.tier, 'token');
});

test('an unreachable host is a transport error', async () => {
  const c = new LoryClient({
    // Port 1 on loopback refuses immediately.
    baseUrl: 'http://127.0.0.1:1',
    timeoutMs: 5000,
    userAgent: 'lory-vscode/test',
  });
  await assert.rejects(
    () => c.review({ code: 'q' }, NEVER_ABORTS),
    (err: LoryError) => err.kind === 'transport'
  );
});
