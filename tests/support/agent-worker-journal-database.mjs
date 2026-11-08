import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { openDisposablePool } from './agent-intake-database.mjs';
import { createWorkerStore } from '../../src/automation/worker/store.mjs';
import { buildCoordinatorPhaseKey } from '../../src/automation/worker/store-validation.mjs';

export const SAFE = { message: 'Worker storage operation failed.' };
export const HEAD = 'a'.repeat(40);
export const CHILD = 'c'.repeat(40);
export const HASH = 'b'.repeat(64);
export const ROLE = 'journal_test_runtime';
export const hash = value => createHash('sha256').update(value).digest('hex');
export const limits = Object.freeze({ nonterminalPilotRuns: 1, modelCallsPerTick: 1,
  modelCallsPerRun: 20, inputTokensPerCall: 8000, outputTokensPerCall: 2000,
  inputTokensPerRun: 100000, outputTokensPerRun: 20000, tickDeadlineSeconds: 90,
  modelCallDeadlineSeconds: 45, leaseSeconds: 180, expiredLeaseRecoveries: 2,
  ciWaitSeconds: 1800, reviewWaitSeconds: 1800, runLifetimeSeconds: 7200, repairCycles: 2 });
let initialization;
let runtimePassword;
let issueSequence = 70000;

// Never let pg response details or connection options reach node:test diagnostics.
function privateError(error) {
  const safe = new Error('Journal database operation rejected; private details withheld.');
  safe.code = /^[A-Z0-9]{5}$/.test(error?.code ?? '') ? error.code : 'PRIVATE';
  safe.constraint = /^[a-z_][a-z0-9_]*$/.test(error?.constraint ?? '') ? error.constraint : null;
  return safe;
}
function protectedPool(pool) {
  let idleError;
  pool.on('error', error => { idleError = privateError(error); });
  const query = async (target, sql, values) => {
    if (idleError) throw idleError;
    try { return await target.query(sql, values); } catch (error) { throw privateError(error); }
  };
  return {
    query: (sql, values) => query(pool, sql, values),
    async connect() {
      let client;
      if (idleError) throw idleError;
      try { client = await pool.connect(); } catch (error) { throw privateError(error); }
      return { query: (sql, values) => query(client, sql, values),
        release: discard => client.release(discard) };
    },
    end: () => pool.end(),
  };
}

