import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createCoordinator } from '../../src/automation/worker/coordinator.mjs';
import { checkApproval } from '../../src/automation/worker/approval.mjs';
import { validateFinishInput } from '../../src/automation/worker/store-validation.mjs';
import { harness, delivery, syntheticFutureReview } from '../fixtures/worker-coordinator/harness.mjs';

mock.method(globalThis, 'fetch', async () => { throw new Error('Uncontrolled network forbidden.'); });

async function setupAt(state) {
  const h = await harness();
  h.coordinator = createCoordinator(h.dependencies);
  for (let step = 0; h.state.run.state !== state && step < 15; step += 1) {
    h.state.checkStatus = h.state.run.state === 'waiting_red_ci' ? 'intended_red' : 'success';
    assert.equal((await h.coordinator.advanceTick(delivery())).status, 'advanced');
  }
  assert.equal(h.state.run.state, state);
  return h;
}

for (const state of ['waiting_red_ci', 'waiting_ci', 'waiting_review']) {
  test(`durable ${state} deadline rejects evidence that arrives after expiry`, async t => {
    const h = await setupAt(state);
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const seconds = state === 'waiting_review' ? h.manifest.limits.reviewWaitSeconds : h.manifest.limits.ciWaitSeconds;
    h.state.phase.waitStartedAt = new Date(now - seconds * 1000 + 200).toISOString();
    h.state.checkStatus = state === 'waiting_red_ci' ? 'intended_red' : 'success';
    if (state === 'waiting_review') {
      h.adapters.review.readReview = async () => { now += 300; return syntheticFutureReview(h.state); };
    } else {
      h.state.checkHook = async () => { now += 300; return h.checksResult(h.state.checkStatus); };
    }
    const checkpoints = h.state.calls.filter(call => call[0] === 'checkpoint').length;
    const response = await h.coordinator.advanceTick(delivery());
    assert.equal(response.status, 'needs_attention');
    assert.equal(response.reason, 'coordinator_wait_expired');
    assert.equal(h.state.calls.filter(call => call[0] === 'checkpoint').length, checkpoints);
    assert.equal(h.state.run.state, 'needs_attention');
    assert.equal(h.state.run.repairCycleCount, 0);
  });
}

test('durable review deadline is rechecked after final fresh authority', async t => {
  const h = await setupAt('waiting_review');
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  h.state.phase.waitStartedAt = new Date(now - h.manifest.limits.reviewWaitSeconds * 1000 + 200).toISOString();
  h.state.reviewResult = syntheticFutureReview(h.state);
  h.state.checkStatus = 'success';
  let checks = 0;
  h.coordinator = createCoordinator({ ...h.dependencies, adapters: { ...h.adapters,
    async checkApproval(options) {
      const value = await checkApproval(options);
      if (++checks === 2) now += 300;
      return value;
    },
  } });
  const response = await h.coordinator.advanceTick(delivery());
  assert.equal(response.status, 'needs_attention');
  assert.equal(response.reason, 'coordinator_wait_expired');
  assert.equal(h.state.run.state, 'needs_attention');
});

for (const source of ['ci', 'qodo']) {
  test(`late ${source} evidence cannot reserve a repair after its durable wait`, async t => {
    const h = await setupAt(source === 'ci' ? 'waiting_ci' : 'waiting_review');
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const seconds = source === 'ci' ? h.manifest.limits.ciWaitSeconds : h.manifest.limits.reviewWaitSeconds;
    h.state.phase.waitStartedAt = new Date(now - seconds * 1000 + 200).toISOString();
    if (source === 'ci') {
      h.state.checkStatus = 'needs_attention';
      h.state.filesHook = async () => { now += 300; };
    } else {
      const failure = h.checksResult('failure');
      h.state.reviewResult = syntheticFutureReview(h.state, [{
        findingSha256: failure.findingSha256, assertions: failure.evidence.assertions,
      }]);
      h.state.checkHook = async () => { now += 300; return h.checksResult('success'); };
    }
    const calls = h.state.calls.filter(call => call[0] === 'beginRepair').length;
    const response = await h.coordinator.advanceTick(delivery());
    assert.equal(response.reason, 'coordinator_wait_expired');
    assert.equal(h.state.calls.filter(call => call[0] === 'beginRepair').length, calls);
    assert.equal(h.state.run.repairCycleCount, 0);
  });
}

test('exact RED transition emits head-bound persistent check references', async () => {
  const h = await setupAt('waiting_red_ci');
  h.state.checkStatus = 'intended_red';
  const head = h.state.run.expectedHeadSha;
  assert.equal((await h.coordinator.advanceTick(delivery())).status, 'advanced');
  const change = h.state.calls.filter(call => call[0] === 'checkpoint').at(-1)[1];
  assert.equal(change.lastCheckRunId, 811);
  assert.equal(change.coordinator.priorCheckRunId, 811);
  assert.deepEqual({ ...change.evidence, checksSha256: 'digest' }, {
    headSha: head, workflowId: 3000, workflowRunId: 800, checkRunId: 811,
    checksSha256: 'digest', reviewId: null,
  });
  assert.match(change.evidence.checksSha256, /^[a-f0-9]{64}$/);
});

test('SYNTHETIC FUTURE readiness emits one atomic evidence-bearing terminal write', async () => {
  const h = await setupAt('waiting_review');
  h.state.checkStatus = 'success';
  h.state.reviewResult = syntheticFutureReview(h.state);
  const checkpoints = h.state.calls.filter(call => call[0] === 'checkpoint').length;
  const head = h.state.run.expectedHeadSha;
  assert.equal((await h.coordinator.advanceTick(delivery())).status, 'ready_for_human');
  assert.equal(h.state.calls.filter(call => call[0] === 'checkpoint').length, checkpoints);
  const terminals = h.state.calls.filter(call => call[0] === 'finishRun' && call[1] === 'ready_for_human');
  assert.equal(terminals.length, 1);
  assert.deepEqual({ ...terminals[0][2].evidence, checksSha256: 'digest' }, {
    headSha: head, workflowId: 3000, workflowRunId: 800, checkRunId: 811,
    checksSha256: 'digest', reviewId: 900,
  });
  assert.match(terminals[0][2].evidence.checksSha256, /^[a-f0-9]{64}$/);
  assert.equal(terminals[0][3].deadline, h.state.deadline);
});

test('explicit withdrawal uses the real closed cancellation options contract', async () => {
  const h = await setupAt('generating_tests');
  const finish = h.store.finishRun;
  h.store.finishRun = async (lease, state, options, waitOptions) => {
    validateFinishInput(state, options);
    return finish(lease, state, options, waitOptions);
  };
  h.state.approvalReason = 'issue_not_open';
  const response = await h.coordinator.advanceTick(delivery());
  assert.equal(response.status, 'cancelled');
  assert.equal(response.persisted, true);
  assert.equal(h.state.modelRequests, 0);
});
