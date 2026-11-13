import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  buildManifest, runChecks, validateDispatch, verifyRequestedHead,
} from '../../.github/scripts/n8n-runner.mjs';

const sha = 'a'.repeat(40);
const request = () => ({
  repository: 'randoneering/mellon', event_name: 'workflow_dispatch', ref: 'refs/heads/main',
  branch: 'n8n/issue-42', source_sha: sha, request_id: 'n8n-123',
});
const runtime = () => ({ run_id: '123456', run_attempt: '1', workflow_sha: 'b'.repeat(40) });
const files = () => ({
  'dist/index.mjs': Buffer.from('export const action = true;\n'),
  'dist/scorer.mjs': Buffer.from('export const score = 0;\n'),
  'dist/build-meta.json': Buffer.from('{}\n'),
  'dist/THIRD_PARTY_NOTICES.txt': Buffer.from('Notices\n'),
  'dist/detector/provenance.json': Buffer.from('{"fixture":"provenance"}\n'),
  'dist/detector/vendor/aicomment/LICENSE': Buffer.from('License fixture\n'),
  'dist/detector/vendor/aicomment/classifier.mjs': Buffer.from('export const fixture = true;\n'),
  'dist/detector/vendor/aicomment/langs/c_family.mjs': Buffer.from('export const fixture = true;\n'),
  'dist/detector/vendor/aicomment/langs/elisp.mjs': Buffer.from('export const fixture = true;\n'),
  'dist/detector/vendor/aicomment/langs/haskell.mjs': Buffer.from('export const fixture = true;\n'),
  'dist/detector/vendor/aicomment/langs/index.mjs': Buffer.from('export const fixture = true;\n'),
  'dist/detector/vendor/aicomment/langs/perl.mjs': Buffer.from('export const fixture = true;\n'),
  'dist/detector/vendor/aicomment/langs/php.mjs': Buffer.from('export const fixture = true;\n'),
  'dist/detector/vendor/aicomment/langs/python.mjs': Buffer.from('export const fixture = true;\n'),
  'dist/detector/vendor/aicomment/langs/registry.mjs': Buffer.from('export const fixture = true;\n'),
  'dist/detector/vendor/aicomment/langs/shell.mjs': Buffer.from('export const fixture = true;\n'),
  'dist/detector/vendor/aicomment/model.json': Buffer.from('{"fixture":"model"}\n'),
  'dist/detector/vendor/aicomment/preprocess.mjs': Buffer.from('export const fixture = true;\n'),
  'dist/detector/vendor/aicomment/pychars.mjs': Buffer.from('export const fixture = true;\n'),
});

test('accepts only a complete main-workflow dispatch bound to an issue branch', () => {
  assert.deepEqual(validateDispatch(request()), request());
});

for (const [field, value] of [
  ['repository', 'someone/else'], ['event_name', 'pull_request_target'],
  ['ref', 'refs/heads/unreviewed-workflow'], ['branch', 'main'],
  ['branch', 'n8n/issue-0'], ['branch', 'n8n/issue-42; echo injected'],
  ['branch', 'n8n/issue-' + '1'.repeat(100)],
  ['source_sha', 'main'], ['source_sha', 'A'.repeat(40)],
  ['request_id', '../../result'], ['request_id', 'n8n-0'],
  ['request_id', 'n8n-123\nother'],
]) {
  test(`rejects invalid ${field}: ${JSON.stringify(value)}`, () => {
    assert.throws(() => validateDispatch({ ...request(), [field]: value }), /dispatch/);
  });
}

test('checks the requested branch with a read token and refuses redirects', async () => {
  let url;
  let options;
  await verifyRequestedHead(request(), 'read-token', async (u, o) => {
    url = u;
    options = o;
    return { status: 200, json: async () => ({ object: { type: 'commit', sha } }) };
  });
  assert.equal(url, 'https://api.github.com/repos/randoneering/mellon/git/ref/heads/n8n/issue-42');
  assert.equal(options.redirect, 'manual');
  assert.equal(options.headers.Authorization, 'Bearer read-token');
});

test('rejects a moved branch', async () => {
  await assert.rejects(verifyRequestedHead(request(), 'read-token', async () => ({
    status: 200, json: async () => ({ object: { type: 'commit', sha: 'c'.repeat(40) } }),
  })), /source-validation/);
});

test('does not disclose network errors or read redirect response bodies', async () => {
  const secret = 'private-token-in-remote-error';
  await assert.rejects(verifyRequestedHead(request(), 'read-token', async () => {
    throw new Error(secret);
  }), error => error.message === 'source-validation failed (request).');
  await assert.rejects(verifyRequestedHead(request(), 'read-token', async () => ({
    status: 302, json: async () => { throw new Error(secret); },
  })), error => !error.message.includes(secret));
});

test('executes the fixed checks in order without caller-supplied commands', () => {
  const calls = [];
  const result = runChecks((command, args, stage) => {
    calls.push([command, args, stage]);
    return { status: 0 };
  });
  assert.deepEqual(calls, [
    ['npm', ['ci', '--ignore-scripts'], 'install-root'],
    ['npm', ['ci', '--prefix', 'detector', '--ignore-scripts'], 'install-detector'],
    ['npm', ['run', 'verify:assets'], 'verify-assets'],
    ['npm', ['run', 'test:build'], 'test-build'],
    ['npm', ['test'], 'tests'],
    ['npm', ['run', 'test:parity'], 'parity'],
    ['npm', ['run', 'build'], 'build'],
    ['npm', ['run', 'validate:release'], 'validate-release'],
  ]);
  assert.deepEqual(result, { completed: 8 });
});