export async function setupJournal({ manifestOverrides = {}, jobOverrides = {} } = {}) {
  // The marker is verified on a real connection before *any* migration or grant.
  const owner = protectedPool(await openDisposablePool());
  let runtime;
  const runIds = [];
  try {
    initialization ??= (async () => {
      for (const path of ['agent-intake/001-initial.sql', 'agent-worker/001-initial.sql',
        'agent-worker/002-recovery.sql', 'agent-worker/003-coordinator.sql']) {
        await owner.query(await readFile(new URL(`../../migrations/${path}`, import.meta.url), 'utf8'));
      }
      runtimePassword = randomUUID();
      // The password is generated locally, never accepted from callers or printed.
      await owner.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${runtimePassword}'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
      await owner.query(`GRANT USAGE ON SCHEMA agent_intake, agent_worker TO ${ROLE}`);
      await owner.query(`GRANT SELECT ON agent_intake.jobs TO ${ROLE}`);
      await owner.query(`GRANT SELECT, INSERT, UPDATE ON agent_worker.runs, agent_worker.operations TO ${ROLE}`);
      await owner.query(`GRANT SELECT, INSERT ON agent_worker.events, agent_worker.candidate_descriptors TO ${ROLE}`);
      await owner.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA agent_worker TO ${ROLE}`);
    })();
    await initialization;
    const url = new URL(process.env.AGENT_INTAKE_TEST_DATABASE_URL);
    url.username = ROLE;
    url.password = runtimePassword;
    runtime = protectedPool(new pg.Pool({ connectionString: url.toString(), max: 4,
      connectionTimeoutMillis: 10000, statement_timeout: 10000, query_timeout: 10000 }));
    const job = { jobId: randomUUID(), repositoryId: 123456,
      repositoryFullName: 'randoneering/mellon', issueId: issueSequence++,
      issueNumber: issueSequence++, actorId: 42, ...jobOverrides };
    await owner.query(`INSERT INTO agent_intake.jobs
      (job_id, repository_id, repository_full_name, issue_id, issue_number, actor_id, initial_delivery_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [job.jobId, job.repositoryId, job.repositoryFullName,
      job.issueId, job.issueNumber, job.actorId, randomUUID()]);
    const manifest = { repositoryId: job.repositoryId, repositoryFullName: job.repositoryFullName,
      issueId: job.issueId, issueNumber: job.issueNumber, actorId: job.actorId,
      manifestHash: hash(job.jobId), baseRevision: HEAD, policyRevision: 'e'.repeat(40),
      limits: { ...limits }, ...manifestOverrides };
    const worker = createWorkerStore(runtime);
    const context = { owner, runtime, worker, job, manifest, runIds,
      async claim(store = worker) {
        const result = await store.claimTick({ invocationId: randomUUID(), manifest });
        assert.equal(result.status, 'claimed');
        if (!runIds.includes(result.lease.runId)) runIds.push(result.lease.runId);
        context.lease = result.lease;
        return result.lease;
      },
      async row() {
        const result = await runtime.query('SELECT * FROM agent_worker.runs WHERE run_id = $1', [context.lease.runId]);
        return result.rows[0];
      },
      async close() {
        try {
          // Finish only IDs created by this fixture, never reset tables or other runs.
          await owner.query(`UPDATE agent_worker.runs SET state = 'cancelled',
            terminal_at = clock_timestamp(), lease_token = NULL, lease_started_at = NULL,
            lease_expires_at = NULL WHERE run_id = ANY($1::uuid[]) AND terminal_at IS NULL`, [runIds]);
        } finally { await runtime.end(); await owner.end(); }
      } };
    await context.claim();
    return context;
  } catch (error) {
    if (runtime) await runtime.end();
    await owner.end();
    throw error;
  }
}

export async function withJournal(body, options) {
  const context = await setupJournal(options);
  try { await body(context); } finally { await context.close(); }
}
export function phase(context, purpose = 'initial_tests', overrides = {}) {
  const row = { repairCycle: 0, headSha: context.manifest.baseRevision,
    findingSha256: null, ...overrides };
  return { version: 1, purpose, key: buildCoordinatorPhaseKey({ runId: context.lease.runId,
    manifestSha256: context.manifest.manifestHash, purpose, ...row }), ...row };
}
export async function initialize(context) {
  const p = phase(context);
  assert.equal(await context.worker.checkpoint(context.lease,
    { state: 'generating_tests', coordinator: p }), true);
  await context.claim();
  return p;
}
export function modelRequest(context, overrides = {}) {
  return { key: hash(randomUUID()), inputHash: HASH, expectedHeadSha: context.manifest.baseRevision,
    inputTokens: 10, outputTokens: 10, ...overrides };
}
export async function successfulModel(context, overrides = {}) {
  const reservation = await context.worker.reserveModelCall(context.lease, modelRequest(context, overrides));
  assert.equal(reservation.status, 'reserved');
  assert.equal(reservation.canExecute, true);
  const result = await context.worker.recordModelCallOutcome(context.lease,
    { operationId: reservation.operationId, outcome: 'success', actualInputTokens: 8, actualOutputTokens: 8 });
  assert.equal(result.status, 'recorded');
  return reservation.operationId;
}
export function descriptor(overrides = {}) {
  return { approvedPathIndex: 0, operation: 'create', beforeBlobSha: null,
    afterBlobSha: CHILD, contentSha256: HASH, bytes: 100, mode: '100644', ...overrides };
}
export function candidate(context, p, modelOperationId, overrides = {}) {
  const inputHash = hash(randomUUID());
  return { key: hash(randomUUID()), kind: 'commit_create', inputHash,
    expectedHeadSha: p.headSha, coordinator: { version: 1, purpose: p.purpose,
      phaseKey: p.key, repairCycle: p.repairCycle, modelOperationId,
      expectedRegression: { workflowId: 7, testIdentitySha256: HASH, proposalSha256: inputHash },
      criterionSha256: HASH, candidateDescriptors: [descriptor()] }, ...overrides };
}
export function proof(context, intent, child = CHILD) {
  return { status: 'confirmed', branch: `agent-work/${context.lease.runId}`,
    inputHash: intent.inputHash, baseSha: context.manifest.baseRevision,
    parentSha: intent.expectedHeadSha, commitSha: child, treeSha: 'd'.repeat(40), branchHeadSha: child };
}
export async function prepared(context) {
  const p = await initialize(context);
  const modelId = await successfulModel(context);
  const intent = candidate(context, p, modelId);
  const result = await context.worker.putIntent(context.lease, intent);
  assert.equal(result.status, 'created');
  return { p, modelId, intent, operationId: result.operation.operationId };
}
export async function rejectedQuery(pool, sql, values, codes = ['23514', '23503', '23505', 'P0001']) {
  await assert.rejects(pool.query(sql, values), error => codes.includes(error.code));
}
export async function rolledBack(pool, body) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await body(client);
  } finally { await client.query('ROLLBACK'); client.release(); }
}

// Only the acknowledgment is faulted. Every other statement uses the real pg driver.
export function acknowledgmentLoss(pool, { afterCommit, transaction = 1 }) {
  let transactions = 0;
  let injected = false;
  return { get injected() { return injected; }, query: pool.query,
    async connect() {
      const client = await pool.connect();
      let selected = false;
      return {
        async query(sql, values) {
          if (sql === 'BEGIN') selected = ++transactions === transaction;
          if (selected && sql === 'COMMIT' && !afterCommit && !injected) {
            injected = true;
            throw new Error('Synthetic acknowledgment loss.');
          }
          const result = await client.query(sql, values);
          if (selected && sql === 'COMMIT' && afterCommit && !injected) {
            injected = true;
            throw new Error('Synthetic acknowledgment loss.');
          }
          return result;
        }, release: client.release,
      };
    } };
}
