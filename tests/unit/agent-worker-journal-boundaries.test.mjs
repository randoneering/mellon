import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerStore } from '../../src/automation/worker/store.mjs';
import { validateCheckpoint, validateIntent } from '../../src/automation/worker/store-validation.mjs';
import { HEAD, HASH, MODEL_ID, OP_ID, lease, phase, phaseKey, row, descriptor, intent,
  operation, scripted } from '../fixtures/agent-worker-journal.mjs';

const SAFE = /Worker storage operation failed\./;

for (const method of ['getCoordinatorSnapshot', 'checkpoint', 'putIntent', 'beginRepair']) {
  test(`${method} rejects database-expired tick without writing`, async () => {
    const h = scripted([{ sql: /SELECT runs\.\*/, rows: [row({ tick_deadline_at: '2000-01-01T00:00:00.000Z' })] }]);
    const args = method === 'checkpoint' ? [{ state: 'generating_tests', coordinator: phase() }]
      : method === 'putIntent' ? [intent()] : method === 'beginRepair'
        ? [{ key: HASH, source: 'ci', headSha: HEAD, findingSha256: HASH }] : [];
    const result = await h.store[method](lease, ...args);
    assert.equal(method === 'checkpoint' ? result : result.status, method === 'checkpoint' ? false : 'stale');
    assert.equal(h.calls.some(call => /^\s*(INSERT|UPDATE)/.test(call.text)), false);
    h.done();
  });
}

for (const method of ['getCoordinatorSnapshot', 'beginRepair', 'putIntent', 'checkpoint']) {
  test(`${method} shares the existing total acquisition deadline and disposes late clients`, async () => {
    let resolve;
    let releases = 0;
    let queries = 0;
    const store = createWorkerStore({ connect: () => new Promise(done => { resolve = done; }) }, { timeoutMs: 15 });
    const args = method === 'checkpoint' ? [{ state: 'generating_tests', coordinator: phase() }]
      : method === 'putIntent' ? [intent()] : method === 'beginRepair'
        ? [{ key: HASH, source: 'ci', headSha: HEAD, findingSha256: HASH }] : [];
    await assert.rejects(store[method](lease, ...args), SAFE);
    resolve({ async query() { queries += 1; }, release(error) { assert.ok(error); releases += 1; } });
    await new Promise(done => setImmediate(done));
    assert.equal(releases, 1);
    assert.equal(queries, 0);
  });
}

test('a snapshot exposes unknown and lost-success model outcomes without fresh execution permission', async () => {
  for (const outcome of [null, 'uncertain', 'success']) {
    const h = scripted([
      { sql: /SELECT runs\.\*/, rows: [row()] },
      { sql: /FROM agent_worker.operations/, rows: [operation({ kind: 'model_call', operation_id: MODEL_ID, outcome_code: outcome })] },
    ]);
    const result = await h.store.getCoordinatorSnapshot(lease);
    assert.equal(result.pendingOperation, null);
    assert.equal(result.modelOperation.outcome, outcome);
    assert.equal(Object.hasOwn(result.modelOperation, 'canExecute'), false);
    h.done();
  }
});

test('publication descriptors remain bound on existing intent and changed purpose cannot rekey it', async () => {
  const i = intent();
  const h = scripted([
    { sql: /SELECT runs\.\*/, rows: [row({ pending_operation_id: OP_ID })] },
    { sql: /FROM agent_worker.operations/, rows: [operation({ kind: 'model_call', operation_id: MODEL_ID, outcome_code: 'success' })] },
    { sql: /INSERT INTO agent_worker.operations/, rows: [] },
    { sql: /FROM agent_worker.operations/, rows: [operation()] },
    { sql: /FROM agent_worker.candidate_descriptors/, rows: [{ approved_path_index: 0, change_kind: 'create', before_blob_sha: null, after_blob_sha: HEAD, content_sha256: HASH, byte_count: 101, file_mode: '100644' }] },
  ]);
  assert.equal((await h.store.putIntent(lease, i)).status, 'conflict');
  h.done();
  const changed = intent();
  changed.coordinator.purpose = 'initial_implementation';
  const changedHarness = scripted([{ sql: /SELECT runs\.\*/, rows: [row({ pending_operation_id: OP_ID })] }]);
  assert.equal((await changedHarness.store.putIntent(lease, changed)).status, 'conflict');
  changedHarness.done();
});

