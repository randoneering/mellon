import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createRecoveryCoordinator } from '../../src/automation/worker/recovery.mjs';
import { validateChanges } from '../../src/automation/worker/patch.mjs';
import { buildDraftPrOperationHash, buildOperationHash, validationBaseFromTree } from '../../src/automation/worker/publication-validation.mjs';
import {
  BASE_SHA, COMMIT_SHA, CHANGE_PATH, RUN_ID, TOKEN, createPublisherFixture, createDraftPrFixture,
} from '../fixtures/agent-worker-publication.mjs';

function harness(options = {}) {
  const fixture = (options.draftPr ? createDraftPrFixture : createPublisherFixture)(options);
  // Keep fixture timestamps from crossing a millisecond between related expiries.
  fixture.context.signingPreflight.expiresAt = fixture.context.contextExpiresAt;
  const { request } = fixture;
  const lease = {
    runId: RUN_ID, jobId: randomUUID(), repositoryId: request.run.repositoryId,
    repositoryFullName: 'randoneering/mellon', issueId: request.run.issueId,
    issueNumber: request.run.issueNumber, actorId: request.run.approverId,
    generation: 1, token: randomUUID(), expiresAt: new Date(Date.now() + 180000).toISOString(),
  };
  const intent = {
    key: request.intent.id, kind: options.draftPr ? 'pr_create' : 'commit_create',
    expectedHeadSha: request.run.expectedHeadSha,
    inputHash: options.draftPr ? buildDraftPrOperationHash(request) : buildOperationHash(request, validateChanges(
      validationBaseFromTree(new Map(), [CHANGE_PATH]), request.proposedChanges,
      { allowedPaths: request.approvedManifest.allowedPaths,
        pilotScope: request.approvedManifest.pilotScope })),
  };
  const state = { operation: options.existing ? { ...intent } : null, phases: new Set(),
    confirmed: null, attention: null, stale: false, calls: [] };
  const store = {
    async getRun() {
      state.calls.push('read');
      return { manifestHash: request.run.manifestSha256, baseRevision: BASE_SHA,
        policyRevision: request.approvedManifest.policyRevision };
    },
    async putIntent(value, input) {
      state.calls.push('intent');
      if (options.intentFault === 'before') throw new Error(TOKEN);
      const existing = state.operation;
      state.operation ??= { ...input };
      if (options.intentFault === 'after') throw new Error(TOKEN);
      return { status: options.conflict ? 'conflict' : existing ? 'existing' : 'created',
        operation: { operationId: randomUUID(), ...state.operation } };
    },
    async fenceIntent(value, input, phase) {
      state.calls.push(`fence:${phase}`);
      if (state.stale || options.staleAt === phase) return { status: 'stale' };
      if (options.fenceFault === phase) throw new Error(TOKEN);
      const used = state.phases.has(phase);
      if (phase !== 'probe') state.phases.add(phase);
      return { status: 'owned', decision: used ? 'reconcile_only' : 'execute' };
    },
    async confirmIntent(value, input, proof) {
      state.calls.push('confirm');
      if (options.confirmFault === 'before') throw new Error(TOKEN);
      if (state.stale) return false;
      state.confirmed = proof.commitSha ?? proof.prNumber;
      if (options.confirmFault === 'after') throw new Error(TOKEN);
      return true;
    },
    async finishRun(value, status, result) {
      state.calls.push('attention');
      if (state.stale) return false;
      state.attention = result.blockerCode;
      return true;
    },
  };
  const dependencies = { ...fixture.dependencies };
  const approval = dependencies.checkApproval;
  dependencies.checkApproval = async input => {
    state.calls.push('approval');
    if (options.staleAfterApproval) state.stale = true;
    if (options.approvalDenied) return { authorized: false };
    return approval(input);
  };
  return { fixture, store, state, lease, intent,
    input: { lease, intent, publication: request, deadline: Date.now() + 90000 },
    coordinator: createRecoveryCoordinator({ store, publicationDependencies: dependencies }) };
}

for (const options of [{}, { loseBranchAck: true }, { loseCommitAck: true }]) {
  test(`durable intent precedes fixed publisher and verified confirmation ${JSON.stringify(options)}`, async () => {
    const h = harness(options);
    const result = await h.coordinator.perform(h.input);
    assert.equal(result.status, 'confirmed');
    assert.equal(h.state.confirmed, COMMIT_SHA);
    assert.equal(h.fixture.state.branchWrites, 1);
    assert.equal(h.fixture.state.commitWrites, 1);
    assert.ok(h.state.calls.indexOf('intent') < h.state.calls.indexOf('fence:branch'));
    assert.ok(h.state.calls.indexOf('fence:commit') < h.state.calls.indexOf('confirm'));
  });
}

