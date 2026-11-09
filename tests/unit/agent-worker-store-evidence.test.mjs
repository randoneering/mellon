import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCheckpoint, validateFinishInput, validateBeginRepairInput } from '../../src/automation/worker/store-validation.mjs';
import { scripted, row, phase, lease, RUN_ID, HEAD, HASH } from '../fixtures/agent-worker-journal.mjs';

const evidence = (reviewId = null) => ({ headSha: HEAD, workflowId: 7,
  workflowRunId: 800, checkRunId: 811, checksSha256: HASH, reviewId });
const regression = { regression_workflow_id: 7, regression_test_sha256: HASH,
  regression_proposal_sha256: HASH, criterion_sha256: HASH };

test('terminal validator accepts only closed complete current-review evidence', () => {
  const value = validateFinishInput('ready_for_human', { evidence: evidence(900) });
  assert.deepEqual(value.evidence, evidence(900));
  for (const invalid of [null, {}, evidence(), { ...evidence(900), reviewId: 0 },
    { ...evidence(900), headSha: 'invalid' }, { ...evidence(900), checksSha256: 'invalid' },
    { ...evidence(900), workflowRunId: '800' }, { ...evidence(900), body: 'private' }]) {
    assert.throws(() => validateFinishInput('ready_for_human', { evidence: invalid }));
  }
  assert.throws(() => validateFinishInput('cancelled', { evidence: evidence(900) }));
  assert.doesNotThrow(() => validateFinishInput('ready_for_human', {}));
});

test('checkpoint evidence requires matching existing bounded reference fields', () => {
  const input = { state: 'implementing', coordinator: { ...phase('initial_implementation'),
    priorCheckRunId: 811 }, lastCheckRunId: 811, evidence: evidence() };
  assert.deepEqual(validateCheckpoint(input).evidence, evidence());
  assert.throws(() => validateCheckpoint({ ...input, lastCheckRunId: 812 }));
  assert.throws(() => validateCheckpoint({ ...input, coordinator: { ...input.coordinator, priorCheckRunId: 812 } }));
  assert.throws(() => validateCheckpoint({ state: 'waiting_ci', evidence: evidence() }));
});

test('repair evidence binds source and current requested head without changing legacy inputs', () => {
  const request = { key: HASH, source: 'ci', headSha: HEAD, findingSha256: HASH };
  assert.deepEqual(validateBeginRepairInput({ ...request, evidence: evidence() }).evidence, evidence());
  assert.deepEqual(validateBeginRepairInput(request), request);
  assert.throws(() => validateBeginRepairInput({ ...request,
    evidence: { ...evidence(), headSha: 'f'.repeat(40) } }));
  assert.throws(() => validateBeginRepairInput({ ...request, source: 'qodo', evidence: evidence() }));
  assert.deepEqual(validateBeginRepairInput({ ...request, source: 'qodo', evidence: evidence(900) }).evidence,
    evidence(900));
});

test('readiness stores references in the same single UPDATE as terminal state and lease release', async () => {
  const h = scripted([{ sql: /UPDATE agent_worker.runs/, rows: [{ run_id: RUN_ID, generation: 1 }],
    check(values, sql) {
      assert.match(sql, /last_check_head_sha = \$13/);
      assert.match(sql, /last_workflow_id = \$14/);
      assert.match(sql, /last_workflow_run_id = \$15/);
      assert.match(sql, /last_check_run_id = \$16/);
      assert.match(sql, /check_evidence_sha256 = \$17/);
      assert.match(sql, /prior_review_id = \$18/);
      assert.match(sql, /expected_head_sha = \$13/);
      assert.match(sql, /coordinator_version = 1/);
      assert.match(sql, /state = 'waiting_review'/);
      assert.deepEqual(values.slice(12), [HEAD, 7, 800, 811, HASH, 900]);
    } }]);
  assert.equal(await h.store.finishRun(lease, 'ready_for_human', { evidence: evidence(900) }), true);
  assert.equal(h.calls.filter(call => /UPDATE agent_worker.runs/.test(call.text)).length, 1);
  assert.equal(h.calls.some(call => /checkpoint/.test(call.text)), false);
  assert.equal(h.calls.some(call => call.text === 'COMMIT'), true);
  h.done();
});

test('a stale atomic readiness UPDATE records no terminal event or partial evidence', async () => {
  const h = scripted([{ sql: /UPDATE agent_worker.runs/, rows: [] }]);
  assert.equal(await h.store.finishRun(lease, 'ready_for_human', { evidence: evidence(900) }), false);
  assert.equal(h.calls.some(call => call.text.includes('INSERT INTO agent_worker.events')), false);
  h.done();
});

