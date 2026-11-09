import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { harness, delivery, syntheticFutureReview } from '../fixtures/worker-coordinator/harness.mjs';
import { buildCoordinatorPhaseKey } from '../../src/automation/worker/store-validation.mjs';
import { createReviewReader } from '../../src/automation/worker/review.mjs';
import { hash, canonical, candidateInput } from '../fixtures/worker-candidates/inputs.mjs';
import { prepareCandidate } from '../../src/automation/worker/candidate.mjs';

mock.method(globalThis, 'fetch', async () => { throw new Error('Uncontrolled network forbidden'); });
const module = await import('../../src/automation/worker/coordinator.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
function coordinator(dependencies) {
  assert.equal(typeof module.createCoordinator, 'function', 'missing createCoordinator');
  return module.createCoordinator(dependencies);
}
async function setup() { const h = await harness(); h.coordinator = coordinator(h.dependencies); return h; }
async function tick(h) { return h.coordinator.advanceTick(delivery()); }
async function through(h, state) {
  for (let index = 0; h.state.run.state !== state && index < 15; index += 1) {
    h.state.checkStatus = h.state.run.state === 'waiting_red_ci' ? 'intended_red' : 'success';
    const result = await tick(h);
    assert.equal(result.status, 'advanced', JSON.stringify(result));
  }
  assert.equal(h.state.run.state, state);
}

test('coordinator scripted journal: initialization advances without model or publication', async () => {
  const h = await setup();
  assert.equal((await tick(h)).status, 'advanced');
  assert.equal(h.state.run.state, 'generating_tests');
  assert.equal(h.state.modelRequests, 0);
  assert.equal(h.state.publications.length, 0);
  assert.equal(h.state.phase.purpose, 'initial_tests');
});

test('coordinator real Agent and candidate: initial lifecycle uses two calls, one draft, phase-head files', async () => {
  const h = await setup();
  await through(h, 'waiting_review');
  assert.equal(h.state.modelRequests, 2);
  assert.equal(h.state.publications.length, 3);
  const [tests, implementation, draft] = h.state.publications;
  assert.equal(tests.intent.coordinator.purpose, 'initial_tests');
  assert.deepEqual(h.state.contexts[0].phaseInstructions, {
    purpose: 'initial_tests', repairCycle: 0,
    regressionPath: h.manifest.allowedPaths[h.manifest.coordinator.regression.testPathIndex],
    testName: h.manifest.coordinator.regression.initial.testName,
    criterionIndex: h.manifest.coordinator.regression.initial.criterionIndex,
    criterion: h.manifest.acceptanceCriteria[h.manifest.coordinator.regression.initial.criterionIndex],
  });
  assert.equal(implementation.intent.coordinator.purpose, 'initial_implementation');
  assert.equal(draft.intent.kind, 'pr_create');
  assert.notEqual(h.state.contexts[1].repository.baseSha, h.manifest.base.revision);
  assert.equal(implementation.publication.run.baseSha, h.manifest.base.revision);
  assert.equal(implementation.publication.run.expectedHeadSha, h.state.contexts[1].repository.baseSha);
  assert.deepEqual(Object.keys(tests.publication.proposedChanges[0]).sort(), ['content', 'operation', 'path']);
  for (const context of h.state.contexts) assert.equal(context.investigation, undefined);
});

test('coordinator marks a validated proposal lost at candidate validation with bounded metadata', async () => {
  const h = await harness();
  h.dependencies.adapters.createAgentWorker = options => ({ run: async () => {
    const context = await options.loadContext();
    const reservation = await options.authorization.reserveModelCall({ inputHash: hash('synthetic'),
      expectedHeadSha: context.repository.baseSha, inputTokens: 500, outputTokens: 100 });
    await options.authorization.recordModelCallOutcome(reservation,
      { outcome: 'success', actualInputTokens: 100, actualOutputTokens: 10 });
    return { status: 'completed', proposal: true, changes: [], baseSha: context.repository.baseSha,
      manifestHash: context.manifest.hash, diagnostics: { proposalCategory: 'valid_proposal',
        toolCounts: { proposeChanges: 1 } } };
  } });
  h.coordinator = coordinator(h.dependencies);
  await tick(h);
  const result = await tick(h);
  assert.equal(result.reason, 'coordinator_candidate_lost');
  assert.equal(result.diagnostics.proposalCategory, 'lost_valid_proposal');
  assert.deepEqual({ ...result.diagnostics.toolCounts }, { proposeChanges: 1 });
});

test('coordinator journal: confirmed wait keeps parent identity, timestamps, successful model is normal', async () => {
  const h = await setup(); await through(h, 'waiting_red_ci');
  const phase = structuredClone(h.state.phase);
  assert.notEqual(phase.headSha, h.state.run.expectedHeadSha);
  h.state.checkStatus = 'waiting';
  assert.equal((await tick(h)).status, 'waiting');
  assert.deepEqual(h.state.phase, phase);
  assert.equal(h.state.modelRequests, 1);
});

for (const state of ['waiting_red_ci', 'waiting_ci', 'waiting_review']) {
  test(`coordinator no-model wait: ${state} bounded read and lease-release checkpoint`, async () => {
    const h = await setup(); await through(h, state);
    h.state.checkStatus = 'waiting';
    const before = h.state.modelRequests;
    assert.equal((await tick(h)).status, 'waiting');
    assert.equal(h.state.modelRequests, before);
    assert.equal(h.state.calls.at(-1)[0], 'checkpoint');
  });
}

for (const mutate of [d => { d.tokens = 'forged'; }, d => { d.data.manifest = {}; }, d => { d.trigger.id = 'foreign'; }, d => { d.trigger.extra = true; }, d => { d.data.scheduledAt = 'tomorrow'; }]) {
  test(`coordinator delivery boundary ${mutate.toString()}`, async () => {
    const h = await setup(); const d = delivery(); mutate(d);
    assert.equal((await h.coordinator.advanceTick(d)).status, 'needs_attention');
    assert.equal(h.state.calls.length, 0);
  });
}

test('coordinator immutable external pin and required coordinator block reject configuration', async () => {
  const h = await harness();
  assert.throws(() => coordinator({ ...h.dependencies, expectedManifestSha256: '0'.repeat(64) }));
  delete h.manifest.coordinator;
  assert.throws(() => coordinator({ ...h.dependencies, expectedManifestSha256: hash(canonical(h.manifest)) }));
});

test('coordinator stable purpose key excludes delivery and generation; exact pilot claim only', async () => {
  const h = await setup(); await tick(h);
  const expected = buildCoordinatorPhaseKey({ runId: h.state.run.runId, manifestSha256: h.state.run.manifestHash, purpose: 'initial_tests', repairCycle: 0, headSha: h.manifest.base.revision, findingSha256: null });
  assert.equal(h.state.phase.key, expected);
  const claim = h.state.calls.find(call => call[0] === 'claimTick')[1].manifest;
  assert.equal(claim.issueNumber, 22); assert.equal(claim.actorId, 42);
});

test('coordinator duplicate and busy claims map only to Function statuses without model', async () => {
  const h = await setup(); const d = delivery(); await h.coordinator.advanceTick(d);
  assert.equal((await h.coordinator.advanceTick(d)).status, 'duplicate');
  h.state.claimHook = () => ({ status: 'busy' });
  assert.equal((await tick(h)).status, 'duplicate');
  assert.equal(h.state.modelRequests, 0);
});

for (const outcome of ['success', null, 'uncertain']) {
  test(`coordinator restart: ${outcome} model without candidate is never reissued`, async () => {
    const h = await setup(); await tick(h); h.state.modelOperation = { operationId: 'lost', outcome };
    const result = await tick(h);
    assert.equal(result.status, 'needs_attention'); assert.equal(h.state.modelRequests, 0);
    assert.equal(h.state.stops.at(-1), outcome === 'success' ? 'coordinator_candidate_lost' : 'coordinator_model_uncertain');
  });
}

for (const reason of ['readiness_label_missing', 'issue_not_open', 'unavailable']) {
  test(`coordinator fresh approval: ${reason} distinct from uncertain reads`, async () => {
    const h = await setup(); h.state.approvalReason = reason;
    assert.equal((await tick(h)).status, reason === 'unavailable' ? 'needs_attention' : 'cancelled');
    assert.equal(h.state.modelRequests, 0);
  });
}

test('coordinator binding: mismatched leased intake identity stops before network/model', async () => {
  const h = await setup(); h.state.run.actorId = 999;
  assert.equal((await tick(h)).status, 'needs_attention');
  assert.equal(h.state.calls.some(call => call[0] === 'approvalHTTP'), false);
});

test('coordinator deadline: stalled claim cannot continue and every later store gets original deadline', async () => {
  const h = await setup(); await through(h, 'waiting_red_ci');
  h.state.calls.length = 0; h.state.checkStatus = 'waiting'; await tick(h);
  for (const call of h.state.calls) {
    if (['snapshot', 'checkpoint', 'reserveModelCall', 'recordModelCallOutcome', 'finishRun'].includes(call[0])) assert.equal(call.at(-1).deadline, h.state.deadline);
  }
  const late = await harness(); let resolve;
  late.state.claimHook = () => new Promise(done => { resolve = done; });
  const c = coordinator({ ...late.dependencies, timeoutMs: 15 });
  assert.equal((await c.advanceTick(delivery())).status, 'needs_attention');
  resolve({ status: 'claimed', lease: {}, deadline: Date.now() + 50000 });
  await new Promise(done => setImmediate(done));
  assert.equal(late.state.calls.length, 1);
});

test('coordinator uncertain checkpoint acknowledgment has no compensating terminal write', async () => {
  const h = await setup(); h.state.checkpointHook = () => { throw new Error('private DB response'); };
  const result = await tick(h);
  assert.equal(result.reason, 'recovery_database_uncertain');
  assert.equal(result.persisted, false); assert.equal(h.state.stops.length, 0);
});

test('coordinator pending candidate: exclusive reconstruction path, absent effect never executes again', async () => {
  const h = await setup(); await tick(h);
  const candidate = prepareCandidate(candidateInput());
  h.state.modelOperation = { operationId: candidate.intent.coordinator.modelOperationId, outcome: 'success' };
  h.state.pendingOperation = { operationId: 'old-effect', ...candidate.intent };
  h.state.phase.pendingOperationId = 'old-effect';
  assert.equal((await tick(h)).status, 'needs_attention');
  assert.equal(h.state.modelRequests, 0); assert.equal(h.state.publications.length, 0);
  assert.equal(h.state.calls.filter(call => call[0] === 'reconstruct').length, 1);
});

test('coordinator expiry: wait timeout uses durable DB start and cannot extend', async () => {
  const h = await setup(); await through(h, 'waiting_ci');
  h.state.phase.waitStartedAt = new Date(Date.now() - 1801000).toISOString();
  assert.equal((await tick(h)).status, 'needs_attention');
  assert.equal(h.state.stops.at(-1), 'coordinator_wait_expired');
});

test('coordinator actual current review reader never authorizes readiness on a draft', async () => {
  const h = await harness();
  h.adapters.review = createReviewReader({ token: 'synthetic', repositoryId: h.manifest.repository.id,
    fetch: async url => {
      const path = new URL(url).pathname;
      if (path.endsWith('/reviews') || path.endsWith('/comments')) return Response.json([]);
      assert.equal(path, '/repos/randoneering/mellon/pulls/77');
      return Response.json({ number: 77, state: 'open', draft: true,
        base: { repo: { id: h.manifest.repository.id } },
        head: { sha: h.state.run.expectedHeadSha } });
    } });
  h.coordinator = coordinator(h.dependencies); await through(h, 'waiting_review'); h.state.checkStatus = 'success';
  assert.equal((await tick(h)).status, 'waiting');
});

test('legacy coordinator never reads maintainer fallback or publishes the command', async () => {
  const h = await setup();
  await through(h, 'waiting_review');
  h.state.reviewResult = syntheticFutureReview(h.state);
  let maintainerReads = 0;
  h.adapters.review.readMaintainerReview = async () => { maintainerReads += 1; };
  const result = await tick(h);
  assert.equal(result.status, 'ready_for_human');
  assert.equal(maintainerReads, 0);
  assert.equal(h.state.calls.some(call => call[0] === 'reserveReviewRequest'), false);
  assert.equal(h.state.calls.some(call => call[0] === 'attemptReviewRequest'), false);
});

test('coordinator SYNTHETIC FUTURE Qodo: completed authenticated empty findings and fresh checks finish still draft', async () => {
  const h = await setup(); await through(h, 'waiting_review'); h.state.checkStatus = 'success';
  h.state.reviewResult = syntheticFutureReview(h.state);
  assert.equal((await tick(h)).status, 'ready_for_human');
  assert.equal(h.state.publications.length, 3);
});

for (const field of ['headSha', 'repositoryId', 'pullNumber', 'draft', 'state', 'authenticated']) {
  test(`coordinator SYNTHETIC FUTURE Qodo closed binding rejects ${field}`, async () => {
    const h = await setup(); await through(h, 'waiting_review'); h.state.checkStatus = 'success';
    h.state.reviewResult = { ...syntheticFutureReview(h.state), [field]: false };
    assert.equal((await tick(h)).status, 'needs_attention');
  });
}

test('coordinator SYNTHETIC FUTURE Qodo repairs: durable reservation precedes tests, full prepared indexes, one existing draft', async () => {
  const h = await setup(); await through(h, 'waiting_review');
  for (let repair = 1; repair <= 2; repair += 1) {
    h.state.checkStatus = 'success';
    const assertion = h.checksResult('failure').evidence.assertions[0];
    h.state.reviewResult = syntheticFutureReview(h.state, [{ findingSha256: hash(`synthetic-future-${repair}`), assertions: [assertion] }]);
    assert.equal((await tick(h)).status, 'advanced');
    assert.equal(h.state.phase.purpose, 'repair_investigation');
    const before = h.state.modelRequests;
    assert.equal((await tick(h)).status, 'advanced');
    assert.equal(h.state.phase.purpose, 'repair_tests');
    assert.equal(h.state.modelRequests, before);
    await through(h, 'waiting_review');
    const context = h.state.contexts.find(item => item.investigation?.findingSha256 === hash(`synthetic-future-${repair}`));
    assert.equal(context.investigation.regressionFileIndex, 3);
    assert.equal(context.investigation.references[0].fileIndex, 3);
    assert.equal(h.state.phase.investigation, undefined);
  }
  assert.equal(h.state.modelRequests, 6);
  assert.equal(h.state.publications.filter(request => request.intent.kind === 'pr_create').length, 1);
  h.state.reviewResult = syntheticFutureReview(h.state, [{ findingSha256: hash('third'), assertions: [h.checksResult('failure').evidence.assertions[0]] }]);
  assert.equal((await tick(h)).status, 'needs_attention');
  assert.equal(h.state.run.repairCycleCount, 2);
});

for (const disposition of ['suspected_false_positive', 'scope_change', 'insufficient_evidence']) {
  test(`coordinator repair assessment: ${disposition} stops without publishing`, async () => {
    const h = await setup(); await through(h, 'waiting_ci'); h.state.checkStatus = 'needs_attention';
    assert.equal((await tick(h)).status, 'advanced');
    await tick(h); h.state.disposition = disposition;
    const before = h.state.publications.length;
    assert.equal((await tick(h)).status, 'needs_attention');
    assert.equal(h.state.publications.length, before);
  });
}
