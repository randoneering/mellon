import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { openDisposablePool } from './agent-intake-database.mjs';
import { createWorkerStore } from '../../src/automation/worker/store.mjs';
import { createCoordinator } from '../../src/automation/worker/coordinator.mjs';
import { createWorkerFunction } from '../../src/automation/worker/function.mjs';
import { createCheckReader } from '../../src/automation/worker/checks.mjs';
import { checkApproval } from '../../src/automation/worker/approval.mjs';
import { createReviewReader } from '../../src/automation/worker/review.mjs';
import { controlledTransport, hash, canonical } from '../fixtures/worker-coordinator-db/transport.mjs';

export const ROLE = 'coordinator_test_runtime';
export const available = Boolean(process.env.AGENT_INTAKE_TEST_DATABASE_URL && process.env.AGENT_INTAKE_TEST_RUN_ID);
const TICK_DEADLINE_MS = 90_000;
const MODEL_CEILING_MS = 45_000;
const MODEL_MINIMUM_MS = 30_000;
const POST_RESERVATION_AUTH_MS = 10_000;
const MODEL_OUTCOME_WINDOW_MS = 5_000;
const PUBLICATION_WINDOW_MS = 8_000;
const FINALIZATION_GRACE_MS = 10_000;
let initialization;
let password;
let sequence = 80000;
function safePool(pool, diagnostics = []) {
  const rejected = () => new Error('Coordinator fixture database rejected; private details withheld.');
  let idleError = false;
  pool.on('error', () => { idleError = true; });
  async function query(target, sql, values) {
    if (idleError) throw rejected();
    try { return await target.query(sql, values); } catch (error) {
      const safe = rejected();
      safe.code = /^[A-Z0-9]{5}$/.test(error?.code ?? '') ? error.code : 'PRIVATE';
      diagnostics.push({ code: safe.code,
        constraint: /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(error?.constraint ?? '') ? error.constraint : null,
        position: /^[0-9]{1,6}$/.test(error?.position ?? '') ? Number(error.position) : null });
      throw safe;
    }
  }
  return { query: (sql, values) => query(pool, sql, values), end: () => pool.end(),
    async connect() {
      let client;
      try { client = await pool.connect(); } catch { throw rejected(); }
      return { query: (sql, values) => query(client, sql, values), release: discard => client.release(discard) };
    } };
}
// All SQL reaches the authenticated driver. Faults alter only COMMIT acknowledgment.
function faultPool(pool, control) {
  return { query: pool.query, async connect() {
    const client = await pool.connect();
    return { async query(sql, values) {
      const text = typeof sql === 'string' ? sql : sql.text;
      if (/UPDATE agent_worker\.runs/.test(text)) control.writes.push({ method: control.method,
        evidence: /check_evidence_sha256\s*=/.test(text),
        terminal: /terminal_at\s*=\s*clock_timestamp/.test(text),
        clearsLease: /lease_token\s*=\s*NULL/.test(text) });
      if (sql === 'COMMIT' && control.beforeCommit) await control.beforeCommit(control.method);
      const selected = sql === 'COMMIT' && control.fault && !control.fault.injected
        && control.method === control.fault.method
        && (!control.fault.phase || control.phase === control.fault.phase);
      if (selected && !control.fault.afterCommit) {
        control.fault.injected = true; control.fault.callIndex = control.calls.length;
        throw new Error('Synthetic before-COMMIT acknowledgment loss.');
      }
      const value = await client.query(sql, values);
      if (selected && control.fault.afterCommit) {
        control.fault.injected = true; control.fault.callIndex = control.calls.length;
        throw new Error('Synthetic after-COMMIT acknowledgment loss.');
      }
      return value;
    }, release: client.release };
  } };
}
export async function setupCoordinator(options = {}) {
  // openDisposablePool verifies the fresh-container marker before migrations or grants.
  const diagnostics = [];
  const owner = safePool(await openDisposablePool(), diagnostics);
  let runtime;
  const ids = [];
  try {
    initialization ??= (async () => {
      for (const path of ['agent-intake/001-initial.sql', 'agent-worker/001-initial.sql',
        'agent-worker/002-recovery.sql', 'agent-worker/003-coordinator.sql']) {
        await owner.query(await readFile(new URL(`../../migrations/${path}`, import.meta.url), 'utf8'));
      }
      password = randomUUID();
      await owner.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${password}'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
      await owner.query(`GRANT USAGE ON SCHEMA agent_intake, agent_worker TO ${ROLE}`);
      await owner.query(`GRANT SELECT ON agent_intake.jobs TO ${ROLE}`);
      await owner.query(`GRANT SELECT, INSERT, UPDATE ON agent_worker.runs, agent_worker.operations TO ${ROLE}`);
      await owner.query(`GRANT SELECT, INSERT ON agent_worker.events, agent_worker.candidate_descriptors TO ${ROLE}`);
      await owner.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA agent_worker TO ${ROLE}`);
    })();
    await initialization;
    const url = new URL(process.env.AGENT_INTAKE_TEST_DATABASE_URL);
    url.username = ROLE; url.password = password;
    runtime = safePool(new pg.Pool({ connectionString: url.toString(), max: 4,
      connectionTimeoutMillis: 10000, statement_timeout: 10000, query_timeout: 10000 }), diagnostics);
    const job = { jobId: randomUUID(), repositoryId: 123456, repositoryFullName: 'randoneering/mellon',
      issueId: sequence++, issueNumber: sequence++, actorId: 42 };
    await owner.query(`INSERT INTO agent_intake.jobs
      (job_id,repository_id,repository_full_name,issue_id,issue_number,actor_id,initial_delivery_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [job.jobId, job.repositoryId, job.repositoryFullName,
      job.issueId, job.issueNumber, job.actorId, randomUUID()]);
    const transport = await controlledTransport(job);
    options.configure?.(transport);
    const control = { method: null, fault: null, calls: [], writes: [], lastClaim: null,
      tickStartedAt: null, recoveryActive: false };
    let actualStore = createWorkerStore(faultPool(runtime, control));
    const store = Object.fromEntries(Object.keys(actualStore).map(name => [name, async (...args) => {
      control.method = name; control.phase = name === 'fenceIntent' ? args[2] : null;
      const change = ['checkpoint', 'beginRepair'].includes(name) ? args[1] : name === 'finishRun' ? args[2] : null;
      const effectiveDeadline = Math.min(control.lastClaim?.deadline ?? Infinity,
        (control.tickStartedAt ?? Date.now()) + TICK_DEADLINE_MS);
      const publicationDeadline = effectiveDeadline - FINALIZATION_GRACE_MS;
      const outcomeDeadline = publicationDeadline - PUBLICATION_WINDOW_MS;
      const modelDeadline = outcomeDeadline - MODEL_OUTCOME_WINDOW_MS;
      const modelAdmissionDeadline = modelDeadline - MODEL_MINIMUM_MS - POST_RESERVATION_AUTH_MS;
      const postReservationDeadline = modelDeadline - MODEL_MINIMUM_MS;
      const publisherDeadline = Math.min(publicationDeadline,
        (transport.state.publisherBudgetStartedAt ?? Infinity)
          + transport.publicationDependencies.timeoutMs);
      const requestedDeadline = args.at(-1)?.deadline;
      // Snapshot reads occur in authorization, publication, and finalization.
      // Each accepted cutoff is derived independently from the tick, never from a response.
      const snapshotDeadlines = [effectiveDeadline, publicationDeadline,
        modelAdmissionDeadline, postReservationDeadline];
      const expectedSnapshotDeadline = snapshotDeadlines.find(value => value === requestedDeadline)
        ?? effectiveDeadline;
      const expectedDeadline = name === 'claimTick' ? (control.tickStartedAt ?? Date.now()) + TICK_DEADLINE_MS
        : name === 'reserveModelCall' ? postReservationDeadline
          : name === 'recordModelCallOutcome' ? outcomeDeadline
            : name === 'getCoordinatorSnapshot' ? expectedSnapshotDeadline
              : ['getRun', 'putIntent'].includes(name) ? publicationDeadline
              : ['fenceIntent', 'confirmIntent'].includes(name) ? publisherDeadline : effectiveDeadline;
      if (requestedDeadline !== undefined && !Number.isFinite(requestedDeadline)) {
        throw new Error('Coordinator fixture received an invalid deadline.');
      }
      control.calls.push({ name, deadline: requestedDeadline,
        expectedDeadline,
        evidence: change?.evidence ? structuredClone(change.evidence) : null,
        terminalState: name === 'finishRun' ? args[1] : null,
        change: ['checkpoint', 'beginRepair'].includes(name) ? structuredClone(args[1]) : null });
      try {
        if (control.beforeStore) await control.beforeStore(name, args);
        const value = await actualStore[name](...args);
        if (name === 'claimTick' && value.status === 'claimed') {
          control.lastClaim = value;
          control.recoveryActive = false;
          transport.state.runId = value.lease.runId;
          if (!ids.includes(value.lease.runId)) ids.push(value.lease.runId);
        }
        if (name === 'getRun') control.recoveryActive = true;
        if (name === 'confirmIntent' || name === 'finishRun') control.recoveryActive = false;
        if (name === 'getCoordinatorSnapshot' && value.status === 'owned') {
          transport.state.phase = value.phase; transport.state.selected = value.phase?.expectedRegression;
        }
        if (control.afterStore) await control.afterStore(name, args, value);
        return value;
      } finally { control.method = null; }
    }]));
    const environment = { AGENT_WORKER_ENABLED: 'true', NEON_BRANCH: 'production',
      // Satisfies strict configuration validation only. The injected local pool uses no TLS.
      AGENT_WORKER_DATABASE_URL: `postgresql://${ROLE}:synthetic@db.invalid/worker?sslmode=verify-full` };
    const context = { ...transport, owner, runtime, actualStore, store, control, job, ids, environment, diagnostics,
      native: true, activation: true, reports: [], results: [],
      dependencies: { store, manifest: transport.manifest, expectedManifestSha256: hash(canonical(transport.manifest)),
        policyManifest: transport.policyManifest, triggerId: 'trusted-trigger', readToken: 'synthetic-read-private',
        ownedActor: transport.actor, fetch: transport.fetch, model: transport.model,
        publicationDependencies: transport.publicationDependencies,
        adapters: { createAgentWorker: transport.createAgentWorker } },
      restart({ futureReview = false } = {}) {
        actualStore = createWorkerStore(faultPool(runtime, control)); context.actualStore = actualStore;
        const dependencies = { ...context.dependencies, adapters: { ...context.dependencies.adapters,
          ...(futureReview ? { review: { readReview: async () => {
            const result = context.state.review === 'waiting' ? { status: 'waiting' } : context.syntheticFutureReview();
            await context.afterFutureReview?.(result); return result;
          } } } : {}) } };
        context.handle = createWorkerFunction({ env: environment,
          trustedConfig: { productionBranch: 'production', triggerId: 'trusted-trigger', databaseRole: ROLE },
          verifyNativeRequest: async () => context.native, authorizeRuntime: async () => context.activation,
          advanceTick: async delivery => {
            control.tickStartedAt = Date.now();
            const coordinator = createCoordinator({ ...dependencies,
              deadline: control.tickStartedAt + TICK_DEADLINE_MS });
            const result = await coordinator.advanceTick(delivery);
            context.results.push(result);
            return result;
          }, report: line => context.reports.push(line) });
      },
      observeChecks(afterRead) {
        // Await the actual parser/authenticator, then control only result delivery timing.
        const reader = createCheckReader({ token: 'synthetic-read-private',
          repository: transport.manifest.repository.name, fetch: transport.fetch });
        context.dependencies.adapters.checks = Object.fromEntries(['readChecks', 'readFailure'].map(name => [name,
          async input => { const result = await reader[name](input); await afterRead(name, result); return result; }]));
      },
      observeReview(afterRead) {
        const reader = createReviewReader({ token: 'synthetic-read-private',
          repositoryId: transport.manifest.repository.id, fetch: transport.fetch });
        context.dependencies.adapters.review = { async readReview(input) {
          const result = await reader.readReview(input); await afterRead(result); return result;
        } };
      },
      observeApproval(afterRead) {
        context.dependencies.adapters.checkApproval = async input => {
          const result = await checkApproval(input); await afterRead(result); return result;
        };
      },
      request({ id = randomUUID(), path = '/tick', method = 'POST', body, headers = {} } = {}) {
        return new Request(`https://worker.invalid${path}`, { method, headers: {
          'content-type': 'application/json', 'x-neon-trigger-invocation-id': id, ...headers },
          ...(['GET', 'HEAD'].includes(method) ? {} : { body: body ?? JSON.stringify({ version: 1,
            invocation_id: id, trigger: { type: 'schedule', id: 'trusted-trigger', name: 'issueworkertick' },
            data: { scheduled_at: '2026-06-01T00:00:00.000Z' } }) }) });
      },
      async tick(requestOptions) {
        const response = await context.handle.fetch(context.request(requestOptions));
        const body = await response.json();
        assert.equal(Object.keys(body).length, 1); assert.equal(response.headers.get('cache-control'), 'no-store');
        return { code: response.status, status: body.status };
      },
      async claim() {
        return context.actualStore.claimTick({ invocationId: randomUUID(), manifest: {
          repositoryId: job.repositoryId, repositoryFullName: job.repositoryFullName,
          issueId: job.issueId, issueNumber: job.issueNumber, actorId: job.actorId,
          manifestHash: context.dependencies.expectedManifestSha256,
          baseRevision: transport.manifest.base.revision, policyRevision: transport.manifest.policyRevision,
          limits: transport.manifest.limits } });
      },
      async terminalEvents() {
        const { rows } = await runtime.query(`SELECT state FROM agent_worker.events
          WHERE run_id IN (SELECT run_id FROM agent_worker.runs WHERE job_id=$1)
          AND event_type='run_terminal'`, [job.jobId]);
        return rows;
      },
      async row() {
        const { rows } = await runtime.query('SELECT * FROM agent_worker.runs WHERE job_id=$1', [job.jobId]);
        return rows[0];
      },
      async operations() {
        const { rows } = await runtime.query(`SELECT * FROM agent_worker.operations WHERE run_id IN
          (SELECT run_id FROM agent_worker.runs WHERE job_id=$1) ORDER BY created_at,operation_id`, [job.jobId]);
        return rows;
      },
      async rejectsWrongPassword() {
        const wrong = new URL(url); wrong.password = randomUUID();
        const pool = new pg.Pool({ connectionString: wrong.toString(), connectionTimeoutMillis: 5000 });
        pool.on('error', () => {});
        try { await pool.query('SELECT 1'); return false; }
        catch (error) { return error.code === '28P01'; }
        finally { await pool.end(); }
      },
      async expireLease() {
        // Owner-only fault setup against this fixture's ID, using the actual SQL server clock.
        await owner.query(`UPDATE agent_worker.runs SET lease_started_at=clock_timestamp()-interval '200 seconds',
          lease_expires_at=clock_timestamp()-interval '1 second' WHERE job_id=$1 AND terminal_at IS NULL
          AND lease_token IS NOT NULL`, [job.jobId]);
      },
      async close() {
        try {
          // No table reset: terminalize only this fixture's known job and run identities.
          await owner.query(`UPDATE agent_worker.runs SET state='cancelled', terminal_at=clock_timestamp(),
            lease_token=NULL,lease_started_at=NULL,lease_expires_at=NULL
            WHERE job_id=$1 AND terminal_at IS NULL`, [job.jobId]);
        } finally { await runtime.end(); await owner.end(); }
      } };
    context.restart();
    return context;
  } catch (error) {
    if (runtime) await runtime.end(); await owner.end(); throw error;
  }
}
export async function withCoordinator(body, options) {
  const context = await setupCoordinator(options);
  try { await body(context); } finally { await context.close(); }
}
export async function expectTick(context, status) {
  assert.deepEqual(await context.tick(), { code: 200, status },
    `Safe coordinator receipt: ${JSON.stringify(context.results.at(-1))}; SQL states: ${JSON.stringify(context.diagnostics.slice(-4))}`);
}
export async function toRed(context) {
  await expectTick(context, 'advanced'); await expectTick(context, 'advanced');
  assert.equal((await context.row()).state, 'waiting_red_ci');
}
export async function toImplementation(context) {
  await toRed(context); context.state.ci = 'red'; await expectTick(context, 'advanced');
  assert.equal((await context.row()).phase_purpose, 'initial_implementation');
}
export async function toGreen(context) {
  await toImplementation(context); await expectTick(context, 'advanced');
  assert.equal((await context.row()).state, 'waiting_ci'); context.state.ci = 'green';
}
export async function toReview(context) {
  await toGreen(context); await expectTick(context, 'advanced');
  await expectTick(context, 'advanced'); assert.equal((await context.row()).state, 'waiting_review');
}
