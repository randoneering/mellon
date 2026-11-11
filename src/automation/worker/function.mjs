import { parseTriggerDelivery } from '@neon/functions/triggers';
import { workerRuntimeEnvironment } from './environment.mjs';
import { createWorkerRuntime } from './runtime.mjs';

export { workerRuntimeEnvironment };

const TRIGGER_NAME = 'issueworkertick';
const MAX_DELIVERY_BYTES = 4096;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const COORDINATOR_STATUSES = new Set([
  'advanced', 'idle', 'duplicate', 'waiting',
  'needs_attention', 'cancelled', 'ready_for_human',
]);

function response(status, code, headers = {}) {
  return Response.json({ status }, {
    status: code, headers: { 'cache-control': 'no-store', ...headers },
  });
}

function unavailable(report, category) {
  try { Promise.resolve(report(`[agent_worker] ${category}`)).catch(() => {}); }
  catch { /* Diagnostics cannot widen the response. */ }
  return response('unavailable', 503);
}

function reportProposalDiagnostics(report, result) {
  const categories = new Set(['model_failure', 'prose_only', 'read_only', 'rejected_proposal',
    'valid_proposal', 'lost_valid_proposal', 'assessment_only']);
  const rejections = new Set(['schema', 'binding', 'scope', 'validation', 'duplicate', 'assessment', 'deadline']);
  const value = result.diagnostics;
  if (!categories.has(value?.proposalCategory)) return;
  const fields = ['[agent_worker] stage=model', `category=${value.proposalCategory}`];
  if (rejections.has(value.proposalRejection)) fields.push(`rejection=${value.proposalRejection}`);
  for (const name of ['readFile', 'listFiles', 'proposeChanges']) {
    const count = value.toolCounts?.[name];
    if (Number.isSafeInteger(count) && count >= 0 && count <= 16) fields.push(`${name}=${count}`);
  }
  // The HTTP response stays fixed; only closed metadata reaches the operator report.
  try { Promise.resolve(report(fields.join(' '))).catch(() => {}); }
  catch { /* Reporting cannot change the worker outcome. */ }
}
function reportCoordinatorDiagnostics(report, value) {
  const stages = new Set(['model', 'publication', 'finalization']);
  const categories = new Set(['recovery_deadline', 'recovery_database_uncertain',
    'recovery_effect_unconfirmed', 'recovery_conflict', 'recovery_approval_denied',
    'recovery_lease_lost', 'recovery_unsupported_effect', 'recovery_invalid_input',
    'coordinator_model_uncertain', 'coordinator_candidate_lost',
    'coordinator_journal_conflict']);
  const effects = new Set(['approval_denied', 'approval_unavailable', 'branch_absent',
    'branch_head_mismatch', 'branch_history_limit', 'branch_history_untrusted',
    'branch_identity_mismatch', 'branch_moved', 'branch_read_failed', 'branch_write_not_observed',
    'commit_metadata_invalid', 'commit_write_not_observed', 'commit_write_unconfirmed',
    'fence_denied', 'fence_unavailable', 'invalid_input', 'patch_rejected',
    'publication_context_invalid', 'publication_context_unavailable',
    'pr_context_unavailable', 'pr_template_unverified', 'pr_evidence_invalid',
    'pr_evidence_incomplete', 'pr_identity_ambiguous', 'pr_identity_mismatch',
    'pr_write_not_observed', 'pr_write_unconfirmed', 'pr_publication_failed',
    'repository_identity_mismatch', 'repository_read_failed', 'signing_preflight_expired',
    'tree_incomplete', 'unsupported_file_mode']);
  if (!stages.has(value?.stage) || !categories.has(value.category)) return;
  const fields = [`[agent_worker] stage=${value.stage}`, `category=${value.category}`];
  if (effects.has(value.effectCategory)) fields.push(`effect=${value.effectCategory}`);
  for (const [name, candidate] of Object.entries({
    model_operation_id: value.modelOperationId,
    candidate_operation_id: value.candidateOperationId,
    effect_operation_id: value.effectOperationId,
  })) {
    if (typeof candidate === 'string'
      && (/^[a-f0-9]{64}$/.test(candidate)
        || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate))) {
      fields.push(`${name}=${candidate}`);
    }
  }
  if (Number.isSafeInteger(value.actualInputTokens) && value.actualInputTokens >= 0
      && value.actualInputTokens <= 65536) fields.push(`actual_input_tokens=${value.actualInputTokens}`);
  if (Number.isSafeInteger(value.actualOutputTokens) && value.actualOutputTokens >= 0
      && value.actualOutputTokens <= 2000) fields.push(`actual_output_tokens=${value.actualOutputTokens}`);
  try { Promise.resolve(report(fields.join(' '))).catch(() => {}); }
  catch { /* Reporting cannot change the worker outcome. */ }
}
function reportReviewDiagnostics(report, value) {
  const categories = new Set(['review_request_confirmed', 'review_binding_invalid', 'review_context_unavailable',
    'review_context_invalid', 'review_pull_request_mismatch', 'review_commit_mismatch',
    'review_confirmation_mismatch', 'review_lease_lost', 'review_head_changed', 'review_write_uncertain',
    'review_deadline', 'review_dispatch_failed', 'review_evidence_unconfirmed']);
  if (!categories.has(value?.category)) return;
  const fields = ['[agent_worker] stage=review_request', `category=${value.category}`];
  if (Number.isSafeInteger(value.commentId) && value.commentId > 0) fields.push(`comment_id=${value.commentId}`);
  if (['qodo', 'maintainer'].includes(value.source)) fields.push(`source=${value.source}`);
  try { Promise.resolve(report(fields.join(' '))).catch(() => {}); }
  catch { /* Reporting cannot change the worker outcome. */ }
}
function trustedConfiguration(config) {
  return config && typeof config.productionBranch === 'string' &&
    config.productionBranch.length > 0 && config.productionBranch.length <= 255 &&
    !/[\x00-\x20\x7f]/.test(config.productionBranch) &&
    typeof config.triggerId === 'string' && SAFE_ID.test(config.triggerId) &&
    typeof config.databaseRole === 'string' && /^[a-z_][a-z0-9_]{0,62}$/.test(config.databaseRole);
}