test('coordinator checkpoint writes head-bound evidence atomically with its new phase', async () => {
  const h = scripted([
    { sql: /FROM agent_worker.runs/, rows: [row({ ...regression,
      state: 'waiting_red_ci', wait_started_at: new Date().toISOString() })] },
    { sql: /UPDATE agent_worker.runs/, rows: [{ run_id: RUN_ID, generation: 1 }],
      check(values, sql) {
        assert.match(sql, /last_check_head_sha/);
        assert.match(sql, /last_workflow_run_id/);
        assert.match(sql, /check_evidence_sha256/);
        assert.deepEqual(values.slice(-4), [HEAD, 7, 800, HASH]);
      } },
  ]);
  assert.equal(await h.store.checkpoint(lease, { state: 'implementing',
    coordinator: { ...phase('initial_implementation'), priorCheckRunId: 811 },
    lastCheckRunId: 811, evidence: evidence() }), true);
  assert.equal(h.calls.filter(call => /UPDATE agent_worker.runs/.test(call.text)).length, 1);
  h.done();
});

test('repair reservation writes its causal check references in the same transaction', async () => {
  const h = scripted([
    { sql: /FROM agent_worker.runs/, rows: [row({ ...regression,
      state: 'waiting_ci', wait_started_at: new Date().toISOString() })] },
    { sql: /FROM agent_worker.events/, rows: [] },
    { sql: /UPDATE agent_worker.runs/, rows: [{ repair_cycle_count: 1 }],
      check(values, sql) {
        assert.match(sql, /last_workflow_run_id/);
        assert.match(sql, /prior_check_run_id/);
        assert.deepEqual(values.slice(9), [HEAD, 7, 800, 811, HASH, null]);
      } },
  ]);
  const value = await h.store.beginRepair(lease, { key: HASH, source: 'ci',
    headSha: HEAD, findingSha256: HASH, evidence: evidence() });
  assert.equal(value.status, 'reserved');
  h.done();
});

test('repair-limit terminal stop retains the latest causal check and finding references', async () => {
  const h = scripted([
    { sql: /FROM agent_worker.runs/, rows: [row({ ...regression,
      state: 'waiting_ci', wait_started_at: new Date().toISOString(),
      repair_cycle_count: 2, phase_round: 2, phase_purpose: 'repair_implementation',
      phase_key: phase('repair_implementation', 2, HASH).key,
      finding_sha256: HASH, finding_source: 'ci', finding_head_sha: HEAD })] },
    { sql: /FROM agent_worker.events/, rows: [] },
    { sql: /UPDATE agent_worker.runs/, rows: [{ run_id: RUN_ID, generation: 1 }],
      check(values, sql) {
        assert.match(sql, /check_evidence_sha256/);
        assert.deepEqual(values.slice(4), [HEAD, 7, 800, 811, HASH, null]);
      } },
  ]);
  const result = await h.store.beginRepair(lease, { key: HASH, source: 'ci',
    headSha: HEAD, findingSha256: HASH, evidence: evidence() });
  assert.equal(result.blockerCode, 'repair_cycle_limit');
  const event = h.calls.find(call => call.text.includes('INSERT INTO agent_worker.events'));
  assert.equal(event.values.at(-1), HASH);
  h.done();
});

test('same-phase polls normalize PostgreSQL bigint check and review references', async () => {
  const p = phase('initial_implementation');
  const h = scripted([
    { sql: /FROM agent_worker.runs/, rows: [row({ ...regression,
      state: 'waiting_ci', phase_purpose: p.purpose, phase_key: p.key,
      wait_started_at: new Date().toISOString(), prior_check_run_id: '811', prior_review_id: '900' })] },
    { sql: /UPDATE agent_worker.runs/, rows: [{ run_id: RUN_ID, generation: 1 }] },
  ]);
  assert.equal(await h.store.checkpoint(lease, { state: 'waiting_ci',
    coordinator: { ...p, priorCheckRunId: 811, priorReviewId: 900 } }), true);
  h.done();
});

test('getRun returns safe persisted evidence while retaining existing legacy projection', async () => {
  const h = scripted([{ sql: /FROM agent_worker.runs/, rows: [row({
    last_check_run_id: 811, last_check_head_sha: HEAD, last_workflow_id: 7,
    last_workflow_run_id: 800, check_evidence_sha256: HASH,
    review_head_sha: HEAD, prior_review_id: 900,
  })] }]);
  const value = await h.store.getRun(RUN_ID);
  assert.deepEqual(value.checkEvidence, evidence(900));
  assert.equal(JSON.stringify(value).includes(lease.token), false);
  h.done();
});
