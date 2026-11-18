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
  const value = { thread: { threadId: 'thread-id', projectId: CONFIG.projectId, providerInstanceId: 'pi', model: CONFIG.model, status: 'working', latestRunId: 'run-id' }, recentRuns: [], items: [{ text: 'private-output-canary' }] };
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
  for (const change of [{ status: 'running' }, { activeRunId: 'run-id' }, { pendingRequestCount: 1 }, { pendingRequestCount: undefined }, { latestRunId: null }]) {
    assert.equal(safeThreadState({ thread: { ...base, ...change }, messages: [] }, 'thread-id', CONFIG).complete, false);
  }
  assert.equal(safeThreadState({ thread: base, recentRuns: [{ runId: 'run-id', status: 'failed' }] }, 'thread-id', CONFIG).complete, false);
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
