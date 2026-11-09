import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = new URL('../lib/postgres-readiness.mjs', import.meta.url);
const readiness = await import(source.href).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === source.href) return {};
  throw error;
});

function ready(run) {
  assert.equal(typeof readiness.isPostgresTcpReady, 'function', 'missing explicit TCP readiness check');
  return readiness.isPostgresTcpReady(run, 'synthetic-test-container', 'mellon_intake_test');
}

test('does not mistake the Unix-only initialization server for a TCP-ready database', () => {
  let tcpReady = false;
  const run = args => {
    assert.equal(args[0], 'exec');
    assert.equal(args[1], 'synthetic-test-container');
    assert.equal(args[2], 'pg_isready');
    assert.equal(args[args.indexOf('--dbname') + 1], 'mellon_intake_test');
    const hostIndex = args.indexOf('--host');
    // The temporary init server can accept socket connections while TCP is unavailable.
    if (hostIndex < 0) return { status: 0 };
    assert.equal(args[hostIndex + 1], '127.0.0.1');
    return { status: tcpReady ? 0 : 2 };
  };
  assert.equal(ready(run), false);
  tcpReady = true;
  assert.equal(ready(run), true);
});

test('a failed or timed-out readiness command does not authorize database setup', () => {
  for (const status of [1, 2, 3, null]) assert.equal(ready(() => ({ status })), false);
});

test('database runner registers only explicit worker and runtime integration files', async () => {
  const runner = await readFile(new URL('../test-agent-intake-db.mjs', import.meta.url), 'utf8');
  assert.match(runner, /\['intake', 'worker', 'journal', 'coordinator', 'runtime', 'review-requests'\]\.includes\(process\.argv\[3\]\)/);
  assert.match(runner, /intake: 'tests\/integration\/agent-intake-store\.test\.mjs'/);
  assert.match(runner, /worker: 'tests\/integration\/agent-worker-store\.test\.mjs'/);
  assert.match(runner, /journal: 'tests\/integration\/agent-worker-journal\.test\.mjs'/);
  assert.match(runner, /coordinator: 'tests\/integration\/agent-worker-coordinator\.test\.mjs'/);
  assert.match(runner, /runtime: 'tests\/support\/agent-worker-runtime-postgres\.mjs'/);
  assert.match(runner, /'review-requests': 'tests\/manual\/agent-worker-review-request-journal\.mjs'/);
  assert.match(runner, /suiteFiles\[suite\]/);
  assert.match(runner, /timeout: 120000/);
  assert.match(runner, /postgres@sha256:3540c0362c809df084ffac0ae69fe794515f9de92692f02178bcdce0ef0302ac/);
});

test('runtime database suite is accepted but never invokes a caller-supplied command', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mellon-db-command-'));
  writeFileSync(join(directory, 'docker'), '#!/bin/sh\nexit 1\n', { flag: 'wx', mode: 0o700 });
  const result = spawnSync(process.execPath, ['scripts/test-agent-intake-db.mjs', '--suite', 'runtime'], {
    encoding: 'utf8', timeout: 10000, env: { PATH: directory },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Disposable Postgres container setup failed; private details withheld.\n');
});

test('database runner refuses caller paths and arbitrary commands before Docker', () => {
  for (const args of [
    ['--suite', 'tests/integration/agent-worker-journal.test.mjs'],
    ['--suite', 'journal;echo forbidden'], ['--suite', 'journal', '--command', 'echo'],
    ['--suite', 'coordinator;echo forbidden'], ['--suite', 'coordinator', '--command', 'echo'],
    ['--suite', 'tests/integration/agent-worker-coordinator.test.mjs'],
    ['--suite', 'runtime;echo forbidden'], ['--suite', 'runtime', '--command', 'echo'],
    ['--suite', 'tests/support/agent-worker-runtime-postgres.mjs'],
    ['--suite', 'review-requests;echo forbidden'], ['--suite', 'review-requests', '--command', 'echo'],
    ['--suite', 'tests/manual/agent-worker-review-request-journal.mjs'],
  ]) {
    const result = spawnSync(process.execPath, ['scripts/test-agent-intake-db.mjs', ...args], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, AGENT_INTAKE_TEST_DATABASE_URL: 'private-url-probe',
        AGENT_INTAKE_TEST_RUN_ID: 'private-marker-probe' },
    });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Usage: node scripts/test-agent-intake-db.mjs [--suite intake|worker|journal|coordinator|runtime|review-requests]\n');
  }
});
