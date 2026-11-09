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
