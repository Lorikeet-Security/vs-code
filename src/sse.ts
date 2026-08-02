/**
 * Server-sent events parsing for the streaming review response.
 *
 * Kept apart from the HTTP client so the wire format can be tested without a
 * server, and so the client stays about transport and error mapping.
 */

export interface SSEEvent {
  name: string;
  data: unknown;
}

/**
 * Yield events from an SSE byte stream.
 *
 * Stops cleanly when `signal` aborts rather than throwing; the caller owns the
 * decision about whether an early stop is a cancellation or a truncated review.
 */
export async function* readSSE(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      // Events are separated by a blank line. Whatever follows the last
      // separator is a partial event and stays buffered until the rest lands.
      let split: number;
      while ((split = indexOfSeparator(buffer)) !== -1) {
        const chunk = buffer.slice(0, split);
        buffer = buffer.slice(split).replace(/^(?:\r?\n){2}/, '');
        const event = parseSSEChunk(chunk);
        if (event) {
          yield event;
        }
      }
    }

    // A stream that ends without a trailing blank line still has one event in it.
    if (!signal.aborted) {
      const trailing = parseSSEChunk(buffer);
      if (trailing) {
        yield trailing;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Index of the next event separator, or -1. Handles both LF and CRLF streams. */
export function indexOfSeparator(buffer: string): number {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1) {
    return crlf;
  }
  if (crlf === -1) {
    return lf;
  }
  return Math.min(lf, crlf);
}

/**
 * Parse one `event:`/`data:` block.
 *
 * Returns null for a block with no `data:` line, which is what a keep-alive
 * comment or a stray separator produces.
 */
export function parseSSEChunk(chunk: string): SSEEvent | null {
  let name = 'message';
  const dataLines: string[] = [];

  for (const rawLine of chunk.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line === '' || line.startsWith(':')) {
      continue; // blank line or keep-alive comment
    }
    if (line.startsWith('event:')) {
      name = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      // Exactly one optional leading space is part of the framing; any further
      // spaces are payload, which matters for a `fix` whose first line indents.
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  const payload = dataLines.join('\n');
  try {
    return { name, data: JSON.parse(payload) };
  } catch {
    // The `error` event is sometimes a bare string. Surfacing it as text beats
    // dropping the one event that explains why the review failed.
    return { name, data: payload };
  }
}
