import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoordinator } from '../../src/automation/worker/coordinator.mjs';
import { harness, delivery, syntheticFutureReview } from '../fixtures/worker-coordinator/harness.mjs';
import { hash, canonical } from '../fixtures/worker-candidates/inputs.mjs';

const tick = h => h.coordinator.advanceTick(delivery());
async function setup() { const h = await harness(); h.coordinator = createCoordinator(h.dependencies); return h; }
async function through(h, state) {
  for (let index = 0; h.state.run.state !== state && index < 15; index += 1) {
    h.state.checkStatus = h.state.run.state === 'waiting_red_ci' ? 'intended_red' : 'success';
    assert.equal((await tick(h)).status, 'advanced');
  }
  assert.equal(h.state.run.state, state);
}

for (const field of ['repositoryId', 'repositoryFullName', 'issueId', 'issueNumber', 'manifestHash', 'baseRevision', 'policyRevision', 'jobId', 'generation']) {
  test(`coordinator identity boundary: mismatched ${field} never starts a model`, async () => {
    const h = await setup();
    const original = h.store.getCoordinatorSnapshot;
    h.store.getCoordinatorSnapshot = async (...args) => { const snapshot = await original(...args); snapshot.run[field] = 'foreign'; return snapshot; };
    assert.equal((await tick(h)).status, 'needs_attention');
    assert.equal(h.state.modelRequests, 0);
  });
}

test('coordinator immutable manifest snapshot survives caller mutation without widening the pilot', async () => {
  const h = await setup();
  h.manifest.issue.number = 21; h.manifest.allowedPaths.push('unapproved.mjs');
  await tick(h);
  assert.equal(h.state.calls.find(call => call[0] === 'claimTick')[1].manifest.issueNumber, 22);
  assert.equal(h.state.contexts.length, 0);
});

test('coordinator policy integrity: changed pinned guidance stops before any model reservation', async () => {
  const h = await harness();
  h.adapters.repository.readTrustedFile = async () => 'Changed private policy text';
  h.coordinator = createCoordinator(h.dependencies);
  assert.equal((await tick(h)).status, 'needs_attention');
  assert.equal(h.state.calls.some(call => call[0] === 'reserveModelCall'), false);
  assert.equal(h.state.modelRequests, 0);
});

test('coordinator current issue integrity: independent immutable issue read must match exact approved content hash', async () => {
  const h = await harness(); h.adapters.repository.readIssue = async () => ({ title: 'changed', body: 'private content' });
  h.coordinator = createCoordinator(h.dependencies);
  const response = await tick(h);
  assert.equal(response.status, 'needs_attention'); assert.equal(h.state.modelRequests, 0);
  assert.doesNotMatch(JSON.stringify(response), /private content|changed/);
});

test('coordinator deadline: expired claimed deadline prevents even the first snapshot and all terminal writes', async () => {
  const h = await setup(); const original = h.store.claimTick;
  h.store.claimTick = async (...args) => ({ ...await original(...args), deadline: Date.now() - 1 });
  assert.equal((await tick(h)).reason, 'recovery_deadline');
  assert.equal(h.state.calls.length, 1);
});

test('coordinator stale ownership: callback returns no lease authority, no cancellation of successor', async () => {
  const h = await setup();
  h.store.getCoordinatorSnapshot = async () => ({ status: 'stale' });
  h.state.finishHook = () => false;
  assert.equal((await tick(h)).reason, 'recovery_lease_lost');
  assert.equal(h.state.stops.length, 0); assert.equal(h.state.modelRequests, 0);
});

test('coordinator fresh initial PR checks: previous green is not reusable after head evidence changes', async () => {
  const h = await setup(); await through(h, 'opening_pr');
  h.state.checkStatus = 'needs_attention';
  const count = h.state.publications.length;
  assert.equal((await tick(h)).status, 'needs_attention');
  assert.equal(h.state.publications.length, count);
  assert.equal(h.state.calls.filter(call => call[0] === 'checks').length >= 3, true);
});