test('same-phase polling cannot erase or replace selected evidence hashes', async () => {
  const h = scripted([{ sql: /SELECT runs\.\*/, rows: [row({ state: 'waiting_red_ci',
    regression_workflow_id: 7, regression_test_sha256: HASH, regression_proposal_sha256: HASH,
    criterion_sha256: HASH })] }]);
  await assert.rejects(h.store.checkpoint(lease, { state: 'waiting_red_ci',
    coordinator: { ...phase(), expectedRegression: null } }), SAFE);
  h.done();
});

test('checkpoint cannot manufacture a wait before a durable effect confirmation', async () => {
  const h = scripted([{ sql: /SELECT runs\.\*/, rows: [row()] }]);
  await assert.rejects(h.store.checkpoint(lease, { state: 'waiting_red_ci', coordinator: phase() }), SAFE);
  h.done();
});

test('checkpoint cannot skip a model phase directly from RED to waiting for green', async () => {
  const h = scripted([{ sql: /SELECT runs\.\*/, rows: [row({ state: 'waiting_red_ci' })] }]);
  await assert.rejects(h.store.checkpoint(lease, { state: 'waiting_ci', coordinator: phase('initial_implementation') }), SAFE);
  h.done();
});

test('candidate insertion failure rolls back without a pending reference or COMMIT', async () => {
  const h = scripted([
    { sql: /SELECT runs\.\*/, rows: [row()] },
    { sql: /FROM agent_worker.operations/, rows: [operation({ kind: 'model_call', operation_id: MODEL_ID, outcome_code: 'success' })] },
    { sql: /INSERT INTO agent_worker.operations/, rows: [operation()] },
    { sql: /INSERT INTO agent_worker.candidate_descriptors/, error: new Error('private detail') },
  ]);
  await assert.rejects(h.store.putIntent(lease, intent()), SAFE);
  assert.equal(h.calls.some(call => call.text === 'ROLLBACK'), true);
  assert.equal(h.calls.some(call => call.text === 'COMMIT'), false);
  assert.equal(h.calls.some(call => /^\s*UPDATE agent_worker.runs/.test(call.text)), false);
  h.done();
});

test('the closed journal accepts exact byte limits and rejects mutable timestamps and bad rounds', () => {
  const i = intent();
  i.coordinator.candidateDescriptors = Array.from({ length: 4 }, (_, approvedPathIndex) => descriptor({ approvedPathIndex, bytes: 65536 }));
  assert.equal(validateIntent(i).coordinator.candidateDescriptors.length, 4);
  for (const extra of [{ repairCycle: 1 }, { phaseStartedAt: 'now' }, { pendingOperationId: OP_ID }, { findingSha256: 'private' }]) {
    assert.throws(() => validateCheckpoint({ state: 'generating_tests', coordinator: { ...phase(), ...extra } }), SAFE);
  }
});

for (const bad of [{ phase_purpose: 'initial_implementation' }, { phase_round: 1 }]) {
  test(`model candidate must match recorded phase purpose and round ${JSON.stringify(bad)}`, async () => {
    const h = scripted([
      { sql: /SELECT runs\.\*/, rows: [row()] },
      { sql: /FROM agent_worker.operations/, rows: [operation({ operation_id: MODEL_ID, kind: 'model_call', outcome_code: 'success', ...bad })] },
    ]);
    assert.equal((await h.store.putIntent(lease, intent())).status, 'conflict');
    h.done();
  });
}