for (const fault of ['before', 'after']) {
  test(`uncertain intent acknowledgment ${fault} commit never authorizes remote effects`, async () => {
    const h = harness({ intentFault: fault });
    const result = await h.coordinator.perform(h.input);
    assert.equal(result.reason, 'recovery_database_uncertain');
    assert.equal(result.persisted, false);
    assert.equal(h.fixture.state.branchWrites + h.fixture.state.commitWrites, 0);
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
  });
  test(`uncertain confirmation ${fault} commit cannot replay branch or commit`, async () => {
    const h = harness({ confirmFault: fault });
    assert.equal((await h.coordinator.perform(h.input)).reason, 'recovery_database_uncertain');
    assert.equal((await h.coordinator.perform(h.input)).reason, 'recovery_database_uncertain');
    assert.equal(h.fixture.state.branchWrites, 1);
    assert.equal(h.fixture.state.commitWrites, 1);
  });
}

test('existing intent reconciles exact publisher proof without writing', async () => {
  const h = harness({ existing: true, initialBranchHead: COMMIT_SHA });
  assert.equal((await h.coordinator.perform(h.input)).status, 'confirmed');
  assert.equal(h.fixture.state.branchWrites + h.fixture.state.commitWrites, 0);
});

for (const options of [
  { existing: true },
  { existing: true, initialBranchHead: '9'.repeat(40) },
  { existing: true, initialBranchHead: COMMIT_SHA, wrongSignature: true },
  { commitDoesNotApply: true, loseCommitAck: true },
  { branchCreateDoesNotApply: true },
]) {
  test(`uncertain or foreign effect is never blindly replayed ${JSON.stringify(options)}`, async () => {
    const h = harness(options);
    assert.equal((await h.coordinator.perform(h.input)).status, 'needs_attention');
    assert.equal(h.state.confirmed, null);
    assert.equal(h.state.attention, 'recovery_effect_unconfirmed');
    assert.ok(h.fixture.state.branchWrites <= 1);
    assert.ok(h.fixture.state.commitWrites <= 1);
    if (options.existing) assert.equal(h.fixture.state.commitWrites, 0);
  });
}

for (const options of [
  { staleAt: 'branch' }, { staleAt: 'commit' }, { staleAfterApproval: true },
  { approvalDenied: true }, { fenceFault: 'branch' }, { conflict: true },
]) {
  test(`fresh authorization and committed fence are required ${JSON.stringify(options)}`, async () => {
    const h = harness(options);
    assert.equal((await h.coordinator.perform(h.input)).status, 'needs_attention');
    assert.equal(h.fixture.state.commitWrites, 0);
    if (options.staleAt !== 'commit') assert.equal(h.fixture.state.branchWrites, 0);
  });
}

test('concurrent duplicate invocations create one branch and one commit', async () => {
  const h = harness();
  const results = await Promise.all([h.coordinator.perform(h.input), h.coordinator.perform(h.input)]);
  assert.ok(results.some(result => result.status === 'confirmed'));
  assert.equal(h.fixture.state.branchWrites, 1);
  assert.equal(h.fixture.state.commitWrites, 1);
});

for (const kind of ['branch_create', 'model_call']) {
  test(`unsupported typed effect ${kind} stops without a remote request`, async () => {
    const h = harness();
    h.input.intent = { ...h.intent, kind };
    const result = await h.coordinator.perform(h.input);
    assert.equal(result.reason, 'recovery_unsupported_effect');
    assert.equal(h.fixture.calls.length, 0);
  });
}

for (const options of [{}, { losePrAck: true }, { confirmFault: 'before' }, { confirmFault: 'after' }]) {
  test(`PR recovery uses exact fixed adapter proof without duplicate creation ${JSON.stringify(options)}`, async () => {
    const h = harness({ draftPr: true, ...options });
    const first = await h.coordinator.perform(h.input);
    assert.equal(first.status, options.confirmFault ? 'needs_attention' : 'confirmed');
    if (options.confirmFault) assert.equal(first.reason, 'recovery_database_uncertain');
    assert.equal(h.fixture.state.prWrites, 1);
    const second = await h.coordinator.perform(h.input);
    assert.equal(second.status, options.confirmFault ? 'needs_attention' : 'confirmed');
    assert.equal(h.fixture.state.prWrites, 1);
    assert.ok(h.state.calls.indexOf('intent') < h.state.calls.indexOf('fence:pr'));
  });
}

