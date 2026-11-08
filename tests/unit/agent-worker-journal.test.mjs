import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCheckpoint, validateIntent } from '../../src/automation/worker/store-validation.mjs';
import { HEAD, HASH, MODEL_ID, OP_ID, lease, phase, phaseKey, row, descriptor,
  intent, operation, scripted } from '../fixtures/agent-worker-journal.mjs';

const SAFE = /Worker storage operation failed\./;

test('closed journal metadata accepts hash-only candidates without changing legacy intents', () => {
  const i = intent();
  assert.deepEqual(validateIntent(i), i);
  const legacy = { key: i.key, kind: i.kind, inputHash: i.inputHash, expectedHeadSha: HEAD };
  assert.deepEqual(validateIntent(legacy), legacy);
  assert.deepEqual(validateCheckpoint({ state: 'generating_tests', coordinator: phase() }).coordinator, phase());
});

for (const [name, mutate] of [
  ['private text', i => { i.coordinator.patch = 'private'; }],
  ['empty descriptors', i => { i.coordinator.candidateDescriptors = []; }],
  ['excess descriptors', i => { i.coordinator.candidateDescriptors = Array.from({ length: 11 }, (_, approvedPathIndex) => descriptor({ approvedPathIndex })); }],
  ['duplicate indexes', i => { i.coordinator.candidateDescriptors.push(descriptor()); }],
  ['file too large', i => { i.coordinator.candidateDescriptors[0].bytes = 65537; }],
  ['total too large', i => { i.coordinator.candidateDescriptors = Array.from({ length: 5 }, (_, approvedPathIndex) => descriptor({ approvedPathIndex, bytes: 65536 })); }],
  ['path string', i => { i.coordinator.candidateDescriptors[0].path = 'private'; }],
  ['executable mode', i => { i.coordinator.candidateDescriptors[0].mode = '100755'; }],
  ['modify missing parent blob', i => { i.coordinator.candidateDescriptors[0].operation = 'modify'; }],
  ['create with parent blob', i => { i.coordinator.candidateDescriptors[0].beforeBlobSha = HEAD; }],
  ['unbound proposal', i => { i.coordinator.expectedRegression.proposalSha256 = 'd'.repeat(64); }],
  ['missing model reference', i => { i.coordinator.modelOperationId = null; }],
  ['unknown purpose', i => { i.coordinator.purpose = 'execute'; }],
]) {
  test(`journal rejects ${name}`, () => { const i = intent(); mutate(i); assert.throws(() => validateIntent(i), SAFE); });
}

test('snapshot returns typed phase and candidate descriptors, never operation internals', async () => {
  const h = scripted([
    { sql: /SELECT runs\.\*/, rows: [row({ pending_operation_id: OP_ID })] },
    { sql: /FROM agent_worker.operations/, rows: [operation({ operation_id: MODEL_ID, kind: 'model_call', outcome_code: 'success' }), operation()] },
    { sql: /FROM agent_worker.candidate_descriptors/, rows: [{ approved_path_index: 0, change_kind: 'create', before_blob_sha: null, after_blob_sha: HEAD, content_sha256: HASH, byte_count: 100, file_mode: '100644' }] },
  ]);
  const result = await h.store.getCoordinatorSnapshot(lease);
  assert.equal(result.status, 'owned');
  assert.equal(result.phase.key, phaseKey());
  assert.equal(result.modelOperation.outcome, 'success');
  assert.equal(result.pendingOperation.coordinator.candidateDescriptors[0].bytes, 100);
  assert.equal(Object.hasOwn(result.modelOperation, 'reserved_input_tokens'), false);
  h.done();
});

for (const method of ['getCoordinatorSnapshot', 'beginRepair']) {
  test(`${method} rejects stale ownership before any journal mutation`, async () => {
    const h = scripted([{ sql: /SELECT runs\.\*/, rows: [] }]);
    const result = await h.store[method](lease, ...(method === 'beginRepair' ? [{ key: HASH, source: 'ci', headSha: HEAD, findingSha256: HASH }] : []));
    assert.equal(result.status, 'stale');
    assert.equal(h.calls.some(call => /^\s*(UPDATE|INSERT)/.test(call.text)), false);
    h.done();
  });
}

