import { createHash } from 'node:crypto';
import { MAX_INPUT_RESERVATION } from './input-budget.mjs';

export const SAFE_ERROR = 'Worker storage operation failed.';
export const DEFAULT_DATABASE_TIMEOUT_MS = 5000;
export const DEFAULT_RECOVERY_TIMEOUT_MS = 90000;

export function validateWaitTimeout(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail();
  return value;
}

// A deadline stops local continuations, not SQL or HTTP already accepted remotely.
export function createWaitDeadline(timeoutMs, absoluteDeadline = Infinity) {
  if (absoluteDeadline !== Infinity && !Number.isSafeInteger(absoluteDeadline)) fail();
  let deadline = Math.min(Date.now() + timeoutMs, absoluteDeadline);
  const controller = new AbortController();
  function check() {
    if (controller.signal.aborted || Date.now() >= deadline) {
      controller.abort();
      fail();
    }
  }
  return {
    get deadline() { return deadline; },
    signal: controller.signal,
    isExpired() { return controller.signal.aborted || Date.now() >= deadline; },
    clamp(value) {
      if (!Number.isSafeInteger(value)) fail();
      deadline = Math.min(deadline, value);
      check();
    },
    check,
    async wait(operation) {
      check();
      let timer;
      let onAbort;
      const expired = new Promise((_, reject) => {
        onAbort = () => reject(new Error(SAFE_ERROR));
        controller.signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
      });
      // Observe late fulfillment/rejection even when cancellation is ignored.
      const pending = Promise.resolve().then(() => {
        check();
        return operation();
      });
      try {
        const result = await Promise.race([pending, expired]);
        check();
        return result;
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', onAbort);
      }
    },
    close() { controller.abort(); },
  };
}