for (const options of [
  { existing: true }, { losePrAck: true, prDoesNotApply: true },
  { createdPr: pr => ({ ...pr, draft: false }) }, { staleAt: 'pr' },
]) {
  test(`PR uncertainty or lease loss never replays ${JSON.stringify(options)}`, async () => {
    const h = harness({ draftPr: true, ...options });
    assert.equal((await h.coordinator.perform(h.input)).status, 'needs_attention');
    assert.equal(h.state.confirmed, null);
    assert.ok(h.fixture.state.prWrites <= 1);
    if (options.existing || options.staleAt) assert.equal(h.fixture.state.prWrites, 0);
  });
}

test('caller cannot substitute another lease, intent, or unapproved manifest', async () => {
  for (const mutate of [
    h => { h.input.lease = { ...h.lease, issueId: h.lease.issueId + 1 }; },
    h => { h.input.intent = { ...h.intent, key: '0'.repeat(64) }; },
    h => { h.input.publication.run.manifestSha256 = '0'.repeat(64); },
    h => { h.input.intent = { ...h.intent, privateText: TOKEN }; },
  ]) {
    const h = harness();
    mutate(h);
    assert.equal((await h.coordinator.perform(h.input)).status, 'needs_attention');
    assert.equal(h.fixture.calls.length, 0);
  }
});

for (const method of ['getRun', 'putIntent', 'fenceIntent', 'confirmIntent', 'finishRun']) {
  test(`aggregate recovery deadline bounds ${method} and suppresses late continuation`, async t => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    const h = harness(method === 'finishRun' ? { approvalDenied: true } : {});
    let resolve;
    let entered = false;
    const stalled = new Promise(yes => { resolve = yes; });
    const original = h.store[method];
    h.store[method] = (...args) => {
      entered = true;
      // Expire only after this database boundary starts, not during cold setup.
      queueMicrotask(() => t.mock.timers.tick(26));
      return stalled.then(() => original(...args));
    };
    const coordinator = createRecoveryCoordinator({ store: h.store,
      publicationDependencies: h.fixture.dependencies, timeoutMs: 25 });
    if (method === 'finishRun') {
      h.fixture.dependencies.checkApproval = async () => ({ authorized: false });
    }
    let timer;
    const result = await Promise.race([
      coordinator.perform(h.input),
      new Promise(yes => { timer = realSetTimeout(() => yes(null), 5000); }),
    ]);
    realClearTimeout(timer);
    assert.ok(result, 'recovery must return without waiting for the stalled database promise');
    assert.equal(entered, true);
    assert.equal(result.reason, 'recovery_database_uncertain');
    assert.equal(result.persisted, false);
    const writes = [h.fixture.state.branchWrites, h.fixture.state.commitWrites];
    resolve();
    await new Promise(yes => setImmediate(yes));
    assert.deepEqual([h.fixture.state.branchWrites, h.fixture.state.commitWrites], writes);
    if (['getRun', 'putIntent', 'fenceIntent'].includes(method)) {
      assert.equal(h.state.confirmed, null);
      assert.equal(h.state.attention, null);
      assert.deepEqual(writes, [0, 0]);
    }
    assert.equal(h.state.calls.filter(call => call === 'attention').length,
      method === 'finishRun' ? 1 : 0);
  });
}

test('recovery clamps publication to the remaining lease and stops ignored fetch cancellation', async () => {
  const h = harness();
  h.input.lease = { ...h.lease, expiresAt: new Date(Date.now() + 35).toISOString() };
  const original = h.fixture.dependencies.fetch;
  let resolve;
  let entered = false;
  const stalled = new Promise(yes => { resolve = yes; });
  const dependencies = { ...h.fixture.dependencies, fetch: (...args) => {
    entered = true;
    return stalled.then(() => original(...args));
  } };
  const coordinator = createRecoveryCoordinator({ store: h.store,
    publicationDependencies: dependencies, timeoutMs: 200 });
  const result = await coordinator.perform(h.input);
  assert.equal(entered, true);
  assert.equal(result.reason, 'recovery_deadline');
  assert.equal(result.persisted, false);
  resolve();
  await new Promise(yes => setTimeout(yes, 20));
  assert.equal(h.fixture.state.branchWrites, 0);
  assert.equal(h.fixture.state.commitWrites, 0);
  assert.equal(h.state.confirmed, null);
  assert.equal(h.state.attention, null);
});