test('implementation intents cannot replace the selected regression or criterion', async () => {
  const p = phase('initial_implementation');
  const i = intent();
  i.coordinator.purpose = p.purpose;
  i.coordinator.phaseKey = p.key;
  i.coordinator.expectedRegression = null;
  const h = scripted([{ sql: /SELECT runs\.\*/, rows: [row({ state: 'implementing',
    phase_purpose: p.purpose, phase_key: p.key,
    regression_workflow_id: 7, regression_test_sha256: HASH, regression_proposal_sha256: HASH,
    criterion_sha256: HASH })] }]);
  assert.equal((await h.store.putIntent(lease, i)).status, 'conflict');
  h.done();
});

test('journal human stops retain SQL-authoritative tick and run expiry checks', async () => {
  const h = scripted([
    { sql: /SELECT runs\.\*/, rows: [row()] },
    { sql: /FROM agent_worker.operations/, rows: [operation({ kind: 'model_call', outcome_code: 'success' })] },
    { sql: /UPDATE agent_worker.runs/, rows: [], check(values, sql) {
      assert.match(sql, /tickDeadlineSeconds/);
      assert.match(sql, /runLifetimeSeconds/);
    } },
  ]);
  assert.deepEqual(await h.store.reserveModelCall(lease, { key: HASH, inputHash: HASH,
    expectedHeadSha: HEAD, inputTokens: 1, outputTokens: 1 }), { status: 'stale', canExecute: false });
  h.done();
});

test('legacy intent shape cannot bypass the journal on a coordinator row', async () => {
  const i = intent();
  delete i.coordinator;
  const h = scripted([{ sql: /SELECT runs\.\*/, rows: [row()] }]);
  assert.equal((await h.store.putIntent(lease, i)).status, 'conflict');
  h.done();
});

test('phase transitions cannot overwrite authenticated finding and prior evidence references', async () => {
  const p = phase('repair_tests', 1, HASH);
  const h = scripted([{ sql: /SELECT runs\.\*/, rows: [row({ state: 'repairing',
    repair_cycle_count: 1, phase_round: 1, phase_purpose: 'repair_investigation',
    phase_key: phaseKey('repair_investigation', 1, HASH), finding_sha256: HASH,
    finding_source: 'ci', finding_head_sha: HEAD, prior_check_run_id: 99 })] }]);
  await assert.rejects(h.store.checkpoint(lease, { state: 'repairing', coordinator: {
    ...p, findingSource: 'qodo', findingHeadSha: 'f'.repeat(40) } }), SAFE);
  h.done();
});

test('coordinator checkpoints retain narrowly typed legacy update fields', async () => {
  const h = scripted([
    { sql: /SELECT runs\.\*/, rows: [row()] },
    { sql: /UPDATE agent_worker.runs/, rows: [{ run_id: lease.runId, generation: 1 }], check(values, sql) {
      assert.match(sql, /last_check_run_id = CASE/);
      assert.match(sql, /branch_name = CASE/);
      assert.ok(values.includes(77));
      assert.ok(values.includes(`agent-work/${lease.runId}`));
    } },
  ]);
  assert.equal(await h.store.checkpoint(lease, { state: 'generating_tests', coordinator: phase(),
    lastCheckRunId: 77, branchName: `agent-work/${lease.runId}` }), true);
  h.done();
});

test('a confirmed draft cannot rewind its same phase back into publication', async () => {
  const h = scripted([{ sql: /SELECT runs\.\*/, rows: [row({ state: 'waiting_review',
    phase_purpose: 'draft_pr', phase_key: phaseKey('draft_pr'), pull_request_number: 42 })] }]);
  await assert.rejects(h.store.checkpoint(lease, { state: 'opening_pr', coordinator: phase('draft_pr') }), SAFE);
  h.done();
});

