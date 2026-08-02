import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseSSEChunk } from './sse.ts';

test('a named event with a JSON payload parses', () => {
  const event = parseSSEChunk('event: finding\ndata: {"line":42,"title":"SQLi"}');
  assert.equal(event?.name, 'finding');
  assert.deepEqual(event?.data, { line: 42, title: 'SQLi' });
});

test('a payload split across data lines is rejoined', () => {
  const event = parseSSEChunk('event: done\ndata: {"summary":\ndata: "one issue"}');
  assert.deepEqual(event?.data, { summary: 'one issue' });
});

test('keep-alive comments and blank lines are ignored', () => {
  const event = parseSSEChunk(': keep-alive\nevent: finding\n\ndata: {"line":1}');
  assert.equal(event?.name, 'finding');
  assert.deepEqual(event?.data, { line: 1 });
});

test('a chunk with no data line yields nothing', () => {
  assert.equal(parseSSEChunk('event: finding'), null);
  assert.equal(parseSSEChunk(''), null);
  assert.equal(parseSSEChunk(': just a comment'), null);
});

test('an unparseable payload is surfaced as text rather than dropped', () => {
  const event = parseSSEChunk('event: error\ndata: upstream exploded');
  assert.equal(event?.name, 'error');
  assert.equal(event?.data, 'upstream exploded');
});

test('a missing event name defaults to message', () => {
  assert.equal(parseSSEChunk('data: {"x":1}')?.name, 'message');
});

test('CRLF line endings parse the same as LF', () => {
  const event = parseSSEChunk('event: finding\r\ndata: {"line":7}\r\n');
  assert.equal(event?.name, 'finding');
  assert.deepEqual(event?.data, { line: 7 });
});

test('only the single leading space after data: is stripped', () => {
  // Significant for a `fix` whose first line is indented.
  assert.equal(parseSSEChunk('data:   spaced')?.data, '  spaced');
});
