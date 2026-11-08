import assert from 'node:assert/strict';
import test from 'node:test';
import { manifest, HEAD, RUN_ID, fakeApi, repositoryConfig } from '../fixtures/worker-candidates/inputs.mjs';
import { createWorkflowDiscovery } from '../../src/automation/worker/discovery.mjs';
const root = '/repos/randoneering/mellon';
const branch = `agent-work/${RUN_ID}`;
function run(overrides = {}) {
  return { id: 700, workflow_id: 3000, run_attempt: 1, head_sha: HEAD, head_branch: branch, event: 'push', path: '.github/workflows/test.yml', repository: { id: 123456, full_name: 'randoneering/mellon' }, head_repository: { id: 123456, full_name: 'randoneering/mellon' }, ...overrides };
}
function discovery(rows, extra = {}) {
  const api = fakeApi({ [`${root}/actions/workflows/3000/runs?branch=${encodeURIComponent(branch)}&head_sha=${HEAD}&event=push&per_page=100&page=1`]: { total_count: rows.length, workflow_runs: rows }, ...extra });
  return createWorkflowDiscovery(repositoryConfig(api));
}
const input = () => ({ manifest: manifest(), headSha: HEAD, branch, deadline: Date.now() + 1000 });

test('discovery returns the exact multi-run check reader schema', async () => {
  assert.deepEqual(await discovery([run()]).discoverWorkflowRuns(input()), { status: 'discovered', runs: [{ workflowId: 3000, headSha: HEAD, branch, runId: 700, runAttempt: 1 }] });
});
test('discovery waits when an immutable head has not scheduled its approved workflow', async () => {
  assert.deepEqual(await discovery([]).discoverWorkflowRuns(input()), { status: 'waiting', reason: 'workflow_runs_pending' });
});
for (const [name, rows] of Object.entries({
  'ambiguous matching runs': [run(), run({ id: 701 })],
  'unapproved rerun': [run({ run_attempt: 2 })],
  'foreign repository': [run({ repository: { id: 1, full_name: 'randoneering/mellon' } })],
  'fork head repository': [run({ head_repository: { id: 2, full_name: 'fork/mellon' } })],
  'stale head': [run({ head_sha: 'f'.repeat(40) })],
  'wrong workflow': [run({ workflow_id: 3001 })],
  'foreign event': [run({ event: 'pull_request' })],
  'mutable workflow path': [run({ path: 'https://attacker.invalid' })],
})) test(`discovery rejects ${name}`, async () => {
  assert.equal((await discovery(rows).discoverWorkflowRuns(input())).status, 'needs_attention');
});

test('discovery snapshots approved workflow bindings before an async mutation', async () => {
  const selected = input();
  const key = `${root}/actions/workflows/3000/runs?branch=${encodeURIComponent(branch)}&head_sha=${HEAD}&event=push&per_page=100&page=1`;
  const api = fakeApi({ [key]: { total_count: 1, workflow_runs: [run()] } }, (path, value) => {
    if (path === root) selected.manifest.requiredWorkflowIdentities[0].id = 999;
    return value;
  });
  const result = await createWorkflowDiscovery(repositoryConfig(api)).discoverWorkflowRuns(selected);
  assert.equal(result.status, 'discovered');
  assert.equal(result.runs[0].workflowId, 3000);
});

test('discovery rejects pagination count truncation and ignored link targets', async () => {
  const key = `${root}/actions/workflows/3000/runs?branch=${encodeURIComponent(branch)}&head_sha=${HEAD}&event=push&per_page=100&page=1`;
  for (const response of [{ total_count: 2, workflow_runs: [run()] }, new Response(JSON.stringify({ total_count: 1, workflow_runs: [run()] }), { headers: { link: '<https://attacker.invalid>; rel="next"' } })]) {
    const reader = discovery([], { [key]: response });
    assert.equal((await reader.discoverWorkflowRuns(input())).status, 'needs_attention');
  }
});