test('recovery uses one aggregate deadline rather than restarting it at each store call', async () => {
  const h = harness();
  let connections = 0;
  for (const method of ['getRun', 'putIntent', 'fenceIntent']) {
    const original = h.store[method];
    h.store[method] = async (...args) => {
      connections += 1;
      await new Promise(resolve => setTimeout(resolve, 20));
      return original(...args);
    };
  }
  const coordinator = createRecoveryCoordinator({ store: h.store,
    publicationDependencies: h.fixture.dependencies, timeoutMs: 30 });
  const result = await coordinator.perform(h.input);
  assert.equal(result.reason, 'recovery_database_uncertain');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(connections, 2);
  assert.equal(h.fixture.state.branchWrites, 0);
  assert.equal(h.state.attention, null);
});

for (const [phase, options] of [['commit', {}], ['pr', { draftPr: true }],
  ['probe', { existing: true }]]) {
  test(`late ${phase} database fence cannot initiate another remote effect or local write`, async () => {
    const h = harness(options);
    let resolve;
    let entered = false;
    const stalled = new Promise(yes => { resolve = yes; });
    const original = h.store.fenceIntent;
    h.store.fenceIntent = async (...args) => {
      if (args[2] === phase) { entered = true; await stalled; }
      return original(...args);
    };
    const coordinator = createRecoveryCoordinator({ store: h.store,
      publicationDependencies: h.fixture.dependencies, timeoutMs: 60 });
    const result = await coordinator.perform(h.input);
    assert.equal(entered, true);
    assert.equal(result.reason, 'recovery_database_uncertain');
    assert.equal(result.persisted, false);
    const counts = [h.fixture.state.branchWrites, h.fixture.state.commitWrites,
      h.fixture.state.prWrites];
    resolve();
    await new Promise(yes => setTimeout(yes, 15));
    assert.deepEqual([h.fixture.state.branchWrites, h.fixture.state.commitWrites,
      h.fixture.state.prWrites], counts);
    assert.equal(h.state.confirmed, null);
    assert.equal(h.state.attention, null);
  });
}

for (const field of ['tickDeadlineAt', 'runDeadlineAt', 'leaseExpiresAt']) {
  test(`recovery clamps all later work to the stored ${field}`, async () => {
    const h = harness();
    const original = h.store.getRun;
    h.store.getRun = async () => ({ ...await original(),
      [field]: new Date(Date.now() + 25).toISOString() });
    let resolve;
    const stalled = new Promise(yes => { resolve = yes; });
    const coordinator = createRecoveryCoordinator({ store: h.store,
      publicationDependencies: { ...h.fixture.dependencies, checkApproval: () => stalled },
      timeoutMs: 200 });
    const result = await coordinator.perform(h.input);
    assert.equal(result.reason, 'recovery_deadline');
    assert.equal(result.persisted, false);
    resolve({ authorized: true });
    await new Promise(yes => setTimeout(yes, 15));
    assert.equal(h.fixture.state.branchWrites, 0);
    assert.equal(h.fixture.state.commitWrites, 0);
    assert.equal(h.state.confirmed, null);
    assert.equal(h.state.attention, null);
  });
}

for (const deadline of [undefined, 'not-a-deadline', Date.now() - 1]) {
  test(`missing, invalid, or expired tick deadline cannot even read the database: ${deadline}`, async () => {
    const h = harness();
    h.input.deadline = deadline;
    const result = await h.coordinator.perform(h.input);
    assert.equal(result.status, 'needs_attention');
    assert.equal(result.persisted, false);
    assert.equal(result.reason, typeof deadline === 'number'
      ? 'recovery_deadline' : 'recovery_invalid_input');
    assert.deepEqual(h.state.calls, []);
    assert.equal(h.fixture.state.branchWrites, 0);
  });
}

test('the claimed tick deadline bounds even the first queued database read', async () => {
  const h = harness();
  let resolve;
  const stalled = new Promise(yes => { resolve = yes; });
  let entered = false;
  h.store.getRun = () => { entered = true; return stalled; };
  h.input.deadline = Date.now() + 25;
  const coordinator = createRecoveryCoordinator({ store: h.store,
    publicationDependencies: h.fixture.dependencies, timeoutMs: 200 });
  let timer;
  const result = await Promise.race([
    coordinator.perform(h.input),
    new Promise(yes => { timer = setTimeout(() => yes(null), 120); }),
  ]);
  clearTimeout(timer);
  assert.ok(result);
  assert.equal(entered, true);
  assert.equal(result.reason, 'recovery_database_uncertain');
  assert.equal(result.persisted, false);
  resolve(null);
  await new Promise(yes => setTimeout(yes, 15));
  assert.equal(h.fixture.state.branchWrites, 0);
  assert.equal(h.state.confirmed, null);
  assert.equal(h.state.attention, null);
});
