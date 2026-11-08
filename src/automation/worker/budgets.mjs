import { validateLimitsFromRow } from './store-validation.mjs';

const REQUEST_ERROR = 'Model call budget request is invalid.';
const OUTCOME_ERROR = 'Model call outcome is invalid.';
const OUTCOME_BLOCKERS = Object.freeze({
  usage_unreported: 'model_usage_unreported',
  uncertain: 'model_outcome_uncertain',
  spend_limit: 'model_spend_limit',
  payment_failure: 'model_payment_failure',
  restricted_model: 'model_restricted',
  provider_failure: 'model_provider_failure',
  deadline: 'model_call_deadline',
  unknown_contract: 'model_contract_unknown',
  invalid_usage: 'model_usage_invalid',
  excess_usage: 'model_usage_exceeded',
});
const OUTCOMES = new Set(['success', ...Object.keys(OUTCOME_BLOCKERS)]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function safeTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function invalidRequest(message) {
  throw new Error(message);
}

export function planModelCall(value) {
  if (!exactKeys(value, ['limits', 'inputTokens', 'outputTokens'])) {
    invalidRequest(REQUEST_ERROR);
  }

  let limits;
  try {
    limits = validateLimitsFromRow(value.limits);
  } catch {
    invalidRequest(REQUEST_ERROR);
  }

  if (!Number.isSafeInteger(value.inputTokens) || value.inputTokens <= 0
      || !Number.isSafeInteger(value.outputTokens) || value.outputTokens <= 0) {
    invalidRequest(REQUEST_ERROR);
  }

  if (value.inputTokens > limits.inputTokensPerCall) {
    return { status: 'stopped', blockerCode: 'model_input_token_limit' };
  }

  return {
    status: 'planned',
    inputTokens: value.inputTokens,
    outputTokens: Math.min(value.outputTokens, limits.outputTokensPerCall),
  };
}

export function normalizeModelCallOutcome(value) {
  if (!isRecord(value)
      || Object.keys(value).some(key => ![
        'outcome', 'actualInputTokens', 'actualOutputTokens',
      ].includes(key))
      || !Object.hasOwn(value, 'outcome')
      || typeof value.outcome !== 'string'
      || !OUTCOMES.has(value.outcome)) {
    invalidRequest(OUTCOME_ERROR);
  }

  const hasInput = Object.hasOwn(value, 'actualInputTokens');
  const hasOutput = Object.hasOwn(value, 'actualOutputTokens');
  if (hasInput !== hasOutput) invalidRequest(OUTCOME_ERROR);

  let outcome = value.outcome;
  let actualInputTokens = null;
  let actualOutputTokens = null;
  if (hasInput) {
    if (outcome === 'usage_unreported'
        || (outcome !== 'invalid_usage' && outcome !== 'excess_usage'
          && (!safeTokenCount(value.actualInputTokens)
            || !safeTokenCount(value.actualOutputTokens)))) {
      outcome = 'invalid_usage';
    } else if (outcome !== 'invalid_usage' && outcome !== 'excess_usage') {
      actualInputTokens = value.actualInputTokens;
      actualOutputTokens = value.actualOutputTokens;
    }
  } else if (outcome === 'success') {
    outcome = 'usage_unreported';
  }

  const blockerCode = outcome === 'success' ? null : OUTCOME_BLOCKERS[outcome];
  return { outcome, actualInputTokens, actualOutputTokens, blockerCode };
}
