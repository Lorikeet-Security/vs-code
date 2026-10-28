import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { generatePKCE, generateRandomHex, renderAuthHtml } from './pkce.ts';

test('generatePKCE produces valid base64url verifier and challenge', () => {
  const pkce1 = generatePKCE();
  const pkce2 = generatePKCE();

  assert.ok(pkce1.verifier.length >= 43, 'Verifier length must be at least 43 characters');
  assert.ok(pkce1.challenge.length >= 43, 'Challenge length must be at least 43 characters');
  assert.notEqual(pkce1.verifier, pkce2.verifier, 'Subsequent verifiers must be unique');
  assert.notEqual(pkce1.challenge, pkce2.challenge, 'Subsequent challenges must be unique');

  // Must only contain base64url characters
  assert.match(pkce1.verifier, /^[A-Za-z0-9_-]+$/);
  assert.match(pkce1.challenge, /^[A-Za-z0-9_-]+$/);
});

test('generateRandomHex produces distinct hex strings', () => {
  const hex1 = generateRandomHex(16);
  const hex2 = generateRandomHex(16);

  assert.equal(hex1.length, 32);
  assert.equal(hex2.length, 32);
  assert.notEqual(hex1, hex2);
  assert.match(hex1, /^[0-9a-f]{32}$/);
});

test('renderAuthHtml returns branded html for success and failure', () => {
  const successHtml = renderAuthHtml(true, 'Login succeeded');
  assert.ok(successHtml.includes('Authentication Successful'));
  assert.ok(successHtml.includes('Login succeeded'));
  assert.ok(successHtml.includes('LORIKEET SECURITY'));

  const failureHtml = renderAuthHtml(false, 'Login failed: invalid state');
  assert.ok(failureHtml.includes('Authentication Failed'));
  assert.ok(failureHtml.includes('Login failed: invalid state'));
});
