import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const retiredPaths = [
  'src/automation', 'migrations', 'automation', 'neon.ts',
  'scripts/test-agent-intake-db.mjs', 'scripts/lib/postgres-readiness.mjs',
  'scripts/lib/output-guard.mjs', 'docs/agent-issue-worker.md',
  'docs/agent-webhook-intake.md',
];

function packageMetadata() {
  return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
}

test('repository has no issue intake, coding worker, queue or deployment entry points', () => {
  for (const relative of retiredPaths) {
    assert.equal(existsSync(path.join(root, relative)), false, `${relative} must be removed`);
  }
  for (const directory of ['docs', 'tests/unit', 'tests/integration', 'tests/fixtures', 'scripts/tests']) {
    const absolute = path.join(root, directory);
    const names = existsSync(absolute) ? readdirSync(absolute) : [];
    assert.deepEqual(names.filter(name => /^(?:agent-(?:worker|intake)|worker-)/.test(name)), [],
      `${directory} must not retain agent-specific files`);
  }
});

test('package scripts use the remaining serial test suites without agent database lanes', () => {
  const metadata = packageMetadata();
  assert.equal(metadata.scripts.test,
    'node --test --test-concurrency=1 detector/tests/*.test.mjs tests/unit/*.test.mjs tests/integration/*.test.mjs scripts/tests/*.test.mjs');
  assert.equal(metadata.scripts['test:unit'],
    'node --test --test-concurrency=1 tests/unit/*.test.mjs tests/integration/*.test.mjs');
  assert.deepEqual(Object.keys(metadata.scripts).filter(name => /^test:(?:worker|intake):/.test(name)), []);
  assert.doesNotMatch(JSON.stringify(metadata.scripts), /automation\/|test-agent-intake/);
});

test('manifest and generated lockfile contain no agent execution or database dependencies', () => {
  const metadata = packageMetadata();
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const retired = ['@neon/ai-sdk-provider', '@neon/functions', '@neon/config', 'ai', 'acorn', 'pg', 'zod'];
  for (const name of retired) {
    assert.equal(Object.hasOwn(metadata.dependencies ?? {}, name), false, name);
    assert.equal(Object.hasOwn(metadata.devDependencies ?? {}, name), false, name);
    assert.equal(Object.hasOwn(lock.packages, `node_modules/${name}`), false, name);
  }
});

test('project instructions retain the comment prohibition without retired worker authority', () => {
  const text = readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(text, /Coding assistants never post PR comments/);
  assert.doesNotMatch(text, /src\/automation|worker-command|agentic_review|\bintake\b/i);
});

test('README supports moderation and personalized detection without agent setup links', () => {
  const text = readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.doesNotMatch(text, /docs\/agent-|test:worker:|test:intake:|agent: ready|issueworkertick/);
  assert.match(text, /docs\/personalized-detection\.md/);
  assert.match(text, /docs\/moderation\.md/);
});
