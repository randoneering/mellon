import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWorkerStore } from '../../src/automation/worker/store.mjs';

export const RUN_ID = '11111111-1111-4111-8111-111111111111';
export const MODEL_ID = '22222222-2222-4222-8222-222222222222';
export const OP_ID = '33333333-3333-4333-8333-333333333333';
export const HEAD = 'a'.repeat(40);
export const HASH = 'b'.repeat(64);
export const lease = { runId: RUN_ID, jobId: '44444444-4444-4444-8444-444444444444',
  repositoryId: 1, repositoryFullName: 'org/repo', issueId: 2, issueNumber: 3,
  actorId: 4, generation: 1, token: '55555555-5555-4555-8555-555555555555',
  expiresAt: new Date(Date.now() + 180000).toISOString() };
export const limits = { nonterminalPilotRuns: 1, modelCallsPerTick: 1, modelCallsPerRun: 20,
  inputTokensPerCall: 8000, outputTokensPerCall: 2000, inputTokensPerRun: 100000,
  outputTokensPerRun: 20000, tickDeadlineSeconds: 90, modelCallDeadlineSeconds: 45,
  leaseSeconds: 180, expiredLeaseRecoveries: 2, ciWaitSeconds: 1800,
  reviewWaitSeconds: 1800, runLifetimeSeconds: 7200, repairCycles: 2 };
export function phaseKey(purpose = 'initial_tests', repairCycle = 0, findingSha256 = null) {
  // Independent literal canonical ordering, including the pinned manifest and run.
  return createHash('sha256').update(JSON.stringify({ findingSha256, headSha: HEAD,
    manifestSha256: HASH, purpose, repairCycle, runId: RUN_ID, version: 1 })).digest('hex');
}
export function phase(purpose = 'initial_tests', repairCycle = 0, findingSha256 = null) {
  return { version: 1, purpose, key: phaseKey(purpose, repairCycle, findingSha256),
    repairCycle, headSha: HEAD, findingSha256 };
}
export function row(overrides = {}) {
  const now = new Date().toISOString();
  return { run_id: RUN_ID, job_id: lease.jobId, repository_id: 1,
    repository_full_name: 'org/repo', issue_id: 2, issue_number: 3, actor_id: 4,
    manifest_hash: HASH, base_revision: HEAD, policy_revision: HEAD, limits,
    state: 'generating_tests', generation: 1, recovery_count: 0, model_call_count: 1,
    reserved_input_tokens: 10, reserved_output_tokens: 10, repair_cycle_count: 0,
    lease_token: lease.token, lease_expires_at: lease.expiresAt,
    database_now: now, tick_deadline_at: new Date(Date.now() + 90000).toISOString(),
    run_deadline_at: new Date(Date.now() + 7200000).toISOString(),
    expected_head_sha: HEAD, branch_name: null, pull_request_number: null,
    last_check_run_id: null, review_head_sha: null, blocker_code: null,
    created_at: now, updated_at: now, terminal_at: null,
    coordinator_version: 1, phase_purpose: 'initial_tests', phase_key: phaseKey(),
    phase_round: 0, phase_head_sha: HEAD, phase_started_at: now, wait_started_at: null,
    pending_operation_id: null, regression_workflow_id: null,
    regression_test_sha256: null, regression_proposal_sha256: null, criterion_sha256: null,
    finding_sha256: null, finding_source: null, finding_head_sha: null,
    prior_check_run_id: null, prior_review_id: null, ...overrides };
}
export function descriptor(overrides = {}) {
  return { approvedPathIndex: 0, operation: 'create', beforeBlobSha: null,
    afterBlobSha: HEAD, contentSha256: HASH, bytes: 100, mode: '100644', ...overrides };
}
export function intent(overrides = {}) {
  return { key: 'c'.repeat(64), kind: 'commit_create', inputHash: HASH,
    expectedHeadSha: HEAD, coordinator: { version: 1, purpose: 'initial_tests',
      phaseKey: phaseKey(), repairCycle: 0, modelOperationId: MODEL_ID,
      expectedRegression: { workflowId: 7, testIdentitySha256: HASH, proposalSha256: HASH },
      criterionSha256: HASH, candidateDescriptors: [descriptor()] }, ...overrides };
}
export function operation(overrides = {}) {
  const i = intent();
  return { operation_id: OP_ID, run_id: RUN_ID, operation_key: i.key,
    kind: i.kind, input_hash: i.inputHash, expected_head_sha: HEAD,
    coordinator_version: 1, phase_purpose: 'initial_tests', phase_key: phaseKey(),
    phase_round: 0, model_operation_id: MODEL_ID, descriptor_count: 1, criterion_sha256: HASH,
    regression_workflow_id: 7, regression_test_sha256: HASH, regression_proposal_sha256: HASH,
    effect_phase: 'prepared', effect_reference: null, branch_attempted: false,
    commit_attempted: false, pr_attempted: false,
    owner_generation: null, reserved_input_tokens: null, reserved_output_tokens: null,
    requested_output_tokens: null, call_deadline_at: null, outcome_code: null,
    outcome_blocker_code: null, actual_input_tokens: null, actual_output_tokens: null,
    created_at: new Date().toISOString(),
    ...(overrides.kind === 'model_call' ? { operation_id: MODEL_ID, operation_key: HASH,
      input_hash: 'e'.repeat(64), model_operation_id: null, descriptor_count: null,
      regression_workflow_id: null, regression_test_sha256: null,
      regression_proposal_sha256: null, criterion_sha256: null,
      owner_generation: 1, reserved_input_tokens: 10, reserved_output_tokens: 10,
      requested_output_tokens: 10, call_deadline_at: new Date(Date.now() + 45000).toISOString(),
      outcome_code: 'success', outcome_blocker_code: overrides.outcome_code === 'uncertain'
        ? 'model_outcome_uncertain' : null,
      actual_input_tokens: overrides.outcome_code === null ? null : 8,
      actual_output_tokens: overrides.outcome_code === null ? null : 8 } : {}),
    ...overrides };
}
export function scripted(steps, options) {
  const calls = [];
  const scriptFailures = [];
  let discarded;
  const store = createWorkerStore({ async connect() { return {
    async query(sql, values) {
      const text = typeof sql === 'string' ? sql : sql.text;
      calls.push({ text, values: values ?? sql.values });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text) || text.startsWith('SET LOCAL')) {
        return { rows: [] };
      }
      if (text.includes('INSERT INTO agent_worker.events')) return { rows: [{ event_id: '1' }] };
      const step = steps.shift();
      try {
        assert.ok(step, `Unexpected SQL: ${text}`);
        assert.match(text, step.sql);
        step.check?.(values, text);
      } catch (error) {
        scriptFailures.push(error);
        throw error;
      }
      if (step.error) throw step.error;
      return { rows: step.rows ?? [] };
    }, release(error) { discarded = error; },
  }; } }, options);
  return { store, calls, done() { assert.equal(steps.length, 0); assert.deepEqual(scriptFailures, []); },
    get discarded() { return discarded; } };
}