test('lost investigation result cannot be carried into a fresh tests-phase model opportunity', async () => {
  const h = scripted([
    { sql: /SELECT runs\.\*/, rows: [row({ state: 'repairing', phase_purpose: 'repair_investigation',
      repair_cycle_count: 1, phase_round: 1, phase_key: phaseKey('repair_investigation', 1, HASH),
      finding_sha256: HASH, finding_source: 'ci', finding_head_sha: HEAD })] },
    { sql: /FROM agent_worker.operations/, rows: [operation({ kind: 'model_call', outcome_code: 'success' })] },
    { sql: /UPDATE agent_worker.runs/, rows: [{ run_id: lease.runId, generation: 1 }], check(values) {
      assert.ok(values.includes('coordinator_candidate_lost'));
    } },
  ]);
  assert.equal(await h.store.checkpoint(lease, { state: 'repairing', coordinator: phase('repair_tests', 1, HASH) }), false);
  h.done();
});

test('green repair reopens the review wait on the existing draft without creating another PR intent', async () => {
  const h = scripted([
    { sql: /SELECT runs\.\*/, rows: [row({ state: 'waiting_ci', phase_purpose: 'repair_implementation',
      repair_cycle_count: 1, phase_round: 1, phase_key: phaseKey('repair_implementation', 1, HASH),
      finding_sha256: HASH, finding_source: 'qodo', finding_head_sha: HEAD,
      pull_request_number: 42 })] },
    { sql: /UPDATE agent_worker.runs/, rows: [{ run_id: lease.runId, generation: 1 }], check(values, sql) {
      assert.equal(values[7], 'waiting_review');
      assert.match(sql, /wait_started_at = CASE/);
      assert.match(sql, /clock_timestamp\(\)/);
      assert.ok(values.includes(phaseKey('draft_pr', 1, HASH)));
    } },
  ]);
  assert.equal(await h.store.checkpoint(lease, { state: 'waiting_review', coordinator: phase('draft_pr', 1, HASH) }), true);
  assert.equal(h.calls.some(call => /INSERT INTO agent_worker.operations/.test(call.text)), false);
  h.done();
});

test('new model reservation binds the existing phase without refreshing the tick deadline', async () => {
  const deadline = new Date(Date.now() + 45000).toISOString();
  const h = scripted([
    { sql: /SELECT runs\.\*/, rows: [row({ model_call_count: 0 })] },
    { sql: /FROM agent_worker.operations/, rows: [] },
    { sql: /FROM agent_worker.operations/, rows: [] },
    { sql: /FROM agent_worker.operations/, rows: [] },
    { sql: /FROM agent_worker.operations/, rows: [] },
    { sql: /INSERT INTO agent_worker.operations/, rows: [{ operation_id: MODEL_ID, call_deadline_at: deadline }], check(values, sql) {
      assert.match(sql, /coordinator_version, phase_purpose, phase_key, phase_round/);
      assert.match(sql, /runs\.lease_started_at/);
      assert.match(sql, /runs\.created_at/);
      assert.deepEqual(values.slice(-3), ['initial_tests', phaseKey(), 0]);
    } },
    { sql: /UPDATE agent_worker.runs/, rows: [{ run_id: lease.runId }], check(values, sql) {
      assert.doesNotMatch(sql, /SET[^;]*lease_started_at\s*=/);
      assert.doesNotMatch(sql, /wait_started_at\s*=/);
    } },
  ]);
  const result = await h.store.reserveModelCall(lease, { key: HASH, inputHash: HASH,
    expectedHeadSha: HEAD, inputTokens: 10, outputTokens: 10 });
  assert.equal(result.status, 'reserved');
  assert.equal(result.canExecute, true);
  assert.equal(result.deadlineAt, deadline);
  h.done();
});

test('stable phase identity does not contain the delivery or fencing generation', async () => {
  for (const generation of [1, 2]) {
    const h = scripted([
      { sql: /SELECT runs\.\*/, rows: [row({ generation, state: 'waiting_red_ci', expected_head_sha: 'd'.repeat(40) })] },
      { sql: /UPDATE agent_worker.runs/, rows: [{ run_id: lease.runId, generation }], check(values) {
        assert.equal(values[6], phaseKey());
      } },
    ]);
    assert.equal(await h.store.checkpoint({ ...lease, generation }, { state: 'waiting_red_ci', coordinator: phase() }), true);
    h.done();
  }
});