for (const purpose of ['initial_tests', 'repair_tests', 'initial_implementation', 'repair_implementation', 'draft_pr']) {
  test(`persisted ${purpose} selects confirmation wait even before a later checkpoint`, async () => {
    const isPr = purpose === 'draft_pr';
    const cycle = purpose.startsWith('repair_') ? 1 : 0;
    const p = phase(purpose, cycle, cycle ? HASH : null);
    const i = intent({ kind: isPr ? 'pr_create' : 'commit_create' });
    // Confirmation trusts stored identity and purpose, not a caller's mutable journal.
    delete i.coordinator;
    const proof = isPr ? { status: 'confirmed', branch: `agent-work/${lease.runId}`, inputHash: HASH,
      baseSha: HEAD, branchHeadSha: HEAD, headSha: HEAD, prId: 7, prNumber: 8, prCount: 1, draft: true }
      : { status: 'confirmed', branch: `agent-work/${lease.runId}`, inputHash: HASH,
        baseSha: HEAD, parentSha: HEAD, commitSha: 'd'.repeat(40), treeSha: HEAD, branchHeadSha: 'd'.repeat(40) };
    const h = scripted([
      { sql: /SELECT runs\.\*/, rows: [row({ pending_operation_id: OP_ID,
        phase_purpose: purpose, phase_key: p.key, phase_round: cycle, repair_cycle_count: cycle,
        finding_sha256: cycle ? HASH : null, finding_source: cycle ? 'ci' : null,
        finding_head_sha: cycle ? HEAD : null })] },
      { sql: /FROM agent_worker.operations/, rows: [operation({ kind: i.kind,
        phase_purpose: purpose, phase_key: p.key, phase_round: cycle,
        model_operation_id: isPr ? null : MODEL_ID, descriptor_count: isPr ? null : 1 })] },
      { sql: /UPDATE agent_worker.operations/, rows: [] },
      { sql: /UPDATE agent_worker.runs/, rows: [{ run_id: lease.runId }], check(values, sql) {
        assert.equal(values[5], isPr ? 'waiting_review' : purpose.endsWith('_tests') ? 'waiting_red_ci' : 'waiting_ci');
        assert.match(sql, /wait_started_at/);
        assert.match(sql, /pending_operation_id = NULL/);
      } },
    ]);
    assert.equal(await h.store.confirmIntent(lease, i, proof), true);
    h.done();
  });
}

test('coordinator intent stores descriptors and pending reference in the same transaction', async () => {
  const h = scripted([
    { sql: /SELECT runs\.\*/, rows: [row()] },
    { sql: /FROM agent_worker.operations/, rows: [operation({ operation_id: MODEL_ID, kind: 'model_call', outcome_code: 'success' })] },
    { sql: /INSERT INTO agent_worker.operations/, rows: [operation()], check(values, sql) { assert.match(sql, /phase_purpose/); assert.match(sql, /descriptor_count/); assert.ok(values.includes('initial_tests')); } },
    { sql: /INSERT INTO agent_worker.candidate_descriptors/, rows: [] },
    { sql: /UPDATE agent_worker.runs/, rows: [{ run_id: lease.runId }], check(values, sql) { assert.match(sql, /pending_operation_id/); assert.ok(values.includes(OP_ID)); } },
  ]);
  const result = await h.store.putIntent(lease, intent());
  assert.equal(result.status, 'created');
  assert.deepEqual(result.operation.coordinator, intent().coordinator);
  assert.equal(h.calls.filter(call => call.text === 'COMMIT').length, 1);
  h.done();
});

for (const bad of [
  { run_id: '99999999-9999-4999-8999-999999999999' },
  { kind: 'commit_create' }, { expected_head_sha: 'f'.repeat(40) },
  { phase_key: 'f'.repeat(64) }, { outcome_code: null },
]) {
  test(`intent rejects foreign or unconfirmed model binding ${JSON.stringify(bad)}`, async () => {
    const h = scripted([
      { sql: /SELECT runs\.\*/, rows: [row()] },
      { sql: /FROM agent_worker.operations/, rows: [operation({ operation_id: MODEL_ID, kind: 'model_call', outcome_code: 'success', ...bad })] },
    ]);
    assert.equal((await h.store.putIntent(lease, intent())).status, 'conflict');
    assert.equal(h.calls.some(call => /INSERT INTO agent_worker.operations/.test(call.text)), false);
    h.done();
  });
}

test('pending effect excludes another model reservation without consuming budget', async () => {
  const h = scripted([{ sql: /SELECT runs\.\*/, rows: [row({ pending_operation_id: OP_ID })] }]);
  const result = await h.store.reserveModelCall(lease, { key: HASH, inputHash: HASH,
    expectedHeadSha: HEAD, inputTokens: 1, outputTokens: 1 });
  assert.deepEqual(result, { status: 'blocked', canExecute: false, blockerCode: 'coordinator_pending_effect' });
  h.done();
});

for (const [outcome, blockerCode] of [[null, 'coordinator_model_uncertain'], ['success', 'coordinator_candidate_lost']]) {
  test(`recorded ${outcome} model result without a recoverable candidate stops instead of reissuing`, async () => {
    const h = scripted([
      { sql: /SELECT runs\.\*/, rows: [row()] },
      { sql: /FROM agent_worker.operations/, rows: [operation({ kind: 'model_call', outcome_code: outcome })] },
      { sql: /UPDATE agent_worker.runs/, rows: [{ run_id: lease.runId, generation: 1 }], check(values) { assert.ok(values.includes(blockerCode)); } },
    ]);
    const result = await h.store.reserveModelCall(lease, { key: HASH, inputHash: HASH,
      expectedHeadSha: HEAD, inputTokens: 1, outputTokens: 1 });
    assert.equal(result.status, 'needs_attention');
    assert.equal(result.blockerCode, blockerCode);
    assert.equal(result.canExecute, false);
    h.done();
  });
}

