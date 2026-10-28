import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseLoryIgnore, parseLorikeetJson } from './policy.ts';
import { matchesAny } from './glob.ts';

test('parseLoryIgnore strips comments and empty lines', () => {
  const content = `
# Comment at top

node_modules/
# Another comment
*.tmp
/secrets.env
custom/pattern/**
`;
  const patterns = parseLoryIgnore(content);
  assert.deepEqual(patterns, [
    '**/node_modules/**',
    '**/*.tmp',
    'secrets.env',
    'custom/pattern/**',
  ]);
});

test('parseLoryIgnore patterns match target paths using matchesAny', () => {
  const content = `
coverage/
*.min.js
/config/local.json
`;
  const patterns = parseLoryIgnore(content);

  assert.ok(matchesAny(patterns, 'coverage/lcov.info', '/project/coverage/lcov.info'));
  assert.ok(matchesAny(patterns, 'src/bundle.min.js', '/project/src/bundle.min.js'));
  assert.ok(matchesAny(patterns, 'config/local.json', '/project/config/local.json'));
  assert.ok(!matchesAny(patterns, 'src/app.ts', '/project/src/app.ts'));
});

test('parseLorikeetJson extracts configuration values', () => {
  const jsonContent = JSON.stringify({
    exclude: ['dist/**', 'tests/fixtures/**'],
    languages: ['typescript', 'python', 'go'],
    minimumSeverity: 'high',
    minimumConfidence: 'medium',
  });

  const parsed = parseLorikeetJson(jsonContent);
  assert.deepEqual(parsed.exclude, ['dist/**', 'tests/fixtures/**']);
  assert.deepEqual(parsed.languages, ['typescript', 'python', 'go']);
  assert.equal(parsed.minimumSeverity, 'high');
  assert.equal(parsed.minimumConfidence, 'medium');
});

test('parseLorikeetJson rejects invalid values gracefully', () => {
  const invalidJson = `{
    "minimumSeverity": "unknown_sev",
    "minimumConfidence": 123,
    "exclude": "not-an-array"
  }`;

  const parsed = parseLorikeetJson(invalidJson);
  assert.equal(parsed.minimumSeverity, undefined);
  assert.equal(parsed.minimumConfidence, undefined);
  assert.equal(parsed.exclude, undefined);
});