async function boundedBody(request) {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_DELIVERY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

function validInvocation(invocation) {
  return invocation?.type === 'schedule' && invocation.trigger?.type === 'schedule' &&
    typeof invocation.invocationId === 'string' && SAFE_ID.test(invocation.invocationId) &&
    typeof invocation.trigger.id === 'string' && SAFE_ID.test(invocation.trigger.id) &&
    invocation.trigger.name === TRIGGER_NAME &&
    typeof invocation.data?.scheduledAt === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(invocation.data.scheduledAt) &&
    Number.isFinite(Date.parse(invocation.data.scheduledAt));
}

// Neon strips caller-supplied X-Neon-* headers at native Function ingress.
// This check is valid only behind that documented edge, not on local/proxied servers.
function verifyNeonFunctionIngress(request) {
  return request.headers.has('x-neon-trigger-invocation-id');
}

// All injected adapters are trusted server code, never request/configuration payload fields.
// Runtime activation remains separately gated by approved production configuration.
export function createWorkerFunction({
  env = process.env,
  trustedConfig,
  verifyNativeRequest = verifyNeonFunctionIngress,
  authorizeRuntime,
  advanceTick,
  parseDelivery = parseTriggerDelivery,
  report = line => console.error(line),
} = {}) {
  return {
    async fetch(request) {
      let stage = 'provenance';
      try {
        const url = new URL(request.url);
        if (url.pathname !== '/tick' || url.search) return response('not_found', 404);
        if (request.method !== 'POST') return response('method_not_allowed', 405, { allow: 'POST' });
        // The SDK parser checks consistency only. A caller-supplied header is not attestation.
        if (typeof verifyNativeRequest !== 'function' || await verifyNativeRequest(request) !== true) {
          return response('unauthorized', 401);
        }
        stage = 'parser';
        const parsed = await parseDelivery({ headers: request.headers, body: await boundedBody(request) });
        if (parsed?.ok !== true || !validInvocation(parsed.invocation)) return response('unauthorized', 401);
        if (env.AGENT_WORKER_ENABLED !== 'true') return response('disabled', 200);
        stage = 'activation';
        if (!trustedConfiguration(trustedConfig)) return unavailable(report, 'activation_unavailable');
        const invocation = parsed.invocation;
        if (invocation.trigger.id !== trustedConfig.triggerId) return response('unauthorized', 401);
        if (env.NEON_BRANCH !== trustedConfig.productionBranch) return response('disabled', 200);
        try { workerRuntimeEnvironment(env, trustedConfig.databaseRole); } catch {
          return unavailable(report, 'configuration_invalid');
        }
        // This gate must attest approved manifest, role, App and Gateway contracts together.
        const authorized = typeof authorizeRuntime === 'function' && await authorizeRuntime() === true;
        // A kill switch changed while activation awaited must stop this tick as well.
        if (env.AGENT_WORKER_ENABLED !== 'true' || env.NEON_BRANCH !== trustedConfig.productionBranch) {
          return response('disabled', 200);
        }
        if (!authorized) return unavailable(report, 'activation_unavailable');
        stage = 'coordinator';
        if (typeof advanceTick !== 'function') return unavailable(report, 'coordinator_unavailable');
        // Durable deduplication and the one-phase budget belong to the coordinator/store,
        // not an isolate-local receipt cache that disappears on restart.
        const result = await advanceTick(Object.freeze({
          invocationId: invocation.invocationId,
          type: 'schedule',
          trigger: Object.freeze({ type: 'schedule', id: invocation.trigger.id, name: TRIGGER_NAME }),
          data: Object.freeze({ scheduledAt: invocation.data.scheduledAt }),
        }));
        if (!COORDINATOR_STATUSES.has(result?.status)) return unavailable(report, 'coordinator_unavailable');
        reportProposalDiagnostics(report, result);
        reportCoordinatorDiagnostics(report, result.diagnostics);
        reportReviewDiagnostics(report, result.reviewDiagnostics);
        return response(result.status, 200);
      } catch {
        return unavailable(report, `${stage}_unavailable`);
      }
    },
  };
}

export function createProductionWorkerFunction({ env = process.env,
  report = line => console.error(line), factories = {} } = {}) {
  return Object.freeze({ async fetch(request) {
    const runtime = createWorkerRuntime({ env, report, factories });
    try { return await createWorkerFunction({ env, report, ...runtime }).fetch(request); }
    finally { await runtime.close(); }
  } });
}

export default createProductionWorkerFunction();
