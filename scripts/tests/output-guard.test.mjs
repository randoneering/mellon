import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  decodeOutput,
  runGuardedProcess,
  safeChildEnvironment,
} from '../lib/output-guard.mjs';
import { commandFor } from '../../automation/ci/guard-command.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const GUARD = path.join(ROOT, 'automation/ci/guard-command.mjs');
const FIXTURE_ROOT = 'scripts/tests/fixtures/agent-worker-ci';
const SAFE_COMMAND_PATTERN = /::|##\[/;

function cleanEnvironment() {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  return environment;
}

async function runFixture(mode, options = {}) {
  const fixture = path.join(ROOT, FIXTURE_ROOT, 'output-guard-probe.mjs');
  const result = await runGuardedProcess({
    executable: process.execPath,
    args: [fixture, mode],
    cwd: ROOT,
    timeoutMs: options.timeoutMs ?? 5_000,
    env: options.env ?? cleanEnvironment(),
  });
  if (result.failure) return { ...result, output: '', errorOutput: '' };
  try {
    return {
      ...result,
      output: decodeOutput(result.stdout),
      errorOutput: decodeOutput(result.stderr),
    };
  } catch (error) {
    return { ...result, decodeError: error, output: '', errorOutput: '' };
  }
}

test('child environments strip workflow file handles and startup injection variables', () => {
  const childEnvironment = safeChildEnvironment({
    GITHUB_ENV: '/tmp/github_env',
    GITHUB_OUTPUT: '/tmp/github_output',
    GITHUB_PATH: '/tmp/github_path',
    GITHUB_STEP_SUMMARY: '/tmp/summary',
    GITHUB_STATE: '/tmp/state',
    BASH_ENV: '/tmp/bashrc',
    ENV: '/tmp/envrc',
    NODE_OPTIONS: '--require=/tmp/preload.cjs',
    GITHUB_REPOSITORY: 'randoneering/mellon',
    GITHUB_SHA: 'a'.repeat(40),
    PATH: '/usr/bin',
  });
  for (const key of [
    'GITHUB_ENV', 'GITHUB_OUTPUT', 'GITHUB_PATH', 'GITHUB_STEP_SUMMARY',
    'GITHUB_STATE', 'BASH_ENV', 'ENV', 'NODE_OPTIONS',
  ]) assert.equal(childEnvironment[key], undefined, `${key} must not reach child code`);
  assert.equal(childEnvironment.GITHUB_REPOSITORY, 'randoneering/mellon');
  assert.equal(childEnvironment.PATH, '/usr/bin');
});

