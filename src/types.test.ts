import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseFinding } from './types.ts';

test('a well-formed finding round-trips', () => {
  const finding = parseFinding({
    line: 42,
    end_line: 44,
    severity: 'high',
    title: 'SQL injection via user parameter',
    detail: 'req.query.user is concatenated into the statement.',
    confidence: 'high',
    cwe: 'CWE-89',
    fix: 'db.query(sql, [user])',
    fix_note: 'Parameterised.',
  });

  assert.equal(finding?.line, 42);
  assert.equal(finding?.end_line, 44);
  assert.equal(finding?.severity, 'high');
  assert.equal(finding?.cwe, 'CWE-89');
});

test('a finding without a usable line is rejected', () => {
  assert.equal(parseFinding({ line: 0, title: 'x' }), null);
  assert.equal(parseFinding({ line: -3, title: 'x' }), null);
  assert.equal(parseFinding({ line: 1.5, title: 'x' }), null);
  assert.equal(parseFinding({ title: 'x' }), null);
  assert.equal(parseFinding({ line: 'twelve', title: 'x' }), null);
});

test('a finding without a title is rejected', () => {
  assert.equal(parseFinding({ line: 5 }), null);
  assert.equal(parseFinding({ line: 5, title: '   ' }), null);
});

test('non-objects are rejected rather than thrown on', () => {
  assert.equal(parseFinding(null), null);
  assert.equal(parseFinding(undefined), null);
  assert.equal(parseFinding('a finding'), null);
  assert.equal(parseFinding(42), null);
});

test('unknown severity and confidence fall back to medium', () => {
  const finding = parseFinding({
    line: 1,
    title: 'x',
    severity: 'catastrophic',
    confidence: 'certain',
  });
  assert.equal(finding?.severity, 'medium');
  assert.equal(finding?.confidence, 'medium');
});

test('a malformed cwe is dropped rather than rendered as a link', () => {
  assert.equal(parseFinding({ line: 1, title: 'x', cwe: 'javascript:alert(1)' })?.cwe, undefined);
  assert.equal(parseFinding({ line: 1, title: 'x', cwe: 'CWE-' })?.cwe, undefined);
  assert.equal(parseFinding({ line: 1, title: 'x', cwe: 'cwe-79' })?.cwe, 'CWE-79');
});

test('end_line is ignored unless it is after line', () => {
  assert.equal(parseFinding({ line: 10, title: 'x', end_line: 4 })?.end_line, undefined);
  assert.equal(parseFinding({ line: 10, title: 'x', end_line: 10 })?.end_line, undefined);
  assert.equal(parseFinding({ line: 10, title: 'x', end_line: 12 })?.end_line, 12);
});

test('empty optional strings are omitted, not stored blank', () => {
  const finding = parseFinding({ line: 1, title: 'x', fix: '', fix_note: '  ' });
  assert.equal(finding?.fix, undefined);
  assert.equal(finding?.fix_note, undefined);
});