test('same phase polling retains database wait start and rejects caller timestamps', async () => {
  assert.throws(() => validateCheckpoint({ state: 'waiting_red_ci', coordinator: { ...phase(), waitStartedAt: new Date().toISOString() } }), SAFE);
  const h = scripted([
    { sql: /SELECT runs\.\*/, rows: [row({ state: 'waiting_red_ci', wait_started_at: '2025-01-01T00:00:00.000Z' })] },
    { sql: /UPDATE agent_worker.runs/, rows: [{ run_id: lease.runId, generation: 1 }], check(values, sql) {
      assert.match(sql, /wait_started_at/);
      assert.match(sql, /phase_key/);
      assert.match(sql, /tickDeadlineSeconds/);
      assert.match(sql, /runLifetimeSeconds/);
    } },
  ]);
  assert.equal(await h.store.checkpoint(lease, { state: 'waiting_red_ci', coordinator: phase() }), true);
  h.done();
});

for (const change of [{ key: 'f'.repeat(64) }, { purpose: 'initial_implementation' }, { headSha: 'f'.repeat(40) }]) {
  test(`checkpoint rejects invalid phase/rekey ${JSON.stringify(change)}`, async () => {
    const h = scripted([{ sql: /SELECT runs\.\*/, rows: [row({ pending_operation_id: OP_ID })] }]);
    await assert.rejects(h.store.checkpoint(lease, { state: 'implementing', coordinator: { ...phase(), ...change } }), SAFE);
    h.done();
  });
}

test('beginRepair atomically shares the counter, installs investigation and releases lease', async () => {
  const request = { key: HASH, source: 'ci', headSha: HEAD, findingSha256: HASH };
  const h = scripted([
    { sql: /SELECT runs\.\*/, rows: [row({ state: 'waiting_ci' })] },
    { sql: /FROM agent_worker.events/, rows: [] },
    { sql: /UPDATE agent_worker.runs/, rows: [{ repair_cycle_count: 1 }], check(values, sql) {
      assert.match(sql, /repair_cycle_count = repair_cycle_count \+ 1/);
      assert.match(sql, /lease_token = NULL/);
      assert.match(sql, /phase_purpose/);
      assert.ok(values.includes('repair_investigation'));
      assert.ok(values.includes(phaseKey('repair_investigation', 1, HASH)));
    } },
  ]);
  assert.deepEqual(await h.store.beginRepair(lease, request), { status: 'reserved', canRepair: true,
    repairCycleCount: 1, phaseKey: phaseKey('repair_investigation', 1, HASH) });
  h.done();
});

for (const [prior, expected] of [
  [{ repair_key: HASH, repair_source: 'ci', repair_head_sha: HEAD, repair_finding_sha256: HASH, event_type: 'repair_reserved' }, 'existing'],
  [{ repair_key: 'f'.repeat(64), repair_source: 'ci', repair_head_sha: HEAD, repair_finding_sha256: HASH, event_type: 'repair_reserved' }, 'conflict'],
]) {
  test(`repair duplicate/rekey returns ${expected} without another reservation`, async () => {
    const h = scripted([
      { sql: /SELECT runs\.\*/, rows: [row({ state: 'waiting_ci' })] },
      { sql: /FROM agent_worker.events/, rows: [prior] },
    ]);
    assert.deepEqual(await h.store.beginRepair(lease, { key: HASH, source: 'ci', headSha: HEAD, findingSha256: HASH }), { status: expected, canRepair: false });
    h.done();
  });
}

test('CI and Qodo repairs use the existing shared two-cycle limit', async () => {
  const h = scripted([
    { sql: /SELECT runs\.\*/, rows: [row({ state: 'waiting_review', repair_cycle_count: 2, phase_round: 2,
      phase_purpose: 'draft_pr', phase_key: phaseKey('draft_pr', 2, HASH),
      finding_sha256: HASH, finding_source: 'qodo', finding_head_sha: HEAD })] },
    { sql: /FROM agent_worker.events/, rows: [] },
    { sql: /UPDATE agent_worker.runs/, rows: [{ run_id: lease.runId, generation: 1 }] },
  ]);
  assert.deepEqual(await h.store.beginRepair(lease, { key: HASH, source: 'qodo', headSha: HEAD, findingSha256: HASH }),
    { status: 'needs_attention', canRepair: false, blockerCode: 'repair_cycle_limit' });
  h.done();
});