test('coordinator mixed CI and SYNTHETIC FUTURE Qodo share two repair cycles and one draft identity', async () => {
  const h = await setup(); await through(h, 'waiting_ci');
  h.state.checkStatus = 'needs_attention';
  assert.equal((await tick(h)).status, 'advanced'); assert.equal(h.state.phase.findingSource, 'ci');
  await tick(h); await through(h, 'waiting_review');
  assert.equal(h.state.run.repairCycleCount, 1);
  h.state.reviewResult = syntheticFutureReview(h.state, [{ findingSha256: hash('synthetic-qodo-mixed'), assertions: h.checksResult('failure').evidence.assertions }]);
  assert.equal((await tick(h)).status, 'advanced'); assert.equal(h.state.phase.findingSource, 'qodo');
  await tick(h); await through(h, 'waiting_review');
  assert.equal(h.state.run.repairCycleCount, 2);
  assert.equal(h.state.publications.filter(value => value.intent.kind === 'pr_create').length, 1);
  assert.equal(h.state.modelRequests, 6);
  h.state.reviewResult = syntheticFutureReview(h.state, [{ findingSha256: hash('third-mixed'), assertions: h.checksResult('failure').evidence.assertions }]);
  assert.equal((await tick(h)).reason, 'repair_cycle_limit');
});

test('coordinator pending draft uses the same original typed envelope without candidate/body generation', async () => {
  const h = await setup(); await through(h, 'opening_pr');
  let original;
  h.state.recoveryHook = request => {
    original ??= structuredClone(request);
    assert.deepEqual(request.intent, original.intent);
    assert.deepEqual(request.publication, original.publication);
    h.state.pendingOperation = { ...request.intent, operationId: 'pending-draft' };
    h.state.phase.pendingOperationId = 'pending-draft';
    return { status: 'needs_attention', reason: 'recovery_effect_unconfirmed', persisted: false };
  };
  const before = h.state.modelRequests;
  await tick(h); await tick(h);
  assert.equal(h.state.modelRequests, before);
  assert.equal(h.state.calls.filter(call => call[0] === 'recovery').length, 4);
  assert.equal(h.state.calls.some(call => call[0] === 'reconstruct'), false);
});

test('coordinator new repair regression selects an approved criterion without inheriting the old test-selection hash', async () => {
  const h = await harness();
  h.manifest.acceptanceCriteria.push('Another approved criterion.');
  h.dependencies.expectedManifestSha256 = hash(canonical(h.manifest));
  h.state.run.manifestHash = h.dependencies.expectedManifestSha256;
  h.coordinator = createCoordinator(h.dependencies);
  await through(h, 'waiting_ci'); h.state.checkStatus = 'needs_attention';
  await tick(h); await tick(h); h.state.assessmentCriterionIndex = 1;
  assert.equal((await tick(h)).status, 'advanced');
  assert.equal(h.state.publications.at(-1).intent.coordinator.criterionSha256, hash(h.manifest.acceptanceCriteria[1]));
});

for (const corrupt of ['finding', 'source', 'head', 'native_identity']) {
  test(`coordinator reauthenticates CI investigation ${corrupt} before reservation`, async () => {
    const h = await setup(); await through(h, 'waiting_ci'); h.state.checkStatus = 'needs_attention';
    await tick(h); await tick(h);
    const original = h.adapters.checks.readFailure;
    h.adapters.checks.readFailure = async request => {
      const value = await original(request);
      if (corrupt === 'finding') value.findingSha256 = 'f'.repeat(64);
      if (corrupt === 'head') value.headSha = 'e'.repeat(40);
      if (corrupt === 'native_identity') value.evidence.assertions[0].testIdentitySha256 = 'd'.repeat(64);
      if (corrupt === 'source') value.evidence.assertions[0].workflowId = 99999;
      return value;
    };
    const count = h.state.modelRequests;
    assert.equal((await tick(h)).status, 'needs_attention');
    assert.equal(h.state.modelRequests, count);
  });
}
