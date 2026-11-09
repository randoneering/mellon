import { EventEmitter } from 'node:events';
import tls from 'node:tls';
import { createWorkerDatabase } from '../../src/automation/worker/pool.mjs';
import { createWorkerStore } from '../../src/automation/worker/store.mjs';
import { harness } from './worker-coordinator/harness.mjs';
import { brokerFixture } from './agent-worker-github-app.mjs';
import { SUBMITTED_IDENTITY } from './agent-worker-review/submitted.mjs';
import { hash, canonical } from './worker-candidates/inputs.mjs';

export function runtimeRequest() {
  return new Request('https://worker.invalid/tick', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-neon-trigger-invocation-id': 'runtime-test-1' },
    body: JSON.stringify({ version: 1, invocation_id: 'runtime-test-1',
      trigger: { type: 'schedule', id: 'runtime-trigger', name: 'issueworkertick' },
      data: { scheduled_at: new Date().toISOString() } }),
  });
}

export async function runtimeFixture() {
  const h = await harness();
  h.manifest.model = { id: 'gpt-6-1-sol', renderer: 'neon-responses-gpt-6-1-sol-v1',
    reasoningEffort: 'high', inputAdmission: 'conservative-bytes-v1' };
  h.manifest.limits.inputTokensPerCall = 65536;
  h.manifest.qodoIdentities = [{ ...SUBMITTED_IDENTITY }];
  const manifestSha256 = hash(canonical(h.manifest));
  h.state.run.manifestHash = manifestSha256;
  h.state.run.limits = { ...h.manifest.limits };
  const github = brokerFixture({ repositoryId: h.manifest.repository.id });
  const reports = [];
  const events = [];
  const env = {
    AGENT_WORKER_ENABLED: 'true', NEON_BRANCH: 'production',
    AGENT_WORKER_DATABASE_URL: 'postgresql://runtime_worker:worker-password@db.example/neondb?sslmode=verify-full',
    AGENT_WORKER_APP_PRIVATE_KEY: github.config.privateKey,
    WORKER_MODEL_BASE_URL: 'https://br-test-api.ai.c-3.us-east-2.aws.neon.tech',
    WORKER_MODEL_TOKEN: 'synthetic-worker-gateway-token',
  };
  const config = {
    version: 1, productionBranch: 'production', triggerId: 'runtime-trigger',
    databaseRole: 'runtime_worker', manifest: h.manifest, manifestSha256,
    policyManifest: h.dependencies.policyManifest,
    github: { appId: 123, installationId: 456, actor: { databaseId: 42, login: 'mellon[bot]' },
      preflightCommitSha: 'a'.repeat(40) },
    preflight: { version: 1, planSha256: '', gatewayBindingSha256: '', databaseBindingSha256: '',
      checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      evidenceSha256: 'b'.repeat(64), checks: [
        'native_ingress', 'worker_credential_isolation', 'gateway_model_tools_usage',
        'gateway_spend_limits', 'github_app_signing', 'qodo_draft_review', 'qodo_updated_head_review',
      ] },
  };
  function pin() {
    config.manifestSha256 = hash(canonical(config.manifest));
    h.state.run.manifestHash = config.manifestSha256;
    h.state.run.limits = { ...config.manifest.limits };
    const { preflight, ...plan } = config;
    if (preflight) {
      preflight.planSha256 = hash(canonical(plan));
      preflight.databaseBindingSha256 = hash(canonical({
        connectionString: env.AGENT_WORKER_DATABASE_URL, role: config.databaseRole,
      }));
      preflight.gatewayBindingSha256 = hash(canonical({ baseURL: env.WORKER_MODEL_BASE_URL,
        tokenSha256: hash(env.WORKER_MODEL_TOKEN), model: config.manifest.model }));
    }
    env.AGENT_WORKER_CONFIG_JSON = JSON.stringify(config);
    env.AGENT_WORKER_CONFIG_SHA256 = hash(canonical(config));
  }
  pin();
  const role = { role_name: 'runtime_worker', session_role: 'runtime_worker', ssl: true,
    rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false,
    rolreplication: false, rolinherit: false, has_memberships: false,
    owns_database: false, owns_app_objects: false, database_create: false,
    schema_create: false, grants_ok: true, limits_ok: true };
  let pool;
  class Pool extends EventEmitter {
    constructor(options) { super(); this.options = options; this.closed = false; pool = this; }
    async connect() {
      events.push('database.connect');
      const stream = Object.setPrototypeOf({ encrypted: true, authorized: true,
        servername: this.options.host, getProtocol() { return 'TLSv1.3'; } },
      tls.TLSSocket.prototype);
      return { connection: { stream }, async query() { return { rows: [{ ...role }] }; },
        release(discard) { events.push(discard ? 'database.discard' : 'database.release'); } };
    }
    async end() { this.closed = true; events.push('database.close'); }
  }
  const fetch = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://api.github.com') throw new Error('Uncontrolled network is forbidden.');
    const path = decodeURIComponent(parsed.pathname);
    if (path.startsWith('/app') || path.startsWith('/installation/')
      || path.startsWith('/repositories/') || path === '/users/mellon[bot]' || path === '/graphql') {
      return github.fetch(url, options);
    }
    return h.dependencies.fetch(url, options);
  };
  const claimJob = h.store.claimTick;
  h.store.claimTick = async () => { events.push('store.claim'); return { status: 'idle' }; };
  const factories = { fetch,
    createDatabase(options) {
      events.push('database.create');
      return createWorkerDatabase(options, { Pool });
    },
    createStore(actualPool) {
      events.push('store.create');
      const actual = createWorkerStore(actualPool);
      if (typeof actual.claimTick !== 'function') throw new Error('Missing real store constructor.');
      return { ...actual, ...h.store };
    },
  };
  return { h, env, config, pin, role, github, reports, events, factories, claimJob,
    report: value => reports.push(value), pool: () => pool };
}
