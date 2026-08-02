import assert from 'node:assert/strict';
import { test } from 'node:test';

import { matchGlob, matchesAny } from './glob.ts';

test('**/ spans zero segments so a top-level match is not missed', () => {
  assert.ok(matchGlob('**/node_modules/**', 'node_modules/x/index.js'));
  assert.ok(matchGlob('**/node_modules/**', 'a/b/node_modules/x/index.js'));
  assert.ok(!matchGlob('**/node_modules/**', 'src/nodemodules/x.js'));
});

test('* does not cross a path separator', () => {
  assert.ok(matchGlob('src/*.ts', 'src/extension.ts'));
  assert.ok(!matchGlob('src/*.ts', 'src/nested/extension.ts'));
});

test('extension patterns match at any depth', () => {
  assert.ok(matchGlob('**/*.min.js', 'public/js/app.min.js'));
  assert.ok(matchGlob('**/*.min.js', 'app.min.js'));
  assert.ok(!matchGlob('**/*.min.js', 'app.js'));
});

test('dots are literal, not any-character', () => {
  assert.ok(!matchGlob('**/*.lock', 'yarn-lock'));
  assert.ok(matchGlob('**/*.lock', 'yarn.lock'));
});

test('? matches exactly one non-separator character', () => {
  assert.ok(matchGlob('file?.ts', 'file1.ts'));
  assert.ok(!matchGlob('file?.ts', 'file12.ts'));
  assert.ok(!matchGlob('file?.ts', 'file/.ts'));
});

test('windows separators are normalised before matching', () => {
  assert.ok(matchGlob('**/dist/**', 'C:\\repo\\dist\\out.js'));
});

test('matchesAny checks every pattern against every path form', () => {
  const patterns = ['**/vendor/**', '**/*.min.js'];
  assert.ok(matchesAny(patterns, 'src/app.ts', '/home/u/repo/vendor/lib.php'));
  assert.ok(!matchesAny(patterns, 'src/app.ts', '/home/u/repo/src/app.ts'));
});

test('regex metacharacters in a pattern stay literal', () => {
  assert.ok(matchGlob('**/a+b/**', 'x/a+b/c.ts'));
  assert.ok(!matchGlob('**/a+b/**', 'x/aab/c.ts'));
});
