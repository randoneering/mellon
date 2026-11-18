import test from 'node:test';
import assert from 'node:assert/strict';
import { validateControlJob, authorizedControlRequest, safeThreadState, proposalMetadata, NO_REBUILD_PATH } from '../../internal/factory-worker/control-policy.mjs';

const CONFIG = { issueNumber: 123, baseSha: 'a'.repeat(40), secret: 's'.repeat(64), projectId: 'project-id', model: 'openai-codex/gpt-6.1-sol' };
const JOB = { jobId: '12345678-1234-4234-8234-123456789abc', issueNumber: 123, baseSha: 'a'.repeat(40), planSha256: 'b'.repeat(64), task: 'Implement only the reviewed pilot file.', allowedPaths: ['tests/unit/personalized-terminal-controls.test.mjs'] };

test('controller accepts only the approved issue/base and bounded data payload', () => {
  assert.deepEqual(validateControlJob(JOB, CONFIG), JOB);
});
for (const extra of [
  { issueNumber: 999 }, { baseSha: 'c'.repeat(40) }, { jobId: '../../outside' },
  { planSha256: '' }, { task: '' }, { task: 'x'.repeat(32769) },
  { command: 'arbitrary shell' }, { model: 'other-provider/model' }, { workerId: 'unrelated' },
]) {
  test('controller refuses expanded scope or malformed job data', () => {
    assert.throws(() => validateControlJob({ ...JOB, ...extra }, CONFIG), /Factory controller input rejected/);
  });
}

test('controller authentication requires the exact non-worker credential', () => {
  assert.equal(authorizedControlRequest('Bearer '+CONFIG.secret, CONFIG.secret), true);
  for (const header of [undefined, 'Bearer wrong', CONFIG.secret, 'Basic '+CONFIG.secret, 'Bearer '+'é'.repeat(64)]) assert.equal(authorizedControlRequest(header, CONFIG.secret), false);
});

test('T3 status is bound to the requested Pi thread and never returns assistant content', () => {
  const value = { thread: { threadId: 'thread-id', projectId: CONFIG.projectId, providerInstanceId: 'pi', model: CONFIG.model, status: 'working', pendingRequestCount: 0, latestRunId: 'run-id' }, recentRuns: [], items: [{ text: 'private-output-canary' }] };
  const report = safeThreadState(value, 'thread-id', CONFIG);
  assert.equal(report.status, 'working');
  assert.equal(JSON.stringify(report).includes('private-output-canary'), false);
  assert.throws(() => safeThreadState(value, 'another-thread', CONFIG), /Factory controller input rejected/);
  value.thread.providerInstanceId = 'codex';
  assert.throws(() => safeThreadState(value, 'thread-id', CONFIG), /Factory controller input rejected/);
});

test('completion without recentRuns needs completed status, no active run, zero pending and a latest run', () => {
  const base = { threadId: 'thread-id', projectId: CONFIG.projectId, providerInstanceId: 'pi', model: CONFIG.model, status: 'completed', activeRunId: null, latestRunId: 'run-id', pendingRequestCount: 0 };
  assert.equal(safeThreadState({ thread: base, messages: [] }, 'thread-id', CONFIG).complete, true);
  for (const change of [{ status: 'running' }, { activeRunId: 'run-id' }, { pendingRequestCount: 1 }, { latestRunId: null }]) {
    assert.equal(safeThreadState({ thread: { ...base, ...change }, messages: [] }, 'thread-id', CONFIG).complete, false);
  }
  assert.equal(safeThreadState({ thread: base, recentRuns: [{ runId: 'run-id', status: 'failed' }] }, 'thread-id', CONFIG).complete, false);
  for (const count of [undefined, -1, 0.5, '0']) {
    assert.throws(() => safeThreadState({ thread: { ...base, pendingRequestCount: count } }, 'thread-id', CONFIG));
  }
  assert.equal(safeThreadState({ thread: base, recentRuns: [] }, 'thread-id', CONFIG).complete, false);
});

test('no-rebuild paths cover tests, docs, README and personalized code only', () => {
  for (const path of ['tests/unit/a.test.mjs', 'tests/integration/b-c.test.mjs', 'docs/a.md', 'docs/guide/deep/x.md', 'README.md', 'src/personalized/cli.mjs']) assert.equal(NO_REBUILD_PATH.test(path), true, path);
  for (const path of ['src/action.mjs', 'src/personalized/../action.mjs', 'docs/../src/x.md', 'dist/index.mjs', '.github/workflows/ci.yml', 'package.json', 'tests/fixtures/x.json', 'README.md/x', 'docs/a.txt', 'scripts/validate-release.mjs']) assert.equal(NO_REBUILD_PATH.test(path), false, path);
  for (const config of [{}, CONFIG]) assert.deepEqual(validateControlJob(JOB, config), JOB);
});