test('stops after a failed check and exposes only stage and category', () => {
  let count = 0;
  assert.throws(() => runChecks(() => {
    count += 1;
    return { status: 1, stderr: 'secret output', stdout: 'private submission' };
  }), error => error.message === 'install-root failed (command).');
  assert.equal(count, 1);
});

test('sanitizes failures when a command cannot start', () => {
  assert.throws(() => runChecks(() => { throw new Error('secret executable error'); }),
    error => error.message === 'install-root failed (command).');
});

test('binds the manifest to the source, workflow, request, run, and file bytes', () => {
  const manifest = buildManifest(request(), files(), runtime());
  assert.equal(manifest.version, 1);
  assert.equal(manifest.repository, 'randoneering/mellon');
  assert.equal(manifest.source_sha, sha);
  assert.equal(manifest.workflow_sha, 'b'.repeat(40));
  assert.equal(manifest.branch, 'n8n/issue-42');
  assert.equal(manifest.request_id, 'n8n-123');
  assert.equal(manifest.run_id, '123456');
  assert.equal(manifest.run_attempt, 1);
  assert.equal(manifest.files.length, 19);
  const action = manifest.files.find(file => file.path === 'dist/index.mjs');
  assert.equal(action.contents, 'ZXhwb3J0IGNvbnN0IGFjdGlvbiA9IHRydWU7Cg==');
  assert.equal(action.sha256, createHash('sha256').update('export const action = true;\n').digest('hex'));
});

test('exports every currently packaged distribution file, including detector assets', () => {
  const manifest = buildManifest(request(), files(), runtime());
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const packaged = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', 'dist'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(manifest.files.map(file => file.path).sort(), packaged.sort());
  for (const name of ['dist/detector/provenance.json', 'dist/detector/vendor/aicomment/model.json']) {
    const output = manifest.files.find(file => file.path === name);
    assert.deepEqual(Buffer.from(output.contents, 'base64'), files()[name]);
    assert.equal(output.sha256, createHash('sha256').update(files()[name]).digest('hex'));
  }
});

test('gives reruns distinct artifact names without replacing earlier results', () => {
  const first = buildManifest(request(), files(), runtime());
  const rerun = buildManifest(request(), files(), { ...runtime(), run_attempt: '2' });
  assert.equal(first.artifact_name, 'n8n-build-n8n-123-attempt-1');
  assert.equal(rerun.artifact_name, 'n8n-build-n8n-123-attempt-2');
  assert.notEqual(first.artifact_name, rerun.artifact_name);
  assert.equal(rerun.run_attempt, 2);
  assert.equal(rerun.run_id, first.run_id);
});

test('rejects an artifact that omits a packaged detector file', () => {
  const incomplete = files();
  delete incomplete['dist/detector/vendor/aicomment/model.json'];
  assert.throws(() => buildManifest(request(), incomplete, runtime()), /export/);
});

test('rejects missing and extra output files', () => {
  const missing = files();
  delete missing['dist/scorer.mjs'];
  assert.throws(() => buildManifest(request(), missing, runtime()), /export/);
  assert.throws(() => buildManifest(request(), { ...files(), '.github/workflows/evil.yml': Buffer.from('x') }, runtime()), /export/);
});

test('rejects non-buffer output and invalid UTF-8', () => {
  assert.throws(() => buildManifest(request(), { ...files(), 'dist/index.mjs': 'not bytes' }, runtime()), /export/);
  assert.throws(() => buildManifest(request(), { ...files(), 'dist/index.mjs': Buffer.from([255]) }, runtime()), /export/);
});

test('rejects empty generated files', () => {
  assert.throws(() => buildManifest(request(), { ...files(), 'dist/index.mjs': Buffer.alloc(0) }, runtime()), /export/);
});

test('rejects individual outputs over 8 MiB', () => {
  assert.throws(() => buildManifest(request(), {
    ...files(), 'dist/index.mjs': Buffer.alloc(8 * 1024 * 1024 + 1, 97),
  }, runtime()), /export/);
});

test('rejects aggregate output over 16 MiB', () => {
  assert.throws(() => buildManifest(request(), {
    ...files(), 'dist/index.mjs': Buffer.alloc(8 * 1024 * 1024, 97),
    'dist/scorer.mjs': Buffer.alloc(8 * 1024 * 1024, 97),
  }, runtime()), /export/);
});

for (const change of [
  { run_id: '../other' }, { run_attempt: '0' }, { workflow_sha: 'main' },
  { run_id: '123\n' }, { run_attempt: '1\n' }, { workflow_sha: 'b'.repeat(40) + '\n' },
]) {
  test(`rejects invalid run metadata ${JSON.stringify(change)}`, () => {
    assert.throws(() => buildManifest(request(), files(), { ...runtime(), ...change }), /export/);
  });
}
