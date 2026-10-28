import { readSSE } from './sse.ts';
import { parseFinding, type Finding, type ReviewRequest, type ReviewResult } from './types.ts';

const REVIEW_PATH = '/ptaas/ajax/lory-code-review.php';

export type LoryErrorKind =
  | 'rate-limit'
  | 'auth'
  | 'transport'
  | 'protocol'
  | 'server'
  | 'cancelled';

/** A failure worth showing the user, separated from a bug worth logging. */
export class LoryError extends Error {
  // Declared and assigned rather than a constructor parameter property, so this
  // module stays loadable by `node --test --experimental-strip-types`.
  readonly kind: LoryErrorKind;

  constructor(message: string, kind: LoryErrorKind) {
    super(message);
    this.name = 'LoryError';
    this.kind = kind;
  }
}

export interface ClientOptions {
  baseUrl: string;
  timeoutMs: number;
  userAgent: string;
  /**
   * Required `lkmcp_` token.
   *
   * Connects the editor session to an active Lorikeet Security subscription
   * and verifies permissions.
   */
  token?: string | undefined;
}

/**
 * Talks to the Lory code review endpoint. Stateless: every review is one
 * request with no conversation history, so two reviews of the same bytes give
 * the same answer and the caller can cache on content alone.
 */
export class LoryClient {
  private options: ClientOptions;

  constructor(options: ClientOptions) {
    this.options = options;
  }

  update(options: Partial<ClientOptions>): void {
    this.options = { ...this.options, ...options };
  }

  get reviewUrl(): string {
    return this.options.baseUrl + REVIEW_PATH;
  }

  /**
   * Review one fragment.
   *
   * When `onFinding` is supplied the request streams and each finding is handed
   * over as it lands, so the first marker appears well before the review ends.
   */
  async review(
    request: ReviewRequest,
    signal: AbortSignal,
    onFinding?: (finding: Finding) => void
  ): Promise<ReviewResult> {
    if (!this.options.token || this.options.token.trim() === '') {
      throw new LoryError(
        'A valid Lorikeet Security access token is required. Run "Lory: Set Access Token" or subscribe at https://lorikeetsecurity.com/pricing.',
        'auth'
      );
    }

    const stream = request.stream !== false && onFinding !== undefined;

    // A caller-supplied signal cancels on the next keystroke; the timeout signal
    // cancels a server that never answers. Either aborts the same fetch.
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const combined = anySignal([signal, timeout]);

    let response: Response;
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: stream ? 'text/event-stream' : 'application/json',
        'User-Agent': this.options.userAgent,
      };
      if (this.options.token) {
        headers['Authorization'] = `Bearer ${this.options.token}`;
      }

      response = await fetch(this.reviewUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...request, stream }),
        signal: combined,
      });
    } catch (err) {
      if (signal.aborted) {
        throw new LoryError('Review cancelled.', 'cancelled');
      }
      if (timeout.aborted) {
        throw new LoryError(
          `Lory did not answer within ${Math.round(this.options.timeoutMs / 1000)}s.`,
          'transport'
        );
      }
      throw new LoryError(`Could not reach ${this.reviewUrl}: ${errorText(err)}`, 'transport');
    }

    if (response.status === 401) {
      throw new LoryError(
        'Your Lorikeet Security access token was rejected, expired, or your subscription is inactive. ' +
          'Run "Lory: Set Access Token" to update it, or visit https://lorikeetsecurity.com to manage your subscription.',
        'auth'
      );
    }
    if (response.status === 429) {
      const retry = response.headers.get('retry-after');
      const limit = response.headers.get('x-ratelimit-limit');
      throw new LoryError(
        `Lory rate limit exceeded${limit ? ` (${limit}/min)` : ''}.` +
          `${retry ? ` Retry in ${retry}s.` : ''} Check your usage at https://lorikeetsecurity.com.`,
        'rate-limit'
      );
    }
    if (response.status >= 500) {
      throw new LoryError(`Lory returned HTTP ${response.status}.`, 'server');
    }
    if (!response.ok) {
      throw new LoryError(`Lory returned HTTP ${response.status}.`, 'protocol');
    }

    const contentType = response.headers.get('content-type') ?? '';

    // The endpoint falls back to a JSON error body when it rejects a streaming
    // request, so content-type decides how to read it, not what we asked for.
    if (stream && contentType.includes('text/event-stream')) {
      return this.readStream(response, onFinding!, signal);
    }
    return this.readJson(response);
  }

  private async readJson(response: Response): Promise<ReviewResult> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new LoryError('Lory returned a body that is not JSON.', 'protocol');
    }

    if (typeof body !== 'object' || body === null) {
      throw new LoryError('Lory returned an unexpected body.', 'protocol');
    }
    const data = body as Record<string, unknown>;

    if (data['success'] === false) {
      throw new LoryError(String(data['error'] ?? 'Lory rejected the request.'), 'server');
    }
    if (!Array.isArray(data['findings'])) {
      throw new LoryError('Lory returned no findings array.', 'protocol');
    }

    return {
      findings: data['findings'].map(parseFinding).filter((f): f is Finding => f !== null),
      summary: typeof data['summary'] === 'string' ? data['summary'] : '',
      ...(isMeta(data['meta']) ? { meta: data['meta'] } : {}),
    };
  }

  private async readStream(
    response: Response,
    onFinding: (finding: Finding) => void,
    signal: AbortSignal
  ): Promise<ReviewResult> {
    if (!response.body) {
      throw new LoryError('Lory returned an empty stream.', 'protocol');
    }

    const findings: Finding[] = [];
    let summary = '';
    let meta: ReviewResult['meta'];
    let streamError: string | null = null;

    for await (const event of readSSE(response.body, signal)) {
      if (event.name === 'finding') {
        const finding = parseFinding(event.data);
        if (finding) {
          findings.push(finding);
          onFinding(finding);
        }
      } else if (event.name === 'done') {
        const data = (event.data ?? {}) as Record<string, unknown>;
        summary = typeof data['summary'] === 'string' ? data['summary'] : '';
        if (isMeta(data['meta'])) {
          meta = data['meta'];
        }
      } else if (event.name === 'error') {
        const data = (event.data ?? {}) as Record<string, unknown>;
        streamError = String(data['error'] ?? 'Lory reported an error.');
      }
    }

    // readSSE stops quietly when the signal trips, so the distinction between
    // "cancelled" and "the review ended" is drawn here.
    if (signal.aborted) {
      throw new LoryError('Review cancelled.', 'cancelled');
    }

    // A mid-stream error invalidates the whole review: the findings received so
    // far are a prefix, and showing a prefix as if it were complete tells the
    // developer their file is clean past the point the stream broke.
    if (streamError) {
      throw new LoryError(streamError, 'server');
    }

    return { findings, summary, ...(meta ? { meta } : {}) };
  }
}

function isMeta(value: unknown): value is ReviewResult['meta'] & object {
  return typeof value === 'object' && value !== null;
}

/**
 * Combine abort signals.
 *
 * `AbortSignal.any` landed in Node 20 and the extension targets Node 18, so
 * this is the portable equivalent.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();

  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', abort, { once: true });
  }

  return controller.signal;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