const LIMIT_MAXIMA = Object.freeze({
  nonterminalPilotRuns: 1,
  modelCallsPerTick: 1,
  modelCallsPerRun: 20,
  inputTokensPerCall: MAX_INPUT_RESERVATION,
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

const LIMIT_KEYS = Object.keys(LIMIT_MAXIMA);
const SHA256 = /^[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPOSITORY_NAME = /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/;
const INVOCATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPERATION_KEY = /^[a-f0-9]{64}$/;
const BRANCH_NAME = /^agent-work\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NONTERMINAL_STATES = new Set([
  'claimed',
  'generating_tests',
  'waiting_red_ci',
  'implementing',
  'waiting_ci',
  'opening_pr',
  'waiting_review',
  'repairing',
]);
const TERMINAL_STATES = new Set(['ready_for_human', 'needs_attention', 'cancelled']);
const BLOCKER_CODES = new Set([
  'lease_recovery_limit',
  'model_call_budget_exhausted',
  'model_token_budget_exhausted',
  'model_input_token_limit',
  'model_tick_deadline',
  'model_run_deadline',
  'model_call_deadline',
  'model_usage_unreported',
  'model_usage_invalid',
  'model_usage_exceeded',
  'model_outcome_uncertain',
  'model_spend_limit',
  'model_payment_failure',
  'model_restricted',
  'model_provider_failure',
  'model_contract_unknown',
  'repair_cycle_limit',
  'recovery_database_uncertain',
  'recovery_effect_unconfirmed',
  'recovery_conflict',
  'recovery_approval_denied',
  'recovery_lease_lost',
  'recovery_deadline',
  'recovery_unsupported_effect',
  'recovery_invalid_input',
  'coordinator_pending_effect',
  'coordinator_model_uncertain',
  'coordinator_candidate_lost',
  'coordinator_journal_conflict',
  'coordinator_wait_expired',
  'coordinator_investigation_human_stop',
]);
const OPERATION_KINDS = new Set([
  'model_call',
  'branch_create',
  'commit_create',
  'pr_create',
]);
const LEASE_KEYS = [
  'runId',
  'jobId',
  'repositoryId',
  'repositoryFullName',
  'issueId',
  'issueNumber',
  'actorId',
  'generation',
  'token',
  'expiresAt',
];

export function fail() {
  throw new Error(SAFE_ERROR);
}

function clone(value) {
  try {
    return structuredClone(value);
  } catch {
    fail();
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validNullableSha(value) {
  return value === null || (typeof value === 'string' && SHA1.test(value));
}

function validateLimits(value) {
  if (!exactKeys(value, LIMIT_KEYS)) fail();

  for (const [key, maximum] of Object.entries(LIMIT_MAXIMA)) {
    const minimum = ['expiredLeaseRecoveries', 'repairCycles'].includes(key) ? 0 : 1;
    if (!Number.isSafeInteger(value[key]) || value[key] < minimum || value[key] > maximum) fail();
  }

  if (value.nonterminalPilotRuns !== 1
      || value.modelCallsPerTick > value.modelCallsPerRun
      || value.inputTokensPerCall > value.inputTokensPerRun
      || value.outputTokensPerCall > value.outputTokensPerRun
      || value.modelCallDeadlineSeconds > value.tickDeadlineSeconds
      || value.tickDeadlineSeconds >= value.leaseSeconds
      || value.leaseSeconds > value.runLifetimeSeconds
      || value.ciWaitSeconds > value.runLifetimeSeconds
      || value.reviewWaitSeconds > value.runLifetimeSeconds) fail();

  return value;
}

function validateManifest(value) {
  const keys = [
    'repositoryId',
    'repositoryFullName',
    'issueId',
    'issueNumber',
    'actorId',
    'manifestHash',
    'baseRevision',
    'policyRevision',
    'limits',
  ];
  if (!exactKeys(value, keys)
      || !positiveSafeInteger(value.repositoryId)
      || typeof value.repositoryFullName !== 'string'
      || value.repositoryFullName.length > 255
      || !REPOSITORY_NAME.test(value.repositoryFullName)
      || !positiveSafeInteger(value.issueId)
      || !positiveSafeInteger(value.issueNumber)
      || !positiveSafeInteger(value.actorId)
      || typeof value.manifestHash !== 'string'
      || !SHA256.test(value.manifestHash)
      || typeof value.baseRevision !== 'string'
      || !SHA1.test(value.baseRevision)
      || typeof value.policyRevision !== 'string'
      || !SHA1.test(value.policyRevision)) fail();

  value.limits = validateLimits(value.limits);
  return value;
}

export function validateClaimInput(value) {
  const input = clone(value);
  if (!exactKeys(input, ['invocationId', 'manifest'])
      || typeof input.invocationId !== 'string'
      || !INVOCATION_ID.test(input.invocationId)) fail();

  return {
    invocationId: input.invocationId,
    manifest: validateManifest(input.manifest),
  };
}

export function validateLease(value) {
  const lease = clone(value);
  if (!exactKeys(lease, LEASE_KEYS)
      || typeof lease.runId !== 'string' || !UUID.test(lease.runId)
      || typeof lease.jobId !== 'string' || !UUID.test(lease.jobId)
      || !positiveSafeInteger(lease.repositoryId)
      || typeof lease.repositoryFullName !== 'string'
      || lease.repositoryFullName.length > 255
      || !REPOSITORY_NAME.test(lease.repositoryFullName)
      || !positiveSafeInteger(lease.issueId)
      || !positiveSafeInteger(lease.issueNumber)
      || !positiveSafeInteger(lease.actorId)
      || !positiveSafeInteger(lease.generation)
      || typeof lease.token !== 'string' || !UUID.test(lease.token)
      || typeof lease.expiresAt !== 'string') fail();

  const expiry = new Date(lease.expiresAt);
  if (!Number.isFinite(expiry.getTime()) || expiry.toISOString() !== lease.expiresAt) fail();
  return lease;
}

export function validateCheckEvidence(value, requireReview = false) {
  const evidence = clone(value);
  if (!exactKeys(evidence, ['headSha', 'workflowId', 'workflowRunId', 'checkRunId', 'checksSha256', 'reviewId'])
      || !isSha1(evidence.headSha) || !isSha256(evidence.checksSha256)
      || !positiveSafeInteger(evidence.workflowId) || !positiveSafeInteger(evidence.workflowRunId)
      || !positiveSafeInteger(evidence.checkRunId)
      || (evidence.reviewId !== null && !positiveSafeInteger(evidence.reviewId))
      || (requireReview && evidence.reviewId === null)) fail();
  return evidence;
}

export function validateCheckpoint(value) {
  const change = clone(value);
  const keys = [
    'state',
    'expectedHeadSha',
    'branchName',
    'pullRequestNumber',
    'lastCheckRunId',
    'reviewHeadSha',
    'blockerCode',
    'coordinator',
    'evidence',
  ];
  if (!isRecord(change)
      || Object.keys(change).some((key) => !keys.includes(key))
      || !Object.hasOwn(change, 'state')
      || typeof change.state !== 'string'
      || !NONTERMINAL_STATES.has(change.state)) fail();

  if (Object.hasOwn(change, 'expectedHeadSha') && !validNullableSha(change.expectedHeadSha)) fail();
  if (Object.hasOwn(change, 'branchName')
      && change.branchName !== null
      && (typeof change.branchName !== 'string' || !BRANCH_NAME.test(change.branchName))) fail();
  if (Object.hasOwn(change, 'pullRequestNumber')
      && change.pullRequestNumber !== null
      && !positiveSafeInteger(change.pullRequestNumber)) fail();
  if (Object.hasOwn(change, 'lastCheckRunId')
      && change.lastCheckRunId !== null
      && !positiveSafeInteger(change.lastCheckRunId)) fail();
  if (Object.hasOwn(change, 'reviewHeadSha') && !validNullableSha(change.reviewHeadSha)) fail();
  if (Object.hasOwn(change, 'blockerCode')
      && change.blockerCode !== null
      && (typeof change.blockerCode !== 'string' || !BLOCKER_CODES.has(change.blockerCode))) fail();

  const evidence = Object.hasOwn(change, 'evidence') ? validateCheckEvidence(change.evidence) : null;
  if (evidence && (!change.coordinator || change.lastCheckRunId !== evidence.checkRunId
      || change.coordinator.priorCheckRunId !== evidence.checkRunId
      || (evidence.reviewId !== null && (change.reviewHeadSha !== evidence.headSha
        || change.coordinator.priorReviewId !== evidence.reviewId)))) fail();
  return {
    ...(evidence ? { evidence } : {}),
    ...(Object.hasOwn(change, 'coordinator')
      ? { coordinator: validateCoordinatorPhase(change.coordinator) } : {}),
    state: change.state,
    expectedHeadSha: change.expectedHeadSha ?? null,
    hasExpectedHeadSha: Object.hasOwn(change, 'expectedHeadSha'),
    branchName: change.branchName ?? null,
    hasBranchName: Object.hasOwn(change, 'branchName'),
    pullRequestNumber: change.pullRequestNumber ?? null,
    hasPullRequestNumber: Object.hasOwn(change, 'pullRequestNumber'),
    lastCheckRunId: change.lastCheckRunId ?? null,
    hasLastCheckRunId: Object.hasOwn(change, 'lastCheckRunId'),
    reviewHeadSha: change.reviewHeadSha ?? null,
    hasReviewHeadSha: Object.hasOwn(change, 'reviewHeadSha'),
    blockerCode: change.blockerCode ?? null,
    hasBlockerCode: Object.hasOwn(change, 'blockerCode'),
  };
}

export function validateIntent(value) {
  const intent = clone(value);
  if (!(exactKeys(intent, ['key', 'kind', 'inputHash', 'expectedHeadSha'])
      || exactKeys(intent, ['key', 'kind', 'inputHash', 'expectedHeadSha', 'coordinator']))
      || typeof intent.key !== 'string'
      || !OPERATION_KEY.test(intent.key)
      || typeof intent.kind !== 'string'
      || !OPERATION_KINDS.has(intent.kind)
      || typeof intent.inputHash !== 'string'
      || !SHA256.test(intent.inputHash)
      || !validNullableSha(intent.expectedHeadSha)
      || (intent.kind !== 'model_call' && intent.expectedHeadSha === null)) fail();
  if (Object.hasOwn(intent, 'coordinator')) {
    intent.coordinator = validateCoordinatorIntent(intent.coordinator, intent);
  }
  return intent;
}

const PURPOSES = new Set(['initial_tests', 'initial_implementation',
  'repair_investigation', 'repair_tests', 'repair_implementation', 'draft_pr']);
const isSha256 = value => typeof value === 'string' && SHA256.test(value);
const isSha1 = value => typeof value === 'string' && SHA1.test(value);

function validatePurposeRound(value) {
  if (value.version !== 1 || !PURPOSES.has(value.purpose)
      || !Number.isSafeInteger(value.repairCycle)
      || value.repairCycle < 0 || value.repairCycle > 2
      || (value.purpose.startsWith('initial_') && value.repairCycle !== 0)
      || (value.purpose.startsWith('repair_') && value.repairCycle === 0)) fail();
}

function validateRegression(value) {
  if (value === null) return null;
  if (!exactKeys(value, ['workflowId', 'testIdentitySha256', 'proposalSha256'])
      || !positiveSafeInteger(value.workflowId)
      || !isSha256(value.testIdentitySha256) || !isSha256(value.proposalSha256)) fail();
  return value;
}

export function buildCoordinatorPhaseKey({ runId, manifestSha256, purpose,
  repairCycle, headSha, findingSha256 }) {
  validateRunId(runId);
  validatePurposeRound({ version: 1, purpose, repairCycle });
  if (!isSha256(manifestSha256) || !isSha1(headSha)
      || !(findingSha256 === null || isSha256(findingSha256))) fail();
  return createHash('sha256').update(JSON.stringify(canonical({ version: 1,
    runId, manifestSha256, purpose, repairCycle, headSha, findingSha256 }))).digest('hex');
}

export function validateCoordinatorPhase(value) {
  const phase = clone(value);
  const required = ['version', 'purpose', 'key', 'repairCycle', 'headSha', 'findingSha256'];
  const optional = ['expectedRegression', 'criterionSha256', 'findingSource',
    'findingHeadSha', 'priorCheckRunId', 'priorReviewId'];
  if (!isRecord(phase) || !required.every(key => Object.hasOwn(phase, key))
      || Object.keys(phase).some(key => !required.includes(key) && !optional.includes(key))) fail();
  validatePurposeRound(phase);
  if (!isSha256(phase.key) || !isSha1(phase.headSha)
      || !(phase.findingSha256 === null || isSha256(phase.findingSha256))
      || (phase.purpose.startsWith('repair_') && phase.findingSha256 === null)) fail();
  if (Object.hasOwn(phase, 'expectedRegression')) validateRegression(phase.expectedRegression);
  if (Object.hasOwn(phase, 'criterionSha256')
      && phase.criterionSha256 !== null && !isSha256(phase.criterionSha256)) fail();
  if (Object.hasOwn(phase, 'findingSource')
      && ![null, 'ci', 'qodo'].includes(phase.findingSource)) fail();
  if (Object.hasOwn(phase, 'findingHeadSha')
      && phase.findingHeadSha !== null && !isSha1(phase.findingHeadSha)) fail();
  for (const key of ['priorCheckRunId', 'priorReviewId']) {
    if (Object.hasOwn(phase, key) && phase[key] !== null && !positiveSafeInteger(phase[key])) fail();
  }
  return phase;
}

function validateCoordinatorIntent(value, intent) {
  const c = value;
  if (!exactKeys(c, ['version', 'purpose', 'phaseKey', 'repairCycle', 'modelOperationId',
    'expectedRegression', 'criterionSha256', 'candidateDescriptors'])) fail();
  validatePurposeRound(c);
  if (!['commit_create', 'pr_create'].includes(intent.kind) || !isSha256(c.phaseKey)
      || !(c.criterionSha256 === null || isSha256(c.criterionSha256))) fail();
  validateRegression(c.expectedRegression);
  const isPr = intent.kind === 'pr_create';
  if ((c.purpose === 'draft_pr') !== isPr || c.purpose === 'repair_investigation'
      || (isPr ? c.modelOperationId !== null
        : typeof c.modelOperationId !== 'string' || !UUID.test(c.modelOperationId))) fail();
  const descriptors = c.candidateDescriptors;
  if (!Array.isArray(descriptors) || descriptors.length > 10
      || (isPr ? descriptors.length !== 0 : descriptors.length < 1)) fail();
  if (c.purpose.endsWith('_tests') && (c.expectedRegression === null
      || c.criterionSha256 === null || c.expectedRegression.proposalSha256 !== intent.inputHash)) fail();
  const indexes = new Set();
  let total = 0;
  for (const d of descriptors) {
    if (!exactKeys(d, ['approvedPathIndex', 'operation', 'beforeBlobSha', 'afterBlobSha',
      'contentSha256', 'bytes', 'mode']) || !Number.isSafeInteger(d.approvedPathIndex)
        || d.approvedPathIndex < 0 || d.approvedPathIndex > 2147483647
        || indexes.has(d.approvedPathIndex) || !['create', 'modify'].includes(d.operation)
        || (d.operation === 'create' ? d.beforeBlobSha !== null : !isSha1(d.beforeBlobSha))
        || !isSha1(d.afterBlobSha) || !isSha256(d.contentSha256)
        || !Number.isSafeInteger(d.bytes) || d.bytes < 0 || d.bytes > 65536
        || d.mode !== '100644') fail();
    indexes.add(d.approvedPathIndex);
    total += d.bytes;
  }
  if (total > 262144) fail();
  return c;
}

export function validateBeginRepairInput(value) {
  const input = clone(value);
  if (!(exactKeys(input, ['key', 'source', 'headSha', 'findingSha256'])
      || exactKeys(input, ['key', 'source', 'headSha', 'findingSha256', 'evidence']))
      || !isSha256(input.findingSha256)) fail();
  validateRepairInput({ key: input.key, source: input.source, headSha: input.headSha });
  if (Object.hasOwn(input, 'evidence')) {
    input.evidence = validateCheckEvidence(input.evidence, input.source === 'qodo');
    if (input.evidence.headSha !== input.headSha
        || input.source === 'ci' && input.evidence.reviewId !== null) fail();
  }
  return input;
}

export function validateModelCallInput(value) {
  const input = clone(value);
  if (!exactKeys(input, [
    'key', 'inputHash', 'expectedHeadSha', 'inputTokens', 'outputTokens',
  ])
      || typeof input.key !== 'string' || !SHA256.test(input.key)
      || typeof input.inputHash !== 'string' || !SHA256.test(input.inputHash)
      || !validNullableSha(input.expectedHeadSha)
      || !positiveSafeInteger(input.inputTokens)
      || !positiveSafeInteger(input.outputTokens)) fail();
  return input;
}

export function validateModelCallOutcomeInput(value) {
  const input = clone(value);
  const allowedKeys = [
    'operationId', 'outcome', 'actualInputTokens', 'actualOutputTokens',
  ];
  if (!isRecord(input)
      || Object.keys(input).some(key => !allowedKeys.includes(key))
      || typeof input.operationId !== 'string' || !UUID.test(input.operationId)
      || typeof input.outcome !== 'string') fail();
  const hasInput = Object.hasOwn(input, 'actualInputTokens');
  const hasOutput = Object.hasOwn(input, 'actualOutputTokens');
  if (hasInput !== hasOutput) fail();
  return {
    operationId: input.operationId,
    outcomeInput: hasInput
      ? {
        outcome: input.outcome,
        actualInputTokens: input.actualInputTokens,
        actualOutputTokens: input.actualOutputTokens,
      }
      : { outcome: input.outcome },
  };
}

export function validateRepairInput(value) {
  const input = clone(value);
  if (!exactKeys(input, ['key', 'source', 'headSha'])
      || typeof input.key !== 'string' || !SHA256.test(input.key)
      || !['ci', 'qodo'].includes(input.source)
      || typeof input.headSha !== 'string' || !SHA1.test(input.headSha)) fail();
  return input;
}

export function validateFinishInput(state, optionsValue = {}) {
  const options = clone(optionsValue);
  if (typeof state !== 'string' || !TERMINAL_STATES.has(state)
      || !isRecord(options)
      || Object.keys(options).some((key) => !['blockerCode', 'evidence'].includes(key))) fail();

  if (Object.hasOwn(options, 'blockerCode')
      && options.blockerCode !== null
      && (state !== 'needs_attention'
        || typeof options.blockerCode !== 'string'
        || !BLOCKER_CODES.has(options.blockerCode))) fail();

  if (Object.hasOwn(options, 'evidence') && state !== 'ready_for_human') fail();
  return {
    state,
    blockerCode: options.blockerCode ?? null,
    hasBlockerCode: Object.hasOwn(options, 'blockerCode'),
    ...(Object.hasOwn(options, 'evidence')
      ? { evidence: validateCheckEvidence(options.evidence, true) } : {}),
  };
}

export function validateRunId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail();
  return value;
}

export function validatePublicationPhase(value) {
  if (!['branch', 'commit', 'pr', 'probe'].includes(value)) fail();
  return value;
}

export function validatePublicationProof(value, lease, intent) {
  const proof = clone(value);
  if (intent.kind === 'pr_create') {
    if (!exactKeys(proof, ['status', 'branch', 'inputHash', 'baseSha', 'branchHeadSha',
      'prId', 'prNumber', 'prCount', 'headSha', 'draft'])
        || proof.status !== 'confirmed'
        || proof.branch !== `agent-work/${lease.runId.toLowerCase()}`
        || proof.inputHash !== intent.inputHash
        || proof.headSha !== intent.expectedHeadSha || proof.branchHeadSha !== proof.headSha
        || ![proof.baseSha, proof.headSha].every(value => typeof value === 'string' && SHA1.test(value))
        || ![proof.prId, proof.prNumber].every(value => Number.isSafeInteger(value) && value > 0)
        || proof.prCount !== 1 || proof.draft !== true) fail();
    return proof;
  }
  if (!exactKeys(proof, ['status', 'branch', 'inputHash', 'baseSha', 'parentSha',
    'commitSha', 'treeSha', 'branchHeadSha'])
      || intent.kind !== 'commit_create'
      || proof.status !== 'confirmed'
      || proof.branch !== `agent-work/${lease.runId.toLowerCase()}`
      || proof.inputHash !== intent.inputHash
      || proof.parentSha !== intent.expectedHeadSha
      || ![proof.baseSha, proof.parentSha, proof.commitSha, proof.treeSha,
        proof.branchHeadSha].every(value => typeof value === 'string' && SHA1.test(value))
      || proof.branchHeadSha !== proof.commitSha) fail();
  return proof;
}

export function validateLimitsFromRow(value) {
  const limits = clone(value);
  return validateLimits(limits);
}

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function sameManifest(row, manifest) {
  try {
    return Number(row.repository_id) === manifest.repositoryId
      && row.repository_full_name === manifest.repositoryFullName
      && Number(row.issue_id) === manifest.issueId
      && Number(row.issue_number) === manifest.issueNumber
      && Number(row.actor_id) === manifest.actorId
      && row.manifest_hash === manifest.manifestHash
      && row.base_revision === manifest.baseRevision
      && row.policy_revision === manifest.policyRevision
      && JSON.stringify(canonical(validateLimitsFromRow(row.limits)))
        === JSON.stringify(canonical(manifest.limits));
  } catch {
    return false;
  }
}
