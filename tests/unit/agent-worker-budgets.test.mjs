import assert from 'node:assert/strict';
import test from 'node:test';

const budgetsUrl = new URL('../../src/automation/worker/budgets.mjs', import.meta.url);
const budgets = await import(budgetsUrl.href).catch(() => ({}));
const LIMITS = Object.freeze({
  nonterminalPilotRuns: 1,
  modelCallsPerTick: 1,
  modelCallsPerRun: 20,
  inputTokensPerCall: 8000,
  outputTokensPerCall: 2000,
  inputTokensPerRun: 100000,
  outputTokensPerRun: 20000,
  tickDeadlineSeconds: 90,
  modelCallDeadlineSeconds: 45,
  leaseSeconds: 180,
  expiredLeaseRecoveries: 2,
  ciWaitSeconds: 1800,
  reviewWaitSeconds: 1800,
  runLifetimeSeconds: 7200,
  repairCycles: 2,
});

function requireHelper(name) {
  assert.equal(typeof budgets[name], 'function', `missing ${name} budget helper`);
  return budgets[name];
}

test('model call planning clamps output to configured per-call allowance without authorization', () => {
  const planModelCall = requireHelper('planModelCall');
  const plan = planModelCall({
    limits: { ...LIMITS, inputTokensPerCall: 500, outputTokensPerCall: 256 },
    inputTokens: 400,
    outputTokens: 900,
  });

  assert.deepEqual(plan, {
    status: 'planned',
    inputTokens: 400,
    outputTokens: 256,
  });
  assert.equal(Object.hasOwn(plan, 'canExecute'), false);
});

test('model call planning never trims required input to fit the approved bound', () => {
  const planModelCall = requireHelper('planModelCall');

  assert.deepEqual(planModelCall({
    limits: { ...LIMITS, inputTokensPerCall: 500 },
    inputTokens: 501,
    outputTokens: 100,
  }), {
    status: 'stopped',
    blockerCode: 'model_input_token_limit',
  });
});

test('model call planning rejects caller-supplied counters and malformed bounds', () => {
  const planModelCall = requireHelper('planModelCall');

  assert.throws(() => planModelCall({
    limits: LIMITS,
    inputTokens: 10,
    outputTokens: 10,
    reservedInputTokens: 0,
  }), { message: 'Model call budget request is invalid.' });
  assert.throws(() => planModelCall({
    limits: LIMITS,
    inputTokens: 0,
    outputTokens: 10,
  }), { message: 'Model call budget request is invalid.' });
});

test('successful outcomes retain only explicitly reported numeric usage', () => {
  const normalizeModelCallOutcome = requireHelper('normalizeModelCallOutcome');

  assert.deepEqual(normalizeModelCallOutcome({
    outcome: 'success',
    actualInputTokens: 123,
    actualOutputTokens: 45,
  }), {
    outcome: 'success',
    actualInputTokens: 123,
    actualOutputTokens: 45,
    blockerCode: null,
  });
});

test('unreported usage records no invented zero values and stops with a fixed blocker', () => {
  const normalizeModelCallOutcome = requireHelper('normalizeModelCallOutcome');

  assert.deepEqual(normalizeModelCallOutcome({ outcome: 'usage_unreported' }), {
    outcome: 'usage_unreported',
    actualInputTokens: null,
    actualOutputTokens: null,
    blockerCode: 'model_usage_unreported',
  });
});

test('outcome categories map to fixed blockers and exclude provider details', () => {
  const normalizeModelCallOutcome = requireHelper('normalizeModelCallOutcome');
  const cases = [
    ['uncertain', 'model_outcome_uncertain'],
    ['spend_limit', 'model_spend_limit'],
    ['payment_failure', 'model_payment_failure'],
    ['restricted_model', 'model_restricted'],
    ['provider_failure', 'model_provider_failure'],
    ['deadline', 'model_call_deadline'],
    ['unknown_contract', 'model_contract_unknown'],
  ];

  for (const [outcome, blockerCode] of cases) {
    assert.deepEqual(normalizeModelCallOutcome({ outcome }), {
      outcome,
      actualInputTokens: null,
      actualOutputTokens: null,
      blockerCode,
    });
  }

  assert.throws(() => normalizeModelCallOutcome({
    outcome: 'provider_failure',
    message: 'private provider error',
  }), { message: 'Model call outcome is invalid.' });
});

test('invalid usage is normalized without persisting supplied values', () => {
  const normalizeModelCallOutcome = requireHelper('normalizeModelCallOutcome');

  assert.deepEqual(normalizeModelCallOutcome({
    outcome: 'success',
    actualInputTokens: -1,
    actualOutputTokens: 10,
  }), {
    outcome: 'invalid_usage',
    actualInputTokens: null,
    actualOutputTokens: null,
    blockerCode: 'model_usage_invalid',
  });
});

test('unreported outcomes cannot persist token numbers attached to the report', () => {
  const normalizeModelCallOutcome = requireHelper('normalizeModelCallOutcome');

  assert.deepEqual(normalizeModelCallOutcome({
    outcome: 'usage_unreported',
    actualInputTokens: 12,
    actualOutputTokens: 4,
  }), {
    outcome: 'invalid_usage',
    actualInputTokens: null,
    actualOutputTokens: null,
    blockerCode: 'model_usage_invalid',
  });
});

test('normalized usage failures cannot persist token values', () => {
  const normalizeModelCallOutcome = requireHelper('normalizeModelCallOutcome');

  assert.deepEqual(normalizeModelCallOutcome({
    outcome: 'excess_usage',
    actualInputTokens: 12,
    actualOutputTokens: 4,
  }), {
    outcome: 'excess_usage',
    actualInputTokens: null,
    actualOutputTokens: null,
    blockerCode: 'model_usage_exceeded',
  });
});