test('worker PR metadata must be one safe conventional line and a clean summary', () => {
  assert.deepEqual(proposalMetadata({ title: 'docs(readme): explain setup', summary: ' Adds notes. ' }, 5), { title: 'docs(readme): explain setup', summary: 'Adds notes.', source: 'worker' });
  for (const meta of [undefined, {}, { title: 'Explain setup', summary: 'x' }, { title: 'docs(readme): x\ny', summary: 's' }, { title: 'docs(Readme): bad scope', summary: 's' },
    { title: 'docs(readme): ok text', summary: '' }, { title: 'docs(readme): ok text', summary: 'a\u001b[31m' }, { title: 'docs(readme): ok text', summary: 'x'.repeat(4001) },
    { title: 'docs(readme): ok text', summary: 'token ghp_' + 'a'.repeat(30) }]) {
    const result = proposalMetadata(meta, 5);
    assert.equal(result.source, 'fallback');
    assert.equal(result.title, 'chore(factory): address issue #5');
  }
});

test('rebuild paths cover runtime source, action.yml and test fixtures, never tooling or generated files', async () => {
  const { REBUILD_PATH, requiresRebuild } = await import('../../internal/factory-worker/control-policy.mjs');
  for (const path of ['action.yml', 'src/action.mjs', 'src/github.mjs', 'src/inputs.mjs', 'src/moderation.mjs', 'src/prepare.mjs', 'tests/fixtures/a.json', 'tests/fixtures/deep/b.txt']) assert.equal(REBUILD_PATH.test(path), true, path);
  for (const path of ['src/personalized/cli.mjs', 'scripts/build.mjs', 'detector/scorer.mjs', 'dist/index.mjs', 'package.json', '.github/workflows/ci.yml', 'src/../x.mjs', 'tests/fixtures/x.sh', 'action.yaml.bak']) assert.equal(REBUILD_PATH.test(path), false, path);
  assert.equal(requiresRebuild(['docs/a.md', 'tests/unit/a.test.mjs']), false);
  assert.equal(requiresRebuild(['src/inputs.mjs', 'tests/unit/a.test.mjs']), true);
});

test('jobs declare requiresRebuild, and it must match their paths', () => {
  const rebuild = { ...JOB, allowedPaths: ['src/inputs.mjs', 'tests/unit/inputs.test.mjs'], requiresRebuild: true };
  assert.deepEqual(validateControlJob(rebuild, {}), rebuild);
  // No-rebuild jobs omit the flag, so digests of existing journals stay valid.
  assert.deepEqual(validateControlJob({ ...JOB, requiresRebuild: false }, {}), JOB);
  assert.deepEqual(validateControlJob(JOB, {}), JOB);
  for (const bad of [{ ...rebuild, requiresRebuild: false }, { ...JOB, requiresRebuild: true }, { ...rebuild, requiresRebuild: 'yes' }, { ...JOB, allowedPaths: ['scripts/build.mjs'] }]) {
    assert.throws(() => validateControlJob(bad, {}), /Factory controller input rejected/);
  }
});

test('each grant round rewrites only the capability file; models.json keeps a request-time command', async () => {
  const { CAPABILITY_PROGRAM, CAPABILITY_COMMAND } = await import('../../internal/factory-worker/control.mjs');
  const { mkdtemp, mkdir, writeFile, readFile, stat } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = join(await mkdtemp(join(tmpdir(), 'mellon-capability-')), 'pi-agent');
  await mkdir(dir, { mode: 0o700 });
  await writeFile(join(dir, 'auth.json'), '{}');
  await writeFile(join(dir, 'models.json'), JSON.stringify({ providers: { 'openai-codex': { models: [{ id: 'gpt-6.1-sol', baseUrl: 'https://chatgpt.com/backend-api' }] } } }));
  const program = CAPABILITY_PROGRAM.replace("process.getuid()!==10001||process.env.PI_CODING_AGENT_DIR!=='/worker-state/pi-agent'", 'false').replace("const dir='/worker-state/pi-agent'", `const dir=${JSON.stringify(dir)}`);
  const install = apiKey => spawnSync(process.execPath, ['--input-type=module', '-e', program], { input: JSON.stringify({ baseUrl: 'http://mellon-factory-relay-012345abcdef:8790/backend-api', apiKey }), encoding: 'utf8' });
  assert.equal(install('a.first.c').status, 0);
  const first = await readFile(join(dir, 'models.json'), 'utf8');
  assert.equal(await readFile(join(dir, 'relay-capability'), 'utf8'), 'a.first.c');
  assert.equal((await stat(join(dir, 'relay-capability'))).mode & 0o777, 0o600);
  const provider = JSON.parse(first).providers['openai-codex'];
  assert.equal(provider.apiKey, CAPABILITY_COMMAND);
  assert.equal(provider.apiKey, `!cat /worker-state/pi-agent/relay-capability`);
  assert.equal(first.includes('a.first.c'), false);
  assert.equal(install('a.second.c').status, 0);
  assert.equal(await readFile(join(dir, 'relay-capability'), 'utf8'), 'a.second.c');
  assert.equal(await readFile(join(dir, 'models.json'), 'utf8'), first);
  assert.notEqual(install('bad capability').status, 0);
});
