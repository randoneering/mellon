import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { before, after } from 'node:test';
import pg from 'pg';
import { openDisposablePool } from './agent-intake-database.mjs';
import { createWorkerDatabase } from '../../src/automation/worker/pool.mjs';
import { createWorkerStore } from '../../src/automation/worker/store.mjs';
import { manifest } from '../fixtures/worker-candidates/inputs.mjs';

const ROLE = 'mellon_runtime_worker_test';
let owner;
let database;
let lastReceipt;
let lastSqlState;
let nextIssueId = 800001;
async function admin(text, values) {
  try { return await owner.query(text, values); }
  catch { throw new Error('Disposable runtime database setup failed; private details withheld.'); }
}

before(async () => {
  owner = await openDisposablePool();
  for (const path of ['agent-intake/001-initial.sql', 'agent-worker/001-initial.sql',
    'agent-worker/002-recovery.sql', 'agent-worker/003-coordinator.sql']) {
    await admin(await readFile(new URL(`../../migrations/${path}`, import.meta.url), 'utf8'));
  }
  const password = randomUUID();
  await admin(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${password}'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION`);
  await admin(`GRANT USAGE ON SCHEMA agent_intake, agent_worker TO ${ROLE}`);
  await admin(`GRANT SELECT ON agent_intake.jobs TO ${ROLE}`);
  await admin(`GRANT SELECT, INSERT, UPDATE ON agent_worker.runs, agent_worker.operations TO ${ROLE}`);
  await admin(`GRANT SELECT, INSERT ON agent_worker.events, agent_worker.candidate_descriptors TO ${ROLE}`);
  await admin(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA agent_worker TO ${ROLE}`);
  class LocalPlaintextPool extends pg.Pool {
    constructor(options) {
      // The fresh Docker server has no TLS; production attestation must reject that fact.
      super({ ...options, ssl: false });
      this.on('connect', client => {
        const query = client.query.bind(client);
        client.query = (...args) => {
          if (typeof args.at(-1) === 'function') return query(...args);
          return Promise.resolve(query(...args)).then(result => {
            if (typeof args[0]?.text === 'string' && args[0].text.includes('AS role_name')) {
              lastReceipt = result.rows[0];
            }
            return result;
          }, error => {
            lastSqlState = /^[A-Z0-9]{5}$/.test(error?.code ?? '') ? error.code : 'unknown';
            throw new Error('Disposable runtime query failed; private details withheld.');
          });
        };
      });
    }
  }
  const url = new URL(process.env.AGENT_INTAKE_TEST_DATABASE_URL);
  url.username = ROLE; url.password = password; url.search = '?sslmode=verify-full';
  database = createWorkerDatabase({ env: { AGENT_WORKER_DATABASE_URL: url.toString() },
    databaseRole: ROLE, report() {} }, { Pool: LocalPlaintextPool });
});

after(async () => {
  try { await database?.close(); } finally { await owner?.end(); }
});

async function receipt(inputTokensPerCall = 65536) {
  lastReceipt = null; lastSqlState = null;
  await assert.rejects(database.verifyRole({ limits: { ...manifest().limits, inputTokensPerCall } }),
    { message: 'Worker database role could not be verified.' });
  assert.ok(lastReceipt, `The catalog SQL must execute; safe SQL state: ${lastSqlState ?? 'none'}`);
  return lastReceipt;
}

test('actual catalog query accepts the reviewed grants and ceiling but rejects plaintext transport', async () => {
  const row = await receipt();
  assert.equal(row.role_name, ROLE); assert.equal(row.session_role, ROLE);
  assert.equal(row.ssl, false); assert.equal(row.grants_ok, true); assert.equal(row.limits_ok, true);
  for (const key of ['rolsuper', 'rolbypassrls', 'rolcreatedb', 'rolcreaterole',
    'rolreplication', 'rolinherit', 'has_memberships', 'owns_database', 'owns_app_objects',
    'database_create', 'schema_create']) assert.equal(row[key], false, key);
});

test('actual limits function rejects a reservation above the approved ceiling', async () => {
  assert.equal((await receipt(65537)).limits_ok, false);
});

for (const [name, grant, revoke] of [
  ['intake writes', `GRANT UPDATE ON agent_intake.jobs TO ${ROLE}`, `REVOKE UPDATE ON agent_intake.jobs FROM ${ROLE}`],
  ['run deletion', `GRANT DELETE ON agent_worker.runs TO ${ROLE}`, `REVOKE DELETE ON agent_worker.runs FROM ${ROLE}`],
]) test(`actual grant attestation detects ${name}`, async () => {
  await admin(grant);
  try { assert.equal((await receipt()).grants_ok, false); }
  finally { await admin(revoke); }
  assert.equal((await receipt()).grants_ok, true);
});

test('actual role membership and inheritance are visible to attestation', async () => {
  await admin('CREATE ROLE mellon_runtime_parent_test NOLOGIN');
  await admin(`GRANT mellon_runtime_parent_test TO ${ROLE}`);
  try { assert.equal((await receipt()).has_memberships, true); }
  finally { await admin(`REVOKE mellon_runtime_parent_test FROM ${ROLE}`); }
  await admin(`ALTER ROLE ${ROLE} INHERIT`);
  try { assert.equal((await receipt()).rolinherit, true); }
  finally { await admin(`ALTER ROLE ${ROLE} NOINHERIT`); }
});

test('actual database creation privilege and unexpected application-table grants are rejected', async () => {
  await admin(`ALTER ROLE ${ROLE} CREATEDB`);
  try { assert.equal((await receipt()).rolcreatedb, true); }
  finally { await admin(`ALTER ROLE ${ROLE} NOCREATEDB`); }
  await admin('CREATE TABLE agent_worker.runtime_forbidden_test (id integer)');
  await admin(`GRANT SELECT ON agent_worker.runtime_forbidden_test TO ${ROLE}`);
  try { assert.equal((await receipt()).grants_ok, false); }
  finally { await admin(`REVOKE SELECT ON agent_worker.runtime_forbidden_test FROM ${ROLE}`); }
});

async function claim() {
  const jobId = randomUUID();
  const issueId = nextIssueId++;
  await admin(`INSERT INTO agent_intake.jobs
    (job_id, repository_id, repository_full_name, issue_id, issue_number, actor_id, initial_delivery_id)
    VALUES ($1,123456,'randoneering/mellon',$2,$2,42,$3)`, [jobId, issueId, randomUUID()]);
  const worker = createWorkerStore(database.pool);
  const limits = { ...manifest().limits, inputTokensPerCall: 65536 };
  const claimManifest = {
    repositoryId: 123456, repositoryFullName: 'randoneering/mellon', issueId,
    issueNumber: issueId, actorId: 42,
    manifestHash: createHash('sha256').update(jobId).digest('hex'),
    baseRevision: 'b'.repeat(40), policyRevision: 'c'.repeat(40), limits,
  };
  const result = await worker.claimTick({ invocationId: randomUUID(), manifest: claimManifest });
  assert.equal(result.status, 'claimed');
  return { worker, lease: result.lease, claimManifest };
}

test('actual durable store accepts 65536 input reservation and never repeats an existing operation', async () => {
  const { worker, lease } = await claim();
  try {
    const request = { key: 'd'.repeat(64), inputHash: 'e'.repeat(64), expectedHeadSha: 'b'.repeat(40),
      inputTokens: 65536, outputTokens: 2000 };
    assert.equal((await worker.reserveModelCall(lease, request)).canExecute, true);
    const duplicate = await worker.reserveModelCall(lease, request);
    assert.equal(duplicate.status, 'existing'); assert.equal(duplicate.canExecute, false);
    assert.equal((await worker.getRun(lease.runId)).reservedInputTokens, 65536);
  } finally { await worker.finishRun(lease, 'cancelled'); }
});

test('actual durable store permits two bounded initial reservations without refunding reported usage', async () => {
  const { worker, lease: initialLease, claimManifest } = await claim();
  let lease = initialLease;
  try {
    for (const key of ['d', 'e']) {
      const reserved = await worker.reserveModelCall(lease, { key: key.repeat(64),
        inputHash: 'f'.repeat(64), expectedHeadSha: 'b'.repeat(40), inputTokens: 35000, outputTokens: 2000 });
      assert.equal(reserved.canExecute, true);
      assert.equal((await worker.recordModelCallOutcome(lease, { operationId: reserved.operationId,
        outcome: 'success', actualInputTokens: 10000, actualOutputTokens: 100 })).status, 'recorded');
      if (key === 'd') {
        assert.equal(await worker.checkpoint(lease, { state: 'generating_tests' }), true);
        const next = await worker.claimTick({ invocationId: randomUUID(), manifest: claimManifest });
        assert.equal(next.status, 'claimed');
        lease = next.lease;
      }
    }
    const run = await worker.getRun(lease.runId);
    assert.equal(run.reservedInputTokens, 70000); assert.equal(run.modelCallCount, 2);
  } finally { await worker.finishRun(lease, 'cancelled'); }
});