test('child Bash cannot read workflow command files or run an inherited startup hook', {
  skip: process.platform === 'win32',
}, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'mellon-output-guard-'));
  const startupMarker = path.join(directory, 'startup-ran');
  const startupFile = path.join(directory, 'bash-env');
  writeFileSync(startupFile, `touch '${startupMarker}'\\n`);
  try {
    const result = await runGuardedProcess({
      executable: '/bin/bash',
      args: ['-c', "printf '%s' \"${GITHUB_ENV-unset}\""],
      cwd: ROOT,
      timeoutMs: 5_000,
      env: {
        ...cleanEnvironment(),
        BASH_ENV: startupFile,
        GITHUB_ENV: path.join(directory, 'github-env'),
      },
    });
    assert.equal(result.status, 0);
    assert.equal(decodeOutput(result.stdout), 'unset');
    assert.equal(existsSync(startupMarker), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('native test output is neutralized before it reaches the workflow log', async () => {
  const result = await runGuardedProcess({
    executable: process.execPath,
    args: ['--test', '--test-concurrency=1', `${FIXTURE_ROOT}/stdout.test.mjs`],
    cwd: ROOT,
    timeoutMs: 5_000,
    env: cleanEnvironment(),
  });
  assert.equal(result.status, 0);
  const output = `${decodeOutput(result.stdout)}\n${decodeOutput(result.stderr)}`;
  assert.doesNotMatch(output, SAFE_COMMAND_PATTERN);
  assert.match(output, /\\:\\:error/);
});

test('fixed CI command tuples preserve commands and repository working directories', () => {
  const expected = [
    ['install-root', 'npm', ['ci', '--ignore-scripts'], ROOT],
    ['install-detector', 'npm', ['ci', '--ignore-scripts'], path.join(ROOT, 'detector')],
    ['verify-assets', 'npm', ['run', 'verify:assets'], ROOT],
    ['test-build', 'npm', ['run', 'test:build'], ROOT],
    ['test-parity', 'npm', ['run', 'test:parity'], ROOT],
    ['build', 'npm', ['run', 'build'], ROOT],
    ['validate-release', process.execPath, ['scripts/validate-release.mjs'], ROOT],
  ];
  for (const [name, executable, args, cwd] of expected) {
    const selected = commandFor(name);
    assert.equal(selected.executable, executable, name);
    assert.deepEqual(selected.args, args, name);
    assert.equal(selected.cwd, cwd, name);
    assert.equal(selected.timeoutMs, 12 * 60 * 1000, name);
  }
  assert.deepEqual(commandFor('check-dist').args, [
    'status', '--porcelain', '--untracked-files=all', '--', 'dist',
  ]);
  assert.equal(commandFor('--help'), null);
  assert.equal(commandFor('probe-native-output'), null);
  assert.equal(commandFor('npm test'), null);
});

test('chunked streams preserve UTF-8 and neutralize CR, terminal controls, and markers', async () => {
  const result = await runFixture('streams');
  assert.equal(result.status, 0);
  assert.doesNotMatch(`${result.output}\n${result.errorOutput}`, SAFE_COMMAND_PATTERN);
  assert.match(result.output, /€/);
  assert.match(result.output, /\\:\\:stdout/);
  assert.match(result.output, /\\#\\#\[error\]/);
  assert.match(result.errorOutput, /\\x0D/);
  assert.match(result.errorOutput, /\\x1B/);
});

test('fixed child exit codes survive output neutralization', async () => {
  const result = await runFixture('exit');
  assert.equal(result.status, 23);
  assert.doesNotMatch(`${result.output}\n${result.errorOutput}`, SAFE_COMMAND_PATTERN);
});

test('output overflow fails closed without retaining partial child output', async () => {
  const result = await runFixture('overflow');
  assert.equal(result.failure, 'output_limit');
  assert.equal(result.output, '');
  assert.equal(result.errorOutput, '');
});

test('timeout kills a child process group within a fixed bound', async () => {
  const started = performance.now();
  const result = await runFixture('timeout', { timeoutMs: 300 });
  const elapsed = performance.now() - started;
  assert.equal(result.failure, 'timeout');
  assert.ok(elapsed < 5_000, `guard timeout took ${elapsed}ms`);
  assert.equal(result.output, '');
});

test('invalid UTF-8 output fails closed without exposing child bytes', async () => {
  const result = await runFixture('invalid-utf8');
  assert.equal(result.decodeError instanceof TypeError, true);
});

test('unknown commands and extra arguments cannot select or alter a command tuple', () => {
  const environment = cleanEnvironment();
  const unknown = spawnSync(process.execPath, [GUARD, 'unknown-command'], {
    cwd: ROOT, env: environment, encoding: 'utf8', maxBuffer: 32 * 1024, timeout: 5_000,
  });
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stdout, '');
  assert.equal(unknown.stderr, 'Unknown approved CI command.\n');

  const extra = spawnSync(process.execPath, [GUARD, 'test-build', '--help'], {
    cwd: ROOT, env: environment, encoding: 'utf8', maxBuffer: 32 * 1024, timeout: 5_000,
  });
  assert.equal(extra.status, 1);
  assert.equal(extra.stdout, '');
  assert.equal(extra.stderr, 'Usage: node automation/ci/guard-command.mjs <approved-command>\n');
});
