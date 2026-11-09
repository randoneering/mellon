import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { openDisposablePool } from '../support/agent-intake-database.mjs';

const SAFE_ERROR = 'Worker storage operation failed.';
const RECOVERY_PROOF = 'matching';
const recoveryModule = () => import('../../src/automation/worker/recovery.mjs');
const publisherFixture = () => import('../fixtures/agent-worker-publication.mjs');

function transactionFaultPool(pool, { transaction, afterCommit }) {
  let transactions = 0;
  let injected = false;
  return {
    get injected() { return injected; },
    query: pool.query,
    async connect() {
      const client = await pool.connect();
      let selected = false;
      return {
        async query(sql, values) {
          if (sql === 'BEGIN') selected = ++transactions === transaction;
          if (selected && sql === 'COMMIT' && !afterCommit && !injected) {
            injected = true;
            throw new Error('synthetic transaction acknowledgment loss');
          }
          const result = await client.query(sql, values);
          if (selected && sql === 'COMMIT' && afterCommit && !injected) {
            injected = true;
            throw new Error('synthetic transaction acknowledgment loss');
          }
          return result;
        },
        release: client.release,
      };
    },
  };
}
const enabled = process.env.AGENT_INTAKE_TEST_DATABASE_URL && process.env.AGENT_INTAKE_TEST_RUN_ID;
const dbTest = enabled ? test : test.skip;
const storeUrl = new URL('../../src/automation/worker/store.mjs', import.meta.url);
const moduleStore = await import(storeUrl.href).catch(error =>
  error.code === 'ERR_MODULE_NOT_FOUND' ? {} : Promise.reject(error));
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
const REPOSITORY_ID = 123;
const REPOSITORY_FULL_NAME = 'org/repo';
const ACTOR_ID = 789;
const operationKey = label => createHash('sha256').update(label, 'utf8').digest('hex');
let issueSequence = 12000;
let migrations;

function store(pool) {
  assert.equal(typeof moduleStore.createWorkerStore, 'function', 'missing worker store API');
  return moduleStore.createWorkerStore(pool);
}


function manifestFor(job, overrides = {}) {
  return {
    repositoryId: job.repositoryId,
    repositoryFullName: job.repositoryFullName,
    issueId: job.issueId,
    issueNumber: job.issueNumber,
    actorId: job.actorId,
    manifestHash: operationKey(`manifest:${job.jobId}`),
    baseRevision: 'b'.repeat(40),
    policyRevision: 'c'.repeat(40),
    limits: { ...LIMITS },
    ...overrides,
  };
}

function runtimePool() {
  const pool = new pg.Pool({
    connectionString: process.env.AGENT_INTAKE_TEST_DATABASE_URL,
    max: 4,
    connectionTimeoutMillis: 10000,
    statement_timeout: 10000,
    query_timeout: 10000,
  });
  let storeQueryCount = 0;

  async function asRuntimeRole(query, values) {
    const client = await pool.connect();
    try {
      await client.query('SET ROLE intake_test_runtime');
      storeQueryCount += 1;
      return await client.query(query, values);
    } finally {
      let discard = false;
      try { await client.query('RESET ROLE'); } catch { discard = true; }
      client.release(discard);
    }
  }

  return {
    async connect() {
      storeQueryCount += 1;
      const client = await pool.connect();
      try {
        await client.query('SET ROLE intake_test_runtime');
      } catch (error) {
        client.release();
        throw error;
      }
      let released = false;
      return {
        query(query, values) {
          storeQueryCount += 1;
          return client.query(query, values);
        },
        release(discard = false) {
          if (released) return;
          released = true;
          if (discard) { client.release(true); return; }
          void client.query('RESET ROLE').then(() => client.release(), () => client.release(true));
        },
      };
    },
    query: asRuntimeRole,
    end: () => pool.end(),
    get storeQueryCount() {
      return storeQueryCount;
    },
  };
}

async function setup({ jobCount = 1 } = {}) {
  const ownerPool = await openDisposablePool();
  try {
    migrations ??= (async () => {
      await ownerPool.query(await readFile(new URL('../../migrations/agent-intake/001-initial.sql', import.meta.url), 'utf8'));
      await ownerPool.query(await readFile(new URL('../../migrations/agent-worker/001-initial.sql', import.meta.url), 'utf8'));
      await ownerPool.query(await readFile(new URL('../../migrations/agent-worker/002-recovery.sql', import.meta.url), 'utf8'));
      await ownerPool.query(`CREATE ROLE intake_test_runtime
        NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
      await ownerPool.query('GRANT USAGE ON SCHEMA agent_intake, agent_worker TO intake_test_runtime');
      await ownerPool.query('GRANT SELECT ON agent_intake.jobs TO intake_test_runtime');
      await ownerPool.query('GRANT SELECT, INSERT, UPDATE ON agent_worker.runs, agent_worker.operations TO intake_test_runtime');
      await ownerPool.query('GRANT SELECT, INSERT ON agent_worker.events TO intake_test_runtime');
      await ownerPool.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA agent_worker TO intake_test_runtime');
    })();
    await migrations;

    const jobs = [];
    for (let index = 0; index < jobCount; index += 1) {
      const job = {
        jobId: randomUUID(),
        repositoryId: REPOSITORY_ID,
        repositoryFullName: REPOSITORY_FULL_NAME,
        issueId: issueSequence++,
        issueNumber: issueSequence + 100,
        actorId: ACTOR_ID,
        deliveryId: randomUUID(),
      };
      await ownerPool.query(`INSERT INTO agent_intake.jobs
        (job_id, repository_id, repository_full_name, issue_id, issue_number, actor_id, initial_delivery_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
        job.jobId,
        job.repositoryId,
        job.repositoryFullName,
        job.issueId,
        job.issueNumber,
        job.actorId,
        job.deliveryId,
      ]);
      jobs.push(job);
    }

    return { ownerPool, workerPool: runtimePool(), jobs };
  } catch (error) {
    await ownerPool.end();
    throw error;
  }
}

async function close({ ownerPool, workerPool, jobs }) {
  try {
    // Keep a failed assertion from leaving the global pilot slot occupied.
    await ownerPool.query(`UPDATE agent_worker.runs SET state = 'cancelled',
      terminal_at = clock_timestamp(), lease_token = NULL, lease_started_at = NULL,
      lease_expires_at = NULL WHERE job_id = ANY($1::uuid[]) AND terminal_at IS NULL`,
    [jobs.map(job => job.jobId)]);
  } finally {
    await workerPool.end();
    await ownerPool.end();
  }
}

async function expectResolved(promise, message) {
  const outcome = await Promise.resolve(promise).then(
    value => ({ resolved: true, value }),
    () => ({ resolved: false }),
  );
  assert.equal(outcome.resolved, true, message);
  return outcome.value;
}

async function expectRejectedBeforeSql(workerPool, call, label) {
  const before = workerPool.storeQueryCount;
  let error;
  try {
    await call();
  } catch (caught) {
    error = caught;
  }
  assert.equal(error instanceof Error, true, `${label} must be rejected`);
  assert.equal(error?.message === SAFE_ERROR, true, `${label} must use the fixed error`);
  assert.equal(workerPool.storeQueryCount, before, `${label} must be rejected before SQL`);
}

function fakeLease() {
  return {
    runId: randomUUID(),
    jobId: randomUUID(),
    repositoryId: REPOSITORY_ID,
    repositoryFullName: REPOSITORY_FULL_NAME,
    issueId: 999999,
    issueNumber: 999,
    actorId: ACTOR_ID,
    generation: 1,
    token: randomUUID(),
    expiresAt: new Date(Date.now() + 180000).toISOString(),
  };
}

dbTest('remote-effect intents and proof references persist as fixed typed columns', async () => {
  const context = await setup();
  try {
    const worker = store(context.workerPool);
    const { jobs: [job] } = context;
    const claim = await worker.claimTick({ invocationId: randomUUID(), manifest: manifestFor(job) });
    const intent = await worker.putIntent(claim.lease, {
      key: operationKey('recovery-red'), kind: 'branch_create',
      inputHash: 'd'.repeat(64), expectedHeadSha: 'b'.repeat(40),
    });
    assert.equal(intent.status, 'created');
    const { rows } = await context.ownerPool.query(`SELECT effect_phase, effect_reference
      FROM agent_worker.operations WHERE operation_id = $1`, [intent.operation.operationId]);
    assert.deepEqual(rows, [{ effect_phase: 'prepared', effect_reference: null }]);
  } finally {
    await close(context);
  }
});

dbTest('durable publication phases cannot execute twice and stale generations cannot confirm', async () => {
  const context = await setup();
  try {
    const worker = store(context.workerPool);
    const manifest = manifestFor(context.jobs[0]);
    const invocationId = randomUUID();
    const claim = await worker.claimTick({ invocationId, manifest });
    assert.equal(claim.status, 'claimed');
    const intent = { key: operationKey('phase-fence'), kind: 'commit_create',
      inputHash: 'd'.repeat(64), expectedHeadSha: manifest.baseRevision };
    assert.equal((await worker.putIntent(claim.lease, intent)).status, 'created');
    assert.equal((await worker.putIntent(claim.lease, { ...intent,
      key: operationKey('replacement-key') })).status, 'conflict',
    'changing an operation key must not bypass uncertain-effect reconciliation');
    assert.equal((await worker.claimTick({ invocationId, manifest })).status, 'busy');
    for (const phase of ['branch', 'commit']) {
      const results = await Promise.all([
        worker.fenceIntent(claim.lease, intent, phase),
        worker.fenceIntent(claim.lease, intent, phase),
      ]);
      assert.deepEqual(results.map(result => result.decision).sort(), ['execute', 'reconcile_only']);
    }
    await context.ownerPool.query(`UPDATE agent_worker.runs
      SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE run_id = $1`,
    [claim.lease.runId]);
    const next = await worker.claimTick({ invocationId: randomUUID(), manifest });
    assert.equal(next.status, 'claimed');
    assert.equal((await worker.fenceIntent(claim.lease, intent, 'commit')).status, 'stale');
    assert.equal((await worker.fenceIntent(next.lease, intent, 'commit')).decision, 'reconcile_only');
    const proof = { status: 'confirmed', branch: `agent-work/${claim.lease.runId}`,
      inputHash: intent.inputHash, baseSha: manifest.baseRevision,
      parentSha: manifest.baseRevision, commitSha: 'e'.repeat(40),
      treeSha: 'f'.repeat(40), branchHeadSha: 'e'.repeat(40) };
    assert.equal(await worker.confirmIntent(claim.lease, intent, proof), false);
    assert.equal(await worker.confirmIntent(next.lease, intent, proof), true);
    assert.equal(await worker.checkpoint(next.lease, { state: 'waiting_review' }), true);
    const later = await worker.claimTick({ invocationId: randomUUID(), manifest });
    assert.equal(later.status, 'claimed');
    assert.equal(await worker.confirmIntent(later.lease, intent, proof), true);
    assert.equal((await worker.getRun(claim.lease.runId)).state, 'waiting_review',
      'duplicate confirmations must not rewind later checkpoints');
    const result = await context.ownerPool.query(`SELECT effect_phase, effect_reference
      FROM agent_worker.operations WHERE run_id = $1`, [claim.lease.runId]);
    assert.deepEqual(result.rows, [{ effect_phase: 'confirmed', effect_reference: proof.commitSha }]);
    assert.equal((await worker.getRun(claim.lease.runId)).expectedHeadSha, proof.commitSha);
  } finally { await close(context); }
});

dbTest('actual transactions reconcile lost intent, fence, and confirmation acknowledgments without remote replay', async t => {
  const { createRecoveryCoordinator } = await recoveryModule();
  const { createDraftPrFixture, createPublisherFixture, RUN_ID, BASE_SHA, COMMIT_SHA, CHANGE_PATH } = await publisherFixture();
  const { validateChanges } = await import('../../src/automation/worker/patch.mjs');
  const { buildDraftPrOperationHash, buildOperationHash, validationBaseFromTree } = await import('../../src/automation/worker/publication-validation.mjs');
  for (const effectKind of ['commit_create', 'pr_create']) {
  const isPr = effectKind === 'pr_create';
  for (const transaction of isPr ? [1, 2, 3, 4, 5, 6, 'pr'] : [1, 2, 3, 4, 5, 'branch', 'commit']) {
    for (const afterCommit of typeof transaction === 'number' ? [false, true] : [false]) {
      const label = typeof transaction === 'number'
        ? `transaction ${transaction}, after commit ${afterCommit}` : `lease lost before ${transaction}`;
      await t.test(`${effectKind}: ${label}`, async () => {
        const context = await setup();
        try {
          const job = context.jobs[0];
          Object.assign(job, { repositoryId: 123456, repositoryFullName: 'randoneering/mellon', actorId: 42 });
          await context.ownerPool.query(`UPDATE agent_intake.jobs SET repository_id = $2,
            repository_full_name = $3, actor_id = $4 WHERE job_id = $1`,
          [job.jobId, job.repositoryId, job.repositoryFullName, job.actorId]);
          const fixture = (isPr ? createDraftPrFixture : createPublisherFixture)({
            loseBranchAck: true, loseCommitAck: true, losePrAck: true,
            manifest: { issue: { id: job.issueId, number: job.issueNumber, contentSha256: '1'.repeat(64) } } });
          const manifest = manifestFor(job, { manifestHash: fixture.request.run.manifestSha256,
            baseRevision: BASE_SHA, policyRevision: fixture.request.approvedManifest.policyRevision });
          const worker = store(context.workerPool);
          const invocationId = randomUUID();
          const claim = await worker.claimTick({ invocationId, manifest });
          assert.equal(claim.status, 'claimed');
          fixture.request.run.id = claim.lease.runId;
          // Simulate a previously confirmed commit, then let the fixed adapter verify it remotely.
          if (isPr) await context.ownerPool.query(`UPDATE agent_worker.runs
            SET expected_head_sha = $2, branch_name = $3 WHERE run_id = $1`,
          [claim.lease.runId, COMMIT_SHA, `agent-work/${claim.lease.runId}`]);
          fixture.context.signingPreflight.expiresAt = fixture.context.contextExpiresAt;
          const rawFetch = fixture.dependencies.fetch;
          const dependencies = { ...fixture.dependencies,
            async fetch(url, init) {
              const response = await rawFetch(String(url).replaceAll(claim.lease.runId, RUN_ID), {
                ...init, ...(init.body ? { body: init.body.replaceAll(claim.lease.runId, RUN_ID) } : {}),
              });
              return new Response((await response.text()).replaceAll(RUN_ID, claim.lease.runId),
                { status: response.status, headers: response.headers });
            } };
          if (isPr) {
            const initialChecks = dependencies.checkInitialChecks;
            dependencies.checkInitialChecks = async request => ({ ...await initialChecks(request),
              branch: `agent-work/${claim.lease.runId}` });
          }
          const intent = { key: fixture.request.intent.id, kind: effectKind,
            expectedHeadSha: fixture.request.run.expectedHeadSha,
            inputHash: isPr ? buildDraftPrOperationHash(fixture.request)
              : buildOperationHash(fixture.request, validateChanges(
              validationBaseFromTree(new Map(), [CHANGE_PATH]), fixture.request.proposedChanges,
              { allowedPaths: fixture.request.approvedManifest.allowedPaths,
                pilotScope: fixture.request.approvedManifest.pilotScope })) };
          const input = { lease: claim.lease, deadline: claim.deadline,
            intent, publication: fixture.request };
          if (typeof transaction === 'string') {
            const checkApproval = dependencies.checkApproval;
            dependencies.checkApproval = async request => {
              const approved = await checkApproval(request);
              if (fixture.state.approvalCalls === (transaction === 'commit' ? 3 : 2)) {
                await context.ownerPool.query(`UPDATE agent_worker.runs
                  SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE run_id = $1`,
                [claim.lease.runId]);
                const next = await worker.claimTick({ invocationId: randomUUID(), manifest });
                assert.equal(next.status, 'claimed');
                assert.ok(next.lease.generation > claim.lease.generation);
              }
              return approved;
            };
          }
          const pool = transactionFaultPool(context.workerPool, { transaction, afterCommit });
          const first = await createRecoveryCoordinator({ store: store(pool),
            publicationDependencies: dependencies }).perform(input);
          assert.equal(pool.injected, typeof transaction === 'number');
          assert.equal(first.status, 'needs_attention');
          assert.equal(first.reason, typeof transaction === 'number'
            ? 'recovery_database_uncertain' : 'recovery_lease_lost');
          if (typeof transaction === 'string') {
            assert.equal(fixture.state.branchWrites, transaction === 'commit' ? 1 : 0);
            assert.equal(fixture.state.commitWrites, 0);
            if (isPr) assert.equal(fixture.state.prWrites, 0);
            assert.equal(first.persisted, false, 'stale owner cannot stop its successor');
          }
          assert.equal((await worker.claimTick({ invocationId, manifest })).status, 'busy');
          const second = await createRecoveryCoordinator({ store: worker,
            publicationDependencies: dependencies }).perform(input);
          assert.ok(['confirmed', 'needs_attention'].includes(second.status));
          assert.ok(fixture.state.branchWrites <= 1);
          assert.ok(fixture.state.commitWrites <= 1);
          if (isPr) assert.ok(fixture.state.prWrites <= 1);
          if (transaction >= 4) {
            assert.equal(second.status, 'confirmed');
            assert.equal(fixture.state.branchWrites, isPr ? 0 : 1);
            assert.equal(fixture.state.commitWrites, isPr ? 0 : 1);
            const retained = await worker.getRun(claim.lease.runId);
            assert.equal(retained.expectedHeadSha, COMMIT_SHA);
            if (isPr) {
              assert.equal(fixture.state.prWrites, 1);
              assert.equal(retained.pullRequestNumber, 31);
              const references = await context.ownerPool.query(`SELECT effect_reference, effect_phase
                FROM agent_worker.operations WHERE run_id = $1`, [claim.lease.runId]);
              assert.deepEqual(references.rows, [{ effect_reference: '31', effect_phase: 'confirmed' }]);
            }
          }
          if (transaction === 1 && afterCommit) {
            assert.equal(fixture.state.branchWrites + fixture.state.commitWrites, 0);
            if (isPr) assert.equal(fixture.state.prWrites, 0);
          }
          const counts = await context.ownerPool.query(`SELECT
            (SELECT count(*)::int FROM agent_worker.runs WHERE job_id = $1) AS runs,
            (SELECT count(*)::int FROM agent_worker.operations WHERE run_id = $2) AS operations`,
          [job.jobId, claim.lease.runId]);
          assert.deepEqual(counts.rows, [{ runs: 1, operations: 1 }]);
          assert.equal(JSON.stringify(first).includes('fixture-token'), false);
        } finally { await close(context); }
      });
    }
  }
  }
});

dbTest('a lost claim acknowledgment preserves one invocation and one run identity', async t => {
  for (const afterCommit of [false, true]) await t.test(`after commit ${afterCommit}`, async () => {
    const context = await setup();
    try {
      const worker = store(context.workerPool);
      const manifest = manifestFor(context.jobs[0]);
      const invocationId = randomUUID();
      const fault = transactionFaultPool(context.workerPool, { transaction: 1, afterCommit });
      await assert.rejects(store(fault).claimTick({ invocationId, manifest }), { message: SAFE_ERROR });
      assert.equal(fault.injected, true);
      const retry = await worker.claimTick({ invocationId, manifest });
      assert.equal(retry.status, afterCommit ? 'busy' : 'claimed');
      assert.equal((await worker.claimTick({ invocationId, manifest })).status, 'busy');
      const counts = await context.ownerPool.query(`SELECT
        (SELECT count(*)::int FROM agent_worker.runs WHERE job_id = $1) AS runs,
        (SELECT count(*)::int FROM agent_worker.events WHERE invocation_id = $2) AS invocations`,
      [context.jobs[0].jobId, invocationId]);
      assert.deepEqual(counts.rows, [{ runs: 1, invocations: 1 }]);
    } finally { await close(context); }
  });
});

dbTest('publication fences retain time limits and unresolved model-call stops', async t => {
  for (const cause of ['tick', 'run', 'model']) await t.test(cause, async () => {
    const context = await setup();
    try {
      const worker = store(context.workerPool);
      const manifest = manifestFor(context.jobs[0]);
      const { lease } = await worker.claimTick({ invocationId: randomUUID(), manifest });
      const intent = { key: operationKey('bounded-effect'), kind: 'commit_create',
        inputHash: 'd'.repeat(64), expectedHeadSha: manifest.baseRevision };
      assert.equal((await worker.putIntent(lease, intent)).status, 'created');
      if (cause === 'model') {
        await worker.reserveModelCall(lease, modelRequest(lease, 'pending-publication'));
      } else {
        await context.ownerPool.query(cause === 'tick'
          ? `UPDATE agent_worker.runs SET lease_started_at = clock_timestamp() - interval '91 seconds'
            WHERE run_id = $1`
          : `UPDATE agent_worker.runs SET created_at = clock_timestamp() - interval '7201 seconds'
            WHERE run_id = $1`, [lease.runId]);
      }
      const result = await worker.fenceIntent(lease, intent, 'branch');
      assert.equal(result.status, 'blocked');
      assert.equal(result.blockerCode, cause === 'model' ? 'model_outcome_uncertain' : 'recovery_deadline');
      const attempted = await context.ownerPool.query(`SELECT branch_attempted, commit_attempted
        FROM agent_worker.operations WHERE run_id = $1 AND kind = 'commit_create'`, [lease.runId]);
      assert.deepEqual(attempted.rows, [{ branch_attempted: false, commit_attempted: false }]);
    } finally { await close(context); }
  });
});

dbTest('runtime role has effective least privilege and worker tables expose only typed columns', async () => {
  const context = await setup();
  try {
    const { rows: roleRows } = await context.workerPool.query(`SELECT
      current_user AS current_user,
      has_table_privilege('intake_test_runtime', 'agent_intake.jobs', 'SELECT') AS intake_select,
      has_table_privilege('intake_test_runtime', 'agent_intake.jobs', 'INSERT') AS intake_insert,
      has_table_privilege('intake_test_runtime', 'agent_intake.jobs', 'UPDATE') AS intake_update,
      has_table_privilege('intake_test_runtime', 'agent_intake.jobs', 'DELETE') AS intake_delete,
      has_table_privilege('intake_test_runtime', 'agent_intake.jobs', 'TRUNCATE') AS intake_truncate,
      has_schema_privilege('intake_test_runtime', 'agent_worker', 'USAGE') AS worker_schema_usage,
      has_schema_privilege('intake_test_runtime', 'agent_worker', 'CREATE') AS worker_schema_create,
      has_database_privilege('intake_test_runtime', current_database(), 'CREATE') AS database_create,
      (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls
       FROM pg_roles WHERE rolname = 'intake_test_runtime') AS admin_role,
      EXISTS (SELECT 1 FROM pg_auth_members m
        JOIN pg_roles member_role ON member_role.oid = m.member
        WHERE member_role.rolname = 'intake_test_runtime') AS has_role_membership,
      (SELECT pg_get_userbyid(nspowner) = 'intake_test_runtime'
       FROM pg_namespace WHERE nspname = 'agent_worker') AS owns_worker_schema,
      EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'agent_worker' AND c.relkind IN ('r', 'p')
          AND pg_get_userbyid(c.relowner) = 'intake_test_runtime') AS owns_worker_table,
      (SELECT pg_get_userbyid(datdba) = 'intake_test_runtime'
       FROM pg_database WHERE datname = current_database()) AS owns_database`);
    assert.equal(roleRows[0].current_user, 'intake_test_runtime');
    assert.equal(roleRows[0].intake_select, true);
    assert.equal(roleRows[0].intake_insert, false);
    assert.equal(roleRows[0].intake_update, false);
    assert.equal(roleRows[0].intake_delete, false);
    assert.equal(roleRows[0].intake_truncate, false);
    assert.equal(roleRows[0].worker_schema_usage, true);
    assert.equal(roleRows[0].worker_schema_create, false);
    assert.equal(roleRows[0].database_create, false);
    assert.equal(roleRows[0].admin_role, false);
    assert.equal(roleRows[0].has_role_membership, false);
    assert.equal(roleRows[0].owns_worker_schema, false);
    assert.equal(roleRows[0].owns_worker_table, false);
    assert.equal(roleRows[0].owns_database, false);

    for (const table of ['runs', 'operations', 'events']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
        const { rows } = await context.workerPool.query(
          'SELECT has_table_privilege($1, $2, $3) AS allowed',
          ['intake_test_runtime', `agent_worker.${table}`, privilege],
        );
        const permitted = table === 'events' ? ['SELECT', 'INSERT'] : ['SELECT', 'INSERT', 'UPDATE'];
        assert.equal(rows[0].allowed, permitted.includes(privilege),
          `${table} ${privilege} grant does not match the worker contract`);
      }
    }

    const { rows: columns } = await context.workerPool.query(`SELECT table_name, column_name
      FROM information_schema.columns WHERE table_schema = 'agent_worker'`);
    const unsafeColumns = columns.filter(row =>
      /checkpoint|metadata|payload|raw_error|error_message/i.test(row.column_name));
    assert.deepEqual(unsafeColumns, []);
  } finally {
    await close(context);
  }
});

dbTest('claim denies unknown, private, and incomplete metadata before database access', async t => {
  const context = await setup();
  try {
    const worker = store(context.workerPool);
    const manifest = manifestFor(context.jobs[0]);
    const cases = [
      ['unknown request payload', { invocationId: randomUUID(), manifest, payload: 'synthetic-private-value' }],
      ['unknown issue text', { invocationId: randomUUID(), manifest: { ...manifest, issueBody: 'synthetic-private-value' } }],
      ['uppercase manifest hash', { invocationId: randomUUID(), manifest: { ...manifest, manifestHash: 'A'.repeat(64) } }],
      ['branch name revision', { invocationId: randomUUID(), manifest: { ...manifest, baseRevision: 'main' } }],
      ['uppercase policy revision', { invocationId: randomUUID(), manifest: { ...manifest, policyRevision: 'C'.repeat(40) } }],
      ['missing repository name', {
        invocationId: randomUUID(),
        manifest: Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'repositoryFullName')),
      }],
      ['missing issue number', {
        invocationId: randomUUID(),
        manifest: Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'issueNumber')),
      }],
      ['incomplete numeric limits', {
        invocationId: randomUUID(),
        manifest: { ...manifest, limits: Object.fromEntries(Object.entries(LIMITS).filter(([key]) => key !== 'repairCycles')) },
      }],
      ['unknown numeric limit', {
        invocationId: randomUUID(), manifest: { ...manifest, limits: { ...LIMITS, secretBudget: 1 } },
      }],
      ['text-valued limit', {
        invocationId: randomUUID(), manifest: { ...manifest, limits: { ...LIMITS, leaseSeconds: '180' } },
      }],
      ['lease shorter than tick', {
        invocationId: randomUUID(), manifest: {
          ...manifest, limits: { ...LIMITS, leaseSeconds: 90 },
        },
      }],
    ];

    for (const [label, input] of cases) {
      await t.test(label, async () => {
        await expectRejectedBeforeSql(context.workerPool, () => worker.claimTick(input), label);
      });
    }
  } finally {
    await close(context);
  }
});

dbTest('claim binds repository name, issue number, IDs, and original actor to the intake job', async t => {
  const context = await setup();
  try {
    const worker = store(context.workerPool);
    const job = context.jobs[0];
    const cases = [
      ['repository ID', { repositoryId: job.repositoryId + 1 }],
      ['repository full name', { repositoryFullName: 'other/repo' }],
      ['issue ID', { issueId: job.issueId + 1 }],
      ['issue number', { issueNumber: job.issueNumber + 1 }],
      ['actor ID', { actorId: job.actorId + 1 }],
    ];

    for (const [label, changes] of cases) {
      await t.test(label, async () => {
        const result = await expectResolved(
          worker.claimTick({ invocationId: randomUUID(), manifest: manifestFor(job, changes) }),
          `${label} mismatch must resolve as a non-claim, not a database error`,
        );
        assert.equal(result.status, 'idle', `${label} mismatch must not claim the admitted job`);
      });
    }
  } finally {
    await close(context);
  }
});

dbTest('checkpoint accepts only typed nonterminal state and bounded references', async t => {
  const context = await setup();
  try {
    const worker = store(context.workerPool);
    const lease = fakeLease();
    const invalidChanges = [
      ['terminal state', { state: 'ready_for_human' }],
      ['unknown state', { state: 'arbitrary_phase' }],
      ['private text', { state: 'waiting_ci', privateText: 'synthetic-private-value' }],
      ['raw error', { state: 'waiting_ci', rawError: 'synthetic-private-value' }],
      ['unbounded payload', { state: 'waiting_ci', payload: { prompt: 'synthetic-private-value' } }],
      ['limit mutation', { state: 'waiting_ci', limits: { ...LIMITS, leaseSeconds: 1 } }],
      ['recovery counter mutation', { state: 'waiting_ci', recoveryCount: 99 }],
      ['fence mutation', { state: 'waiting_ci', generation: 99, token: 'forged' }],
      ['malformed head reference', { state: 'waiting_ci', expectedHeadSha: 'main' }],
      ['foreign run branch', { state: 'opening_pr', branchName: `agent-work/${randomUUID()}` }],
      ['free-form blocker text', { state: 'waiting_ci', blockerCode: 'arbitrary_private_error' }],
    ];
    for (const [label, change] of invalidChanges) {
      await t.test(label, async () => {
        await expectRejectedBeforeSql(context.workerPool, () => worker.checkpoint(lease, change), label);
      });
    }
  } finally {
    await close(context);
  }
});

dbTest('operation intents accept only stable typed hashes and approved effect categories', async t => {
  const context = await setup();
  try {
    const worker = store(context.workerPool);
    const lease = fakeLease();
    const baseIntent = {
      key: operationKey('test:operation:1'),
      kind: 'model_call',
      inputHash: 'd'.repeat(64),
      expectedHeadSha: null,
    };
    const invalid = [
      ['task-shaped operation key', { ...baseIntent, key: 'customer-reset-token-for-acme' }],
      ['private operation metadata', { ...baseIntent, transcript: 'synthetic-private-value' }],
      ['arbitrary metadata object', { ...baseIntent, metadata: { prompt: 'synthetic-private-value' } }],
      ['unsupported comment effect', { ...baseIntent, kind: 'comment' }],
      ['unsupported label effect', { ...baseIntent, kind: 'label' }],
      ['unsupported deploy effect', { ...baseIntent, kind: 'deploy' }],
      ['unsupported merge effect', { ...baseIntent, kind: 'merge' }],
      ['uppercase input hash', { ...baseIntent, inputHash: 'D'.repeat(64) }],
      ['malformed expected head', { ...baseIntent, expectedHeadSha: 'main' }],
    ];
    for (const [label, intent] of invalid) {
      await t.test(label, async () => {
        await expectRejectedBeforeSql(context.workerPool, () => worker.putIntent(lease, intent), label);
      });
    }
  } finally {
    await close(context);
  }
});

dbTest('operation intents reject arbitrary metadata even when using the legacy proposal kind', async () => {
  const context = await setup();
  try {
    const worker = store(context.workerPool);
    await expectRejectedBeforeSql(context.workerPool, () => worker.putIntent(fakeLease(), {
      key: operationKey('legacy:metadata'),
      kind: 'proposal',
      metadata: { transcript: 'synthetic-private-value' },
    }), 'legacy opaque proposal metadata');
  } finally {
    await close(context);
  }
});

dbTest('finishRun accepts only the three explicit terminal states', async t => {
  const context = await setup();
  try {
    const worker = store(context.workerPool);
    const lease = fakeLease();
    for (const state of ['ready_for_human', 'needs_attention', 'cancelled']) {
      await t.test(`${state} is accepted by the terminal API`, async () => {
        const before = context.workerPool.storeQueryCount;
        const result = await expectResolved(
          worker.finishRun(lease, state), `${state} must be a supported terminal state`,
        );
        assert.equal(result, false, 'an unknown run ID must not be terminalized');
        assert.ok(context.workerPool.storeQueryCount > before, 'a supported terminal state reaches the fenced database update');
      });
    }
    for (const state of ['completed', 'stopped', 'failed', 'running', 'queued']) {
      await t.test(`${state} is not an accepted terminal state`, async () => {
        await expectRejectedBeforeSql(context.workerPool, () => worker.finishRun(lease, state), state);
      });
    }
  } finally {
    await close(context);
  }
});

dbTest('store claim and getRun expose bounded metadata and never return raw checkpoint data', async () => {
  const context = await setup();
  try {
    const worker = store(context.workerPool);
    const missing = await expectResolved(worker.getRun(randomUUID()), 'getRun must use the restricted runtime role');
    assert.equal(missing, null);
    const { rows } = await context.workerPool.query(`SELECT column_name
      FROM information_schema.columns WHERE table_schema = 'agent_worker'`);
    const forbidden = rows.filter(row => /checkpoint|metadata|payload|raw_error|error_message/i.test(row.column_name));
    assert.deepEqual(forbidden, []);
  } finally {
    await close(context);
  }
});

dbTest('real store operations run as SELECT-only intake runtime and enforce durable lease recovery', async () => {
  const context = await setup({ jobCount: 2 });
  try {
    const worker = store(context.workerPool);
    const firstJob = context.jobs[0];
    const secondJob = context.jobs[1];
    const before = await context.workerPool.query(`SELECT status, repository_id, repository_full_name,
      issue_id, issue_number, actor_id, initial_delivery_id
      FROM agent_intake.jobs WHERE job_id = $1`, [firstJob.jobId]);
    assert.equal(before.rows.length, 1);

    const firstManifest = manifestFor(firstJob);
    const secondManifest = manifestFor(firstJob);
    const firstInvocationId = randomUUID();
    const secondInvocationId = randomUUID();
    const firstClaim = worker.claimTick({ invocationId: firstInvocationId, manifest: firstManifest });
    const secondClaim = worker.claimTick({ invocationId: secondInvocationId, manifest: secondManifest });
    firstManifest.issueId = secondJob.issueId;
    firstManifest.issueNumber = secondJob.issueNumber;
    firstManifest.actorId = secondJob.actorId + 1;
    firstManifest.limits.leaseSeconds = 1;
    secondManifest.repositoryFullName = 'other/repo';

    const outcomes = await Promise.all([firstClaim, secondClaim].map(promise =>
      Promise.resolve(promise).then(value => ({ resolved: true, value }), () => ({ resolved: false }))));
    assert.equal(outcomes.every(outcome => outcome.resolved), true,
      'SELECT-only intake runtime claims must not require row-lock UPDATE privileges');
    const claims = outcomes.map((outcome, index) => ({ ...outcome.value, invocationId: index === 0 ? firstInvocationId : secondInvocationId }))
      .filter(result => result.status === 'claimed');
    assert.equal(claims.length, 1, 'overlapping invocation IDs must create one run and one lease');
    let lease = claims[0].lease;
    let currentInvocationId = claims[0].invocationId;
    assert.ok(lease.runId && lease.jobId && lease.token && Number.isSafeInteger(lease.generation));
    assert.equal(lease.repositoryId, firstJob.repositoryId);
    assert.equal(lease.repositoryFullName, firstJob.repositoryFullName);
    assert.equal(lease.issueId, firstJob.issueId);
    assert.equal(lease.issueNumber, firstJob.issueNumber);
    assert.equal(lease.actorId, firstJob.actorId);

    const { rows: runRows } = await context.workerPool.query(`SELECT limits,
      EXTRACT(EPOCH FROM lease_expires_at - clock_timestamp()) AS remaining_seconds
      FROM agent_worker.runs WHERE run_id = $1`, [lease.runId]);
    assert.deepEqual(runRows[0].limits, LIMITS);
    assert.ok(Number(runRows[0].remaining_seconds) > LIMITS.tickDeadlineSeconds,
      'the lease must outlast the 90-second tick');
    assert.ok(Number(runRows[0].remaining_seconds) <= LIMITS.leaseSeconds,
      'the lease must not exceed the approved 180-second limit');

    const otherIssue = await expectResolved(
      worker.claimTick({ invocationId: randomUUID(), manifest: manifestFor(secondJob) }),
      'a different admitted issue must not cause a unique-constraint rejection',
    );
    assert.notEqual(otherIssue.status, 'claimed', 'the active pilot run blocks another issue');

    const inputHash = 'd'.repeat(64);
    const intent = {
      key: operationKey('model:initial-tests'),
      kind: 'model_call',
      inputHash,
      expectedHeadSha: null,
    };
    const created = await expectResolved(worker.putIntent(lease, intent), 'model_call intent must be accepted');
    assert.equal(created.status, 'created');
    assert.ok(created.operation.operationId);
    for (const kind of ['branch_create', 'commit_create', 'pr_create']) {
      const accepted = await expectResolved(worker.putIntent(lease, {
        key: operationKey(`${kind}:initial`),
        kind,
        inputHash,
        expectedHeadSha: 'b'.repeat(40),
      }), `${kind} intent must use the approved typed schema`);
      assert.equal(accepted.status, 'created');
    }
    const wrongHeadKey = operationKey('commit_create:unknown-head');
    const wrongHead = await expectResolved(worker.putIntent(lease, {
      key: wrongHeadKey, kind: 'commit_create', inputHash, expectedHeadSha: 'f'.repeat(40),
    }), 'a new publication intent must be bound to the approved base or recorded run head');
    assert.equal(wrongHead.status, 'conflict');
    const rejectedHeadRows = await context.workerPool.query('SELECT count(*)::int AS count FROM agent_worker.operations WHERE run_id = $1 AND operation_key = $2', [lease.runId, wrongHeadKey]);
    assert.equal(rejectedHeadRows.rows[0].count, 0, 'a mismatched publication head must not be persisted');
    const storedKey = await context.workerPool.query('SELECT operation_key FROM agent_worker.operations WHERE operation_id = $1', [created.operation.operationId]);
    assert.match(storedKey.rows[0].operation_key, /^[a-f0-9]{64}$/);
    const existing = await expectResolved(worker.putIntent(lease, intent), 'same intent must be idempotent');
    assert.equal(existing.status, 'existing');
    assert.equal(existing.operation.operationId, created.operation.operationId);
    const changedInput = await expectResolved(worker.putIntent(lease, { ...intent, inputHash: 'e'.repeat(64) }),
      'changed operation input must return a stable conflict');
    assert.equal(changedInput.status, 'conflict');
    const changedHead = await expectResolved(worker.putIntent(lease, { ...intent, expectedHeadSha: 'f'.repeat(40) }),
      'changed expected head must return a stable conflict');
    assert.equal(changedHead.status, 'conflict');
    const unchanged = await expectResolved(worker.putIntent(lease, intent), 'conflict must not overwrite the original intent');
    assert.equal(unchanged.status, 'existing');
    assert.equal(unchanged.operation.operationId, created.operation.operationId);

    const phases = [
      { state: 'generating_tests' },
      { state: 'waiting_red_ci', expectedHeadSha: 'f'.repeat(40) },
      { state: 'implementing' },
      { state: 'waiting_ci', expectedHeadSha: 'f'.repeat(40), lastCheckRunId: 12345 },
      { state: 'opening_pr', expectedHeadSha: 'f'.repeat(40), branchName: `agent-work/${lease.runId}` },
      { state: 'waiting_review', expectedHeadSha: 'f'.repeat(40), pullRequestNumber: 7 },
    ];
    for (const change of phases) {
      const checkpointed = await expectResolved(worker.checkpoint(lease, change),
        `checkpoint state ${change.state} must be accepted`);
      assert.equal(checkpointed, true, `checkpoint state ${change.state} must be fenced`);
      const run = await expectResolved(worker.getRun(lease.runId), 'getRun must return the run metadata projection');
      assert.equal(run.state, change.state);
      assert.equal(Object.hasOwn(run, 'checkpoint'), false, 'getRun must not expose opaque checkpoint JSON');
      assert.equal(Object.hasOwn(run, 'leaseToken'), false, 'getRun must not expose the fence token');

      const duplicate = await expectResolved(
        worker.claimTick({ invocationId: currentInvocationId, manifest: manifestFor(firstJob) }),
        'a completed invocation must be durably deduplicated after lease release',
      );
      assert.notEqual(duplicate.status, 'claimed', 'a successful invocation cannot advance twice');
      const resumedInvocationId = randomUUID();
      const resumed = await expectResolved(
        worker.claimTick({ invocationId: resumedInvocationId, manifest: manifestFor(firstJob) }),
        'a fresh invocation must resume an active wait state',
      );
      assert.equal(resumed.status, 'claimed');
      assert.ok(resumed.lease.generation > lease.generation);
      lease = resumed.lease;
      currentInvocationId = resumedInvocationId;
    }

    const current = await worker.getRun(lease.runId);
    assert.equal(current.branchName, `agent-work/${lease.runId}`);
    const foreignBranchError = await context.workerPool.query('UPDATE agent_worker.runs SET branch_name = $1 WHERE run_id = $2', [`agent-work/${randomUUID()}`, lease.runId]).then(() => null, error => error.code);
    assert.equal(foreignBranchError, '23514', 'the database also enforces branch ownership');
    const priorCommit = await worker.putIntent(lease, {
      key: operationKey('commit_create:initial'), kind: 'commit_create', inputHash, expectedHeadSha: 'b'.repeat(40),
    });
    assert.equal(priorCommit.status, 'existing', 'past intents remain readable for reconciliation, not fresh authorization');
    const nextCommit = await worker.putIntent(lease, {
      key: operationKey('commit_create:repair-1'), kind: 'commit_create', inputHash, expectedHeadSha: 'f'.repeat(40),
    });
    assert.equal(nextCommit.status, 'created', 'new intents bind the recorded updated run head');
    const staleHead = await worker.putIntent(lease, {
      key: operationKey('commit_create:stale-head'), kind: 'commit_create', inputHash, expectedHeadSha: 'b'.repeat(40),
    });
    assert.equal(staleHead.status, 'conflict');
    for (let recovery = 1; recovery <= LIMITS.expiredLeaseRecoveries; recovery += 1) {
      const previousLease = lease;
      const { rows: expired } = await context.ownerPool.query(`UPDATE agent_worker.runs
        SET lease_expires_at = clock_timestamp() - interval '1 second'
        WHERE run_id = $1 RETURNING run_id`, [lease.runId]);
      assert.equal(expired.length, 1, 'owner expiry simulation must touch only the current run');
      assert.equal(await worker.checkpoint(lease, { state: 'waiting_ci' }), false,
        'an expired lease cannot checkpoint');
      const staleIntent = await expectResolved(worker.putIntent(lease, {
        key: operationKey(`stale:model:${recovery}`),
        kind: 'model_call',
        inputHash: 'd'.repeat(64),
        expectedHeadSha: null,
      }), 'an expired lease cannot create an operation intent');
      assert.equal(staleIntent.status, 'stale');
      const recovered = await expectResolved(
        worker.claimTick({ invocationId: randomUUID(), manifest: manifestFor(firstJob) }),
        'an expired lease must be recovered within the approved limit',
      );
      assert.equal(recovered.status, 'claimed');
      assert.ok(recovered.lease.generation > lease.generation);
      lease = recovered.lease;
      assert.equal(await worker.checkpoint(previousLease, { state: 'waiting_ci' }), false,
        'the old generation cannot checkpoint after a new owner acquires a valid lease');
      assert.equal((await worker.putIntent(previousLease, {
        key: operationKey(`old-generation:model:${recovery}`), kind: 'model_call',
        inputHash: 'd'.repeat(64), expectedHeadSha: null,
      })).status, 'stale');
      assert.equal(await worker.finishRun(previousLease, 'cancelled'), false,
        'the old generation cannot terminalize the new owner');
    }

    const { rows: expiredAgain } = await context.ownerPool.query(`UPDATE agent_worker.runs
      SET lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE run_id = $1 RETURNING run_id`, [lease.runId]);
    assert.equal(expiredAgain.length, 1);
    const exhaustedInvocationId = randomUUID();
    const exhausted = await expectResolved(
      worker.claimTick({ invocationId: exhaustedInvocationId, manifest: manifestFor(firstJob) }),
      'recovery exhaustion must stop the run instead of returning busy forever',
    );
    assert.notEqual(exhausted.status, 'busy');
    const stopped = await expectResolved(worker.getRun(lease.runId), 'exhaustion must persist a safe terminal projection');
    assert.equal(stopped.state, 'needs_attention');
    assert.equal(stopped.blockerCode, 'lease_recovery_limit');
    assert.equal(stopped.recoveryCount, LIMITS.expiredLeaseRecoveries);
    const recordedStop = await context.workerPool.query(`SELECT count(*)::int AS count
      FROM agent_worker.events WHERE invocation_id = $1 AND event_type = 'lease_recovery_limit'`, [exhaustedInvocationId]);
    assert.equal(recordedStop.rows[0].count, 1, 'a tick that terminalizes recovery exhaustion must retain its invocation identity');
    for (const key of ['checkpoint', 'metadata', 'rawError', 'error', 'leaseToken', 'token', 'payload']) {
      assert.equal(Object.hasOwn(stopped, key), false, `${key} must not appear in the safe run projection`);
    }

    const retrySameJob = await expectResolved(
      worker.claimTick({ invocationId: randomUUID(), manifest: manifestFor(firstJob) }),
      'a terminal run must not be reset or requeued',
    );
    const retryOtherIssue = await expectResolved(
      worker.claimTick({ invocationId: randomUUID(), manifest: manifestFor(secondJob, {
        manifestHash: manifestFor(firstJob).manifestHash,
      }) }),
      'the same approved pilot manifest must not authorize another issue',
    );
    assert.equal(retrySameJob.status, 'idle');
    assert.equal(retryOtherIssue.status, 'idle');

    const { rows: runCount } = await context.workerPool.query(
      'SELECT count(*)::int AS count FROM agent_worker.runs WHERE job_id = ANY($1::uuid[])',
      [context.jobs.map(job => job.jobId)]);
    assert.equal(runCount[0].count, 1, 'terminal retention must keep one run identity for the approved pilot');
    const after = await context.workerPool.query(`SELECT status, repository_id, repository_full_name,
      issue_id, issue_number, actor_id, initial_delivery_id
      FROM agent_intake.jobs WHERE job_id = $1`, [firstJob.jobId]);
    assert.deepEqual(after.rows, before.rows, 'worker operations must leave the intake row unchanged');
  } finally {
    await close(context);
  }
});

dbTest('a separately selected bounded profile honors configured lease duration and zero recoveries', async () => {
  const context = await setup();
  try {
    const worker = store(context.workerPool);
    const manifest = manifestFor(context.jobs[0], {
      manifestHash: 'e'.repeat(64),
      limits: { ...LIMITS, leaseSeconds: 120, expiredLeaseRecoveries: 0 },
    });
    const claimed = await expectResolved(worker.claimTick({ invocationId: randomUUID(), manifest }),
      'zero recovery allowance must still permit the initial claim');
    assert.equal(claimed.status, 'claimed');
    const { rows } = await context.workerPool.query(`SELECT
      EXTRACT(EPOCH FROM lease_expires_at - clock_timestamp()) AS seconds
      FROM agent_worker.runs WHERE run_id = $1`, [claimed.lease.runId]);
    assert.ok(Number(rows[0].seconds) > 90 && Number(rows[0].seconds) <= 120);
    await context.ownerPool.query(`UPDATE agent_worker.runs
      SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE run_id = $1`, [claimed.lease.runId]);
    const expired = await expectResolved(worker.claimTick({ invocationId: randomUUID(), manifest }),
      'an expired zero-recovery profile must stop instead of recovering');
    assert.equal(expired.status, 'idle');
    const retained = await worker.getRun(claimed.lease.runId);
    assert.equal(retained.state, 'needs_attention');
    assert.equal(retained.recoveryCount, 0);
    assert.equal(retained.blockerCode, 'lease_recovery_limit');
  } finally { await close(context); }
});

dbTest('a live owner can retain ready or cancelled terminals without reviving the run', async t => {
  for (const [state, manifestHash] of [['ready_for_human', 'f'.repeat(64)], ['cancelled', '1'.repeat(64)]]) {
    await t.test(state, async () => {
      const context = await setup();
      try {
        const worker = store(context.workerPool);
        const manifest = manifestFor(context.jobs[0], { manifestHash });
        const claim = await worker.claimTick({ invocationId: randomUUID(), manifest });
        assert.equal(claim.status, 'claimed');
        assert.equal(await worker.finishRun(claim.lease, state), true);
        const run = await worker.getRun(claim.lease.runId);
        assert.equal(run.state, state);
        assert.equal(typeof run.terminalAt, 'string');
        assert.equal((await worker.claimTick({ invocationId: randomUUID(), manifest })).status, 'idle');
        assert.equal(await worker.checkpoint(claim.lease, { state: 'waiting_ci' }), false);
        assert.equal((await worker.putIntent(claim.lease, {
          key: operationKey('terminal:stale'), kind: 'model_call', inputHash: 'd'.repeat(64), expectedHeadSha: null,
        })).status, 'stale');
      } finally { await close(context); }
    });
  }
});

dbTest('model-call budget reservation is atomic and never authorizes a duplicate execution', async () => {
  const context = await setup();
  try {
    const worker = store(context.workerPool);
    assert.equal(typeof worker.reserveModelCall, 'function', 'missing atomic model-call reservation API');
    const manifest = manifestFor(context.jobs[0], { manifestHash: '2'.repeat(64) });
    const claim = await worker.claimTick({ invocationId: randomUUID(), manifest });
    assert.equal(claim.status, 'claimed');
    const request = {
      key: operationKey(`model-call:${claim.lease.runId}:initial`),
      inputHash: 'd'.repeat(64), expectedHeadSha: manifest.baseRevision,
      inputTokens: 100, outputTokens: 50,
    };
    const reserved = await worker.reserveModelCall(claim.lease, request);
    assert.equal(reserved.status, 'reserved');
    assert.equal(reserved.canExecute, true, 'only a freshly committed reservation grants budget');
    const duplicate = await worker.reserveModelCall(claim.lease, request);
    assert.equal(duplicate.status, 'existing');
    assert.equal(duplicate.canExecute, false, 'existing intent is for reconciliation, never another paid call');
    const run = await worker.getRun(claim.lease.runId);
    assert.equal(run.modelCallCount, 1);
    assert.equal(run.reservedInputTokens, 100);
    assert.equal(run.reservedOutputTokens, 50);
    assert.equal(await worker.finishRun(claim.lease, 'cancelled'), true);
  } finally { await close(context); }
});

function budgetMethod(worker, name) {
  assert.equal(typeof worker[name], 'function', `missing ${name} budget API`);
  return worker[name].bind(worker);
}

function modelRequest(lease, suffix, overrides = {}) {
  return {
    key: operationKey(`model-call:${lease.runId}:${suffix}`),
    inputHash: 'd'.repeat(64),
    expectedHeadSha: 'b'.repeat(40),
    inputTokens: 10,
    outputTokens: 10,
    ...overrides,
  };
}

dbTest('reservations clamp outputs to remaining run tokens and enforce strict run limits', async () => {
  const context = await setup();
  try {
    const worker = store(context.workerPool);
    const reserveModelCall = budgetMethod(worker, 'reserveModelCall');
    const manifest = manifestFor(context.jobs[0], {
      manifestHash: operationKey('budget-reserve-clamps'),
      limits: {
        ...LIMITS,
        modelCallsPerRun: 3,
        inputTokensPerCall: 400,
        outputTokensPerCall: 500,
        inputTokensPerRun: 500,
        outputTokensPerRun: 700,
      },
    });
    const firstClaim = await worker.claimTick({ invocationId: randomUUID(), manifest });
    assert.equal(firstClaim.status, 'claimed');
    const firstRequest = modelRequest(firstClaim.lease, 'first', {
      inputTokens: 400,
      outputTokens: 900,
    });
    const first = await reserveModelCall(firstClaim.lease, firstRequest);
    assert.equal(first.status, 'reserved');
    assert.equal(first.canExecute, true);
    assert.equal(first.inputTokens, 400);
    assert.equal(first.outputTokens, 500, 'output allowance must not exceed the configured per-call cap');
    assert.equal(typeof first.deadlineAt, 'string');

    const committed = await context.ownerPool.query(`SELECT runs.model_call_count,
      runs.reserved_input_tokens, runs.reserved_output_tokens,
      operations.owner_generation, operations.reserved_input_tokens AS operation_input,
      operations.reserved_output_tokens AS operation_output
      FROM agent_worker.runs AS runs
      JOIN agent_worker.operations AS operations USING (run_id)
      WHERE runs.run_id = $1 AND operations.operation_key = $2`,
    [firstClaim.lease.runId, firstRequest.key]);
    assert.equal(committed.rows.length, 1, 'reservation intent and counters must be committed before canExecute returns');
    assert.equal(committed.rows[0].model_call_count, 1);
    assert.equal(committed.rows[0].reserved_input_tokens, 400);
    assert.equal(committed.rows[0].reserved_output_tokens, 500);
    assert.equal(Number(committed.rows[0].owner_generation), firstClaim.lease.generation);
    assert.equal(committed.rows[0].operation_input, 400);
    assert.equal(committed.rows[0].operation_output, 500);

    const duplicate = await reserveModelCall(firstClaim.lease, firstRequest);
    assert.equal(duplicate.status, 'existing');
    assert.equal(duplicate.canExecute, false);
    const conflicting = await reserveModelCall(firstClaim.lease, {
      ...firstRequest,
      inputHash: 'e'.repeat(64),
    });
    assert.equal(conflicting.status, 'conflict');
    const changedInputBound = await reserveModelCall(firstClaim.lease, {
      ...firstRequest,
      inputTokens: 399,
    });
    const changedOutputBound = await reserveModelCall(firstClaim.lease, {
      ...firstRequest,
      outputTokens: 400,
    });
    assert.equal(changedInputBound.status, 'conflict');
    assert.equal(changedOutputBound.status, 'conflict');
    assert.equal((await worker.getRun(firstClaim.lease.runId)).modelCallCount, 1);
    const firstOutcome = await worker.recordModelCallOutcome(firstClaim.lease, {
      operationId: first.operationId,
      outcome: 'success',
      actualInputTokens: 400,
      actualOutputTokens: 500,
    });
    assert.equal(firstOutcome.status, 'recorded');

    assert.equal(await worker.checkpoint(firstClaim.lease, { state: 'waiting_ci' }), true);
    const secondClaim = await worker.claimTick({ invocationId: randomUUID(), manifest });
    assert.equal(secondClaim.status, 'claimed');
    const secondRequest = modelRequest(secondClaim.lease, 'second', {
      inputTokens: 100,
      outputTokens: 900,
    });
    const second = await reserveModelCall(secondClaim.lease, secondRequest);
    assert.equal(second.status, 'reserved');
    assert.equal(second.outputTokens, 200, 'output allowance must clamp to the remaining run budget');
    const secondOutcome = await worker.recordModelCallOutcome(secondClaim.lease, {
      operationId: second.operationId,
      outcome: 'success',
      actualInputTokens: 100,
      actualOutputTokens: 200,
    });
    assert.equal(secondOutcome.status, 'recorded');

    assert.equal(await worker.checkpoint(secondClaim.lease, { state: 'waiting_ci' }), true);
    const thirdClaim = await worker.claimTick({ invocationId: randomUUID(), manifest });
    assert.equal(thirdClaim.status, 'claimed');
    const exhausted = await reserveModelCall(thirdClaim.lease,
      modelRequest(thirdClaim.lease, 'third', { inputTokens: 1, outputTokens: 1 }));
    assert.equal(exhausted.status, 'needs_attention');
    assert.equal(exhausted.canExecute, false);
    assert.equal(exhausted.blockerCode, 'model_token_budget_exhausted');
    const stopped = await worker.getRun(secondClaim.lease.runId);
    assert.equal(stopped.state, 'needs_attention');
    assert.equal(stopped.reservedInputTokens, 500);
    assert.equal(stopped.reservedOutputTokens, 700);
    assert.equal(stopped.modelCallCount, 2);
    const operationCount = await context.ownerPool.query(
      'SELECT count(*)::int AS count FROM agent_worker.operations WHERE run_id = $1 AND kind = $2',
      [secondClaim.lease.runId, 'model_call']);
    assert.equal(operationCount.rows[0].count, 2, 'an exhausted request must not create an operation');
    assert.equal(await worker.checkpoint(thirdClaim.lease, { state: 'waiting_ci' }), false);
  } finally { await close(context); }
});

dbTest('concurrent distinct reservations cannot exceed one model call per tick generation', async () => {
  const context = await setup();
  try {
    const worker = store(context.workerPool);
    const reserveModelCall = budgetMethod(worker, 'reserveModelCall');
    const manifest = manifestFor(context.jobs[0], { manifestHash: operationKey('budget-concurrent-generation') });
    const claim = await worker.claimTick({ invocationId: randomUUID(), manifest });
    const [left, right] = await Promise.all([
      reserveModelCall(claim.lease, modelRequest(claim.lease, 'parallel-left')),
      reserveModelCall(claim.lease, modelRequest(claim.lease, 'parallel-right')),
    ]);
    const results = [left, right];
    assert.equal(results.filter(result => result.status === 'reserved' && result.canExecute).length, 1);
    assert.equal(results.filter(result => result.status === 'needs_attention').length, 1);
    const run = await worker.getRun(claim.lease.runId);
    assert.equal(run.modelCallCount, 1);
    assert.equal(run.reservedInputTokens, 10);
    assert.equal(run.reservedOutputTokens, 10);
    assert.equal(run.state, 'needs_attention');
    const rows = await context.ownerPool.query(`SELECT count(*)::int AS count
      FROM agent_worker.operations WHERE run_id = $1 AND owner_generation = $2
        AND kind = 'model_call' AND reserved_input_tokens IS NOT NULL`,
    [claim.lease.runId, claim.lease.generation]);
    assert.equal(rows.rows[0].count, 1);
  } finally { await close(context); }
});

dbTest('model-call outcome accounting is closed, idempotent, and retains reservations on failures', async t => {
  const failures = [
    ['usage_unreported', 'model_usage_unreported'],
    ['uncertain', 'model_outcome_uncertain'],
    ['spend_limit', 'model_spend_limit'],
    ['payment_failure', 'model_payment_failure'],
    ['restricted_model', 'model_restricted'],
    ['provider_failure', 'model_provider_failure'],
    ['deadline', 'model_call_deadline'],
    ['unknown_contract', 'model_contract_unknown'],
  ];
  for (const [outcome, blockerCode] of failures) {
    await t.test(outcome, async () => {
      const context = await setup();
      try {
        const worker = store(context.workerPool);
        const reserveModelCall = budgetMethod(worker, 'reserveModelCall');
        const recordModelCallOutcome = budgetMethod(worker, 'recordModelCallOutcome');
        const manifest = manifestFor(context.jobs[0], {
          manifestHash: operationKey(`budget-outcome-${outcome}`),
        });
        const claim = await worker.claimTick({ invocationId: randomUUID(), manifest });
        const request = modelRequest(claim.lease, `failure-${outcome}`, {
          inputTokens: 30,
          outputTokens: 20,
        });
        const reserved = await reserveModelCall(claim.lease, request);
        const result = await recordModelCallOutcome(claim.lease, {
          operationId: reserved.operationId,
          outcome,
        });
        assert.equal(result.status, 'needs_attention');
        assert.equal(result.blockerCode, blockerCode);
        const run = await worker.getRun(claim.lease.runId);
        assert.equal(run.state, 'needs_attention');
        assert.equal(run.blockerCode, blockerCode);
        assert.equal(run.modelCallCount, 1);
        assert.equal(run.reservedInputTokens, 30);
        assert.equal(run.reservedOutputTokens, 20);
        const stored = await context.ownerPool.query(`SELECT outcome_code,
          actual_input_tokens, actual_output_tokens FROM agent_worker.operations
          WHERE operation_id = $1`, [reserved.operationId]);
        assert.deepEqual(stored.rows, [{
          outcome_code: outcome,
          actual_input_tokens: null,
          actual_output_tokens: null,
        }]);
        assert.equal(await worker.checkpoint(claim.lease, { state: 'waiting_ci' }), false);
        const replay = await recordModelCallOutcome(claim.lease, {
          operationId: reserved.operationId,
          outcome,
        });
        assert.equal(replay.status, 'existing', 'a repeated outcome reconciles metadata without authorizing a retry');
      } finally { await close(context); }
    });
  }
});

dbTest('successful and invalid model usage is recorded only when numeric and within the reservation', async t => {
  const cases = [
    {
      name: 'reported usage',
      usage: { actualInputTokens: 8, actualOutputTokens: 6 },
      expectedStatus: 'recorded',
      expectedOutcome: 'success',
      expectedBlocker: null,
      storedInput: 8,
      storedOutput: 6,
    },
    {
      name: 'invalid usage',
      usage: { actualInputTokens: -1, actualOutputTokens: 6 },
      expectedStatus: 'needs_attention',
      expectedOutcome: 'invalid_usage',
      expectedBlocker: 'model_usage_invalid',
      storedInput: null,
      storedOutput: null,
    },
    {
      name: 'excess usage',
      usage: { actualInputTokens: 11, actualOutputTokens: 6 },
      expectedStatus: 'needs_attention',
      expectedOutcome: 'excess_usage',
      expectedBlocker: 'model_usage_exceeded',
      storedInput: null,
      storedOutput: null,
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const context = await setup();
      try {
        const worker = store(context.workerPool);
        const reserveModelCall = budgetMethod(worker, 'reserveModelCall');
        const recordModelCallOutcome = budgetMethod(worker, 'recordModelCallOutcome');
        const manifest = manifestFor(context.jobs[0], {
          manifestHash: operationKey(`budget-usage-${scenario.name}`),
        });
        const claim = await worker.claimTick({ invocationId: randomUUID(), manifest });
        const reserved = await reserveModelCall(claim.lease,
          modelRequest(claim.lease, `usage-${scenario.name}`, { inputTokens: 10, outputTokens: 10 }));
        const result = await recordModelCallOutcome(claim.lease, {
          operationId: reserved.operationId,
          outcome: 'success',
          ...scenario.usage,
        });
        assert.equal(result.status, scenario.expectedStatus);
        assert.equal(result.blockerCode, scenario.expectedBlocker);
        const stored = await context.ownerPool.query(`SELECT outcome_code,
          actual_input_tokens, actual_output_tokens FROM agent_worker.operations
          WHERE operation_id = $1`, [reserved.operationId]);
        assert.deepEqual(stored.rows, [{
          outcome_code: scenario.expectedOutcome,
          actual_input_tokens: scenario.storedInput,
          actual_output_tokens: scenario.storedOutput,
        }]);
        const run = await worker.getRun(claim.lease.runId);
        assert.equal(run.reservedInputTokens, 10, 'reported usage never refunds an input reservation');
        assert.equal(run.reservedOutputTokens, 10, 'reported usage never refunds an output reservation');
        if (scenario.expectedStatus === 'recorded') {
          assert.equal(run.state, 'claimed');
          const duplicate = await recordModelCallOutcome(claim.lease, {
            operationId: reserved.operationId,
            outcome: 'success',
            ...scenario.usage,
          });
          assert.equal(duplicate.status, 'existing');
          const events = await context.ownerPool.query(`SELECT count(*)::int AS count
            FROM agent_worker.events WHERE operation_id = $1 AND event_type = 'model_call_outcome'`,
          [reserved.operationId]);
          assert.equal(events.rows[0].count, 1, 'outcome replay must not append a second event');
          assert.equal(await worker.finishRun(claim.lease, 'cancelled'), true);
        } else {
          assert.equal(run.state, 'needs_attention');
        }
      } finally { await close(context); }
    });
  }
});

dbTest('time limits use database timestamps for tick, run, and model-call deadlines', async t => {
  const cases = [
    {
      name: 'tick deadline',
      blockerCode: 'model_tick_deadline',
      limits: { ...LIMITS, tickDeadlineSeconds: 30, modelCallDeadlineSeconds: 10, leaseSeconds: 120 },
      expire: async (context, runId) => context.ownerPool.query(`UPDATE agent_worker.runs
        SET lease_started_at = clock_timestamp() - interval '31 seconds' WHERE run_id = $1`, [runId]),
    },
    {
      name: 'run lifetime',
      blockerCode: 'model_run_deadline',
      limits: { ...LIMITS, runLifetimeSeconds: 3600 },
      expire: async (context, runId) => context.ownerPool.query(`UPDATE agent_worker.runs
        SET created_at = clock_timestamp() - interval '3601 seconds' WHERE run_id = $1`, [runId]),
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const context = await setup();
      try {
        const worker = store(context.workerPool);
        const reserveModelCall = budgetMethod(worker, 'reserveModelCall');
        const manifest = manifestFor(context.jobs[0], {
          manifestHash: operationKey(`budget-time-${scenario.name}`),
          limits: scenario.limits,
        });
        const claim = await worker.claimTick({ invocationId: randomUUID(), manifest });
        await scenario.expire(context, claim.lease.runId);
        const stopped = await reserveModelCall(claim.lease,
          modelRequest(claim.lease, `late-${scenario.name}`));
        assert.equal(stopped.status, 'needs_attention');
        assert.equal(stopped.canExecute, false);
        assert.equal(stopped.blockerCode, scenario.blockerCode);
        const run = await worker.getRun(claim.lease.runId);
        assert.equal(run.modelCallCount, 0);
        assert.equal(run.state, 'needs_attention');
        const operations = await context.ownerPool.query(
          'SELECT count(*)::int AS count FROM agent_worker.operations WHERE run_id = $1 AND kind = $2',
          [claim.lease.runId, 'model_call']);
        assert.equal(operations.rows[0].count, 0, 'late calls must not create model intents');
      } finally { await close(context); }
    });
  }

  await t.test('call deadline', async () => {
    const context = await setup();
    try {
      const worker = store(context.workerPool);
      const reserveModelCall = budgetMethod(worker, 'reserveModelCall');
      const recordModelCallOutcome = budgetMethod(worker, 'recordModelCallOutcome');
      const manifest = manifestFor(context.jobs[0], {
        manifestHash: operationKey('budget-time-call-deadline'),
        limits: {
          ...LIMITS,
          tickDeadlineSeconds: 30,
          modelCallDeadlineSeconds: 10,
          leaseSeconds: 120,
        },
      });
      const claim = await worker.claimTick({ invocationId: randomUUID(), manifest });
      const reserved = await reserveModelCall(claim.lease, modelRequest(claim.lease, 'call-deadline'));
      assert.equal(reserved.status, 'reserved');
      const deadline = await context.ownerPool.query(`SELECT operations.call_deadline_at,
        operations.created_at, runs.limits->>'modelCallDeadlineSeconds' AS cap,
        operations.call_deadline_at > clock_timestamp() AS future
        FROM agent_worker.operations JOIN agent_worker.runs USING (run_id)
        WHERE operations.operation_id = $1`, [reserved.operationId]);
      assert.equal(deadline.rows[0].future, true);
      assert.ok(new Date(deadline.rows[0].call_deadline_at).getTime()
        <= new Date(deadline.rows[0].created_at).getTime() + Number(deadline.rows[0].cap) * 1000);
      await context.ownerPool.query(`UPDATE agent_worker.operations
        SET call_deadline_at = clock_timestamp() - interval '1 second'
        WHERE operation_id = $1`, [reserved.operationId]);
      const lateOutcome = await recordModelCallOutcome(claim.lease, {
        operationId: reserved.operationId,
        outcome: 'success',
        actualInputTokens: 8,
        actualOutputTokens: 6,
      });
      assert.equal(lateOutcome.status, 'needs_attention');
      assert.equal(lateOutcome.blockerCode, 'model_call_deadline');
      const run = await worker.getRun(claim.lease.runId);
      assert.equal(run.reservedInputTokens, 10);
      assert.equal(run.reservedOutputTokens, 10);
      assert.equal(run.state, 'needs_attention');
    } finally { await close(context); }
  });
});

dbTest('duplicate delivery and recovery exhaustion retain model reservations without replay', async () => {
  const context = await setup();
  try {
    const worker = store(context.workerPool);
    const reserveModelCall = budgetMethod(worker, 'reserveModelCall');
    const manifest = manifestFor(context.jobs[0], {
      manifestHash: operationKey('budget-recovery-reservation'),
    });
    const invocationId = randomUUID();
    const firstClaim = await worker.claimTick({ invocationId, manifest });
    const request = modelRequest(firstClaim.lease, 'recoverable');
    const reserved = await reserveModelCall(firstClaim.lease, request);
    assert.equal(reserved.status, 'reserved');
    assert.notEqual((await worker.claimTick({ invocationId, manifest })).status, 'claimed');

    let lease = firstClaim.lease;
    for (let recovery = 1; recovery <= LIMITS.expiredLeaseRecoveries; recovery += 1) {
      await context.ownerPool.query(`UPDATE agent_worker.runs SET lease_expires_at =
        clock_timestamp() - interval '1 second' WHERE run_id = $1`, [lease.runId]);
      const recovered = await worker.claimTick({ invocationId: randomUUID(), manifest });
      assert.equal(recovered.status, 'claimed');
      const staleOutcome = await worker.recordModelCallOutcome(lease, {
        operationId: reserved.operationId,
        outcome: 'success',
        actualInputTokens: 8,
        actualOutputTokens: 6,
      });
      assert.equal(staleOutcome.status, 'stale', 'a prior owner cannot account usage after a recovery fence advances');
      lease = recovered.lease;
      const replay = await reserveModelCall(lease, request);
      assert.equal(replay.status, 'existing');
      assert.equal(replay.canExecute, false);
      const run = await worker.getRun(lease.runId);
      assert.equal(run.modelCallCount, 1);
      assert.equal(run.reservedInputTokens, 10);
      assert.equal(run.reservedOutputTokens, 10);
    }

    await context.ownerPool.query(`UPDATE agent_worker.runs SET lease_expires_at =
      clock_timestamp() - interval '1 second' WHERE run_id = $1`, [lease.runId]);
    const exhausted = await worker.claimTick({ invocationId: randomUUID(), manifest });
    assert.equal(exhausted.status, 'idle');
    const stopped = await worker.getRun(lease.runId);
    assert.equal(stopped.state, 'needs_attention');
    assert.equal(stopped.blockerCode, 'lease_recovery_limit');
    assert.equal(stopped.modelCallCount, 1);
    assert.equal(stopped.reservedInputTokens, 10);
    assert.equal(stopped.reservedOutputTokens, 10);
    const replayAfterExhaustion = await reserveModelCall(lease,
      modelRequest(lease, 'after-recovery-limit'));
    assert.equal(replayAfterExhaustion.status, 'stale');
    assert.equal(replayAfterExhaustion.canExecute, false);
    const operations = await context.ownerPool.query(
      'SELECT count(*)::int AS count FROM agent_worker.operations WHERE run_id = $1 AND kind = $2',
      [lease.runId, 'model_call']);
    assert.equal(operations.rows[0].count, 1);
  } finally { await close(context); }
});

dbTest('CI and Qodo repairs share two idempotent reservations and stop without losing references', async () => {
  const context = await setup();
  try {
    const worker = store(context.workerPool);
    const reserveRepairCycle = budgetMethod(worker, 'reserveRepairCycle');
    const reserveModelCall = budgetMethod(worker, 'reserveModelCall');
    const manifest = manifestFor(context.jobs[0], {
      manifestHash: operationKey('budget-repair-shared'),
      limits: { ...LIMITS, repairCycles: 2 },
    });
    const first = await worker.claimTick({ invocationId: randomUUID(), manifest });
    const knownHead = 'f'.repeat(40);
    assert.equal(await worker.checkpoint(first.lease, {
      state: 'waiting_review',
      expectedHeadSha: knownHead,
      branchName: `agent-work/${first.lease.runId}`,
      pullRequestNumber: 77,
    }), true);
    const claim = await worker.claimTick({ invocationId: randomUUID(), manifest });
    assert.equal(claim.status, 'claimed');
    const lease = claim.lease;

    await expectRejectedBeforeSql(context.workerPool,
      () => worker.checkpoint(lease, { state: 'repairing', repairCycleCount: 99 }),
      'generic checkpoints cannot mutate repair counters');

    const ciRequest = {
      key: operationKey(`repair:${lease.runId}:ci-1`),
      source: 'ci',
      headSha: knownHead,
    };
    const ci = await reserveRepairCycle(lease, ciRequest);
    assert.equal(ci.status, 'reserved');
    assert.equal(ci.canRepair, true);
    const ciReplay = await reserveRepairCycle(lease, ciRequest);
    assert.equal(ciReplay.status, 'existing');
    assert.equal(ciReplay.canRepair, false);
    const qodo = await reserveRepairCycle(lease, {
      key: operationKey(`repair:${lease.runId}:qodo-1`),
      source: 'qodo',
      headSha: knownHead,
    });
    assert.equal(qodo.status, 'reserved');
    assert.equal(qodo.canRepair, true);
    assert.equal((await worker.getRun(lease.runId)).repairCycleCount, 2);

    const third = await reserveRepairCycle(lease, {
      key: operationKey(`repair:${lease.runId}:ci-2`),
      source: 'ci',
      headSha: knownHead,
    });
    assert.equal(third.status, 'needs_attention');
    assert.equal(third.canRepair, false);
    assert.equal(third.blockerCode, 'repair_cycle_limit');
    const stopped = await worker.getRun(lease.runId);
    assert.equal(stopped.state, 'needs_attention');
    assert.equal(stopped.repairCycleCount, 2);
    assert.equal(stopped.branchName, `agent-work/${lease.runId}`);
    assert.equal(stopped.expectedHeadSha, knownHead);
    assert.equal(stopped.pullRequestNumber, 77);
    const events = await context.ownerPool.query(`SELECT event_type, repair_key, repair_source,
      repair_head_sha FROM agent_worker.events WHERE run_id = $1 AND repair_key IS NOT NULL
      ORDER BY event_id`, [lease.runId]);
    assert.deepEqual(events.rows.map(row => [row.event_type, row.repair_source, row.repair_head_sha]), [
      ['repair_reserved', 'ci', knownHead],
      ['repair_reserved', 'qodo', knownHead],
      ['repair_limit_reached', 'ci', knownHead],
    ]);
    const noCall = await reserveModelCall(lease, modelRequest(lease, 'after-repair-limit'));
    assert.equal(noCall.status, 'stale');
    assert.equal(noCall.canExecute, false);
    const noWrite = await worker.putIntent(lease, {
      key: operationKey(`branch:${lease.runId}:after-repair-limit`),
      kind: 'branch_create',
      inputHash: 'd'.repeat(64),
      expectedHeadSha: knownHead,
    });
    assert.equal(noWrite.status, 'stale');
    const operations = await context.ownerPool.query(
      'SELECT count(*)::int AS count FROM agent_worker.operations WHERE run_id = $1',
      [lease.runId]);
    assert.equal(operations.rows[0].count, 0);
  } finally { await close(context); }
});

dbTest('stricter per-call input and per-run call limits stop before another reservation', async t => {
  await t.test('input bound', async () => {
    const context = await setup();
    try {
      const worker = store(context.workerPool);
      const reserveModelCall = budgetMethod(worker, 'reserveModelCall');
      const manifest = manifestFor(context.jobs[0], {
        manifestHash: operationKey('budget-input-call-limit'),
        limits: {
          ...LIMITS,
          inputTokensPerCall: 100,
          inputTokensPerRun: 100,
        },
      });
      const claim = await worker.claimTick({ invocationId: randomUUID(), manifest });
      const result = await reserveModelCall(claim.lease,
        modelRequest(claim.lease, 'input-over-call', { inputTokens: 101 }));
      assert.equal(result.status, 'needs_attention');
      assert.equal(result.blockerCode, 'model_input_token_limit');
      const run = await worker.getRun(claim.lease.runId);
      assert.equal(run.modelCallCount, 0);
      assert.equal(run.reservedInputTokens, 0);
      assert.equal(run.state, 'needs_attention');
    } finally { await close(context); }
  });

  await t.test('run call count', async () => {
    const context = await setup();
    try {
      const worker = store(context.workerPool);
      const reserveModelCall = budgetMethod(worker, 'reserveModelCall');
      const manifest = manifestFor(context.jobs[0], {
        manifestHash: operationKey('budget-run-call-limit'),
        limits: { ...LIMITS, modelCallsPerRun: 1 },
      });
      const first = await worker.claimTick({ invocationId: randomUUID(), manifest });
      const firstReservation = await reserveModelCall(first.lease,
        modelRequest(first.lease, 'run-first'));
      assert.equal(firstReservation.status, 'reserved');
      assert.equal((await worker.recordModelCallOutcome(first.lease, {
        operationId: firstReservation.operationId,
        outcome: 'success',
        actualInputTokens: 10,
        actualOutputTokens: 10,
      })).status, 'recorded');
      assert.equal(await worker.checkpoint(first.lease, { state: 'waiting_ci' }), true);
      const next = await worker.claimTick({ invocationId: randomUUID(), manifest });
      const stopped = await reserveModelCall(next.lease,
        modelRequest(next.lease, 'run-second'));
      assert.equal(stopped.status, 'needs_attention');
      assert.equal(stopped.blockerCode, 'model_call_budget_exhausted');
      const run = await worker.getRun(first.lease.runId);
      assert.equal(run.modelCallCount, 1);
      assert.equal(run.reservedInputTokens, 10);
      assert.equal(run.reservedOutputTokens, 10);
    } finally { await close(context); }
  });
});

dbTest('a lost reservation commit acknowledgment retains the slot and cannot authorize replay', async () => {
  const context = await setup();
  try {
    const worker = store(context.workerPool);
    const manifest = manifestFor(context.jobs[0], {
      manifestHash: operationKey('budget-lost-reservation-ack'),
    });
    const claim = await worker.claimTick({ invocationId: randomUUID(), manifest });
    const request = modelRequest(claim.lease, 'lost-ack');
    let loseCommitAck = true;
    const connectedPool = context.workerPool;
    const uncertainPool = {
      async connect() {
        const client = await connectedPool.connect();
        return {
          async query(sql, values) {
            const result = await client.query(sql, values);
            if (loseCommitAck && sql === 'COMMIT') {
              loseCommitAck = false;
              throw new Error('synthetic commit acknowledgment loss');
            }
            return result;
          },
          release: client.release,
        };
      },
      query: connectedPool.query,
    };
    const uncertainStore = store(uncertainPool);
    let failure;
    try {
      await uncertainStore.reserveModelCall(claim.lease, request);
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.message, SAFE_ERROR);
    assert.equal(failure && Object.hasOwn(failure, 'cause'), false);

    const replay = await worker.reserveModelCall(claim.lease, request);
    assert.equal(replay.status, 'existing');
    assert.equal(replay.canExecute, false);
    const run = await worker.getRun(claim.lease.runId);
    assert.equal(run.modelCallCount, 1);
    assert.equal(run.reservedInputTokens, 10);
    assert.equal(run.reservedOutputTokens, 10);
    const rows = await context.ownerPool.query(`SELECT count(*)::int AS count,
      count(*) FILTER (WHERE outcome_code IS NULL)::int AS unresolved
      FROM agent_worker.operations WHERE run_id = $1 AND kind = 'model_call'`,
    [claim.lease.runId]);
    assert.equal(rows.rows[0].count, 1);
    assert.equal(rows.rows[0].unresolved, 1);
    assert.equal(await worker.finishRun(claim.lease, 'cancelled'), true);
    assert.equal((await worker.getRun(claim.lease.runId)).modelCallCount, 1);
  } finally { await close(context); }
});

dbTest('an unresolved model reservation stops later generations instead of authorizing another call', async () => {
  const context = await setup();
  try {
    const worker = store(context.workerPool);
    const reserveModelCall = budgetMethod(worker, 'reserveModelCall');
    const manifest = manifestFor(context.jobs[0], {
      manifestHash: operationKey('budget-unresolved-reservation'),
    });
    const first = await worker.claimTick({ invocationId: randomUUID(), manifest });
    const request = modelRequest(first.lease, 'unresolved-first');
    const reserved = await reserveModelCall(first.lease, request);
    assert.equal(reserved.status, 'reserved');
    await context.ownerPool.query(`UPDATE agent_worker.runs SET lease_expires_at =
      clock_timestamp() - interval '1 second' WHERE run_id = $1`, [first.lease.runId]);
    const recovered = await worker.claimTick({ invocationId: randomUUID(), manifest });
    assert.equal(recovered.status, 'claimed');
    const replay = await reserveModelCall(recovered.lease, request);
    assert.equal(replay.status, 'existing');
    assert.equal(replay.canExecute, false);

    const blocked = await reserveModelCall(recovered.lease,
      modelRequest(recovered.lease, 'unresolved-second'));
    assert.equal(blocked.status, 'needs_attention');
    assert.equal(blocked.canExecute, false);
    assert.equal(blocked.blockerCode, 'model_outcome_uncertain');
    const run = await worker.getRun(first.lease.runId);
    assert.equal(run.state, 'needs_attention');
    assert.equal(run.modelCallCount, 1);
    assert.equal(run.reservedInputTokens, 10);
    assert.equal(run.reservedOutputTokens, 10);
    const operations = await context.ownerPool.query(
      'SELECT count(*)::int AS count FROM agent_worker.operations WHERE run_id = $1 AND kind = $2',
      [first.lease.runId, 'model_call']);
    assert.equal(operations.rows[0].count, 1);
  } finally { await close(context); }
});

dbTest('budget APIs reject untrusted payload fields before database access', async () => {
  const context = await setup();
  try {
    const worker = store(context.workerPool);
    const reserveModelCall = budgetMethod(worker, 'reserveModelCall');
    const recordModelCallOutcome = budgetMethod(worker, 'recordModelCallOutcome');
    const reserveRepairCycle = budgetMethod(worker, 'reserveRepairCycle');
    const manifest = manifestFor(context.jobs[0], {
      manifestHash: operationKey('budget-input-privacy'),
    });
    const claim = await worker.claimTick({ invocationId: randomUUID(), manifest });
    assert.equal(claim.status, 'claimed');
    const request = modelRequest(claim.lease, 'untrusted-payload');

    await expectRejectedBeforeSql(context.workerPool,
      () => reserveModelCall(claim.lease, { ...request, prompt: 'synthetic test text' }),
      'model reservation payload fields');
    await expectRejectedBeforeSql(context.workerPool,
      () => recordModelCallOutcome(claim.lease, {
        operationId: randomUUID(),
        outcome: 'provider_failure',
        message: 'synthetic test detail',
      }),
      'provider error details');
    await expectRejectedBeforeSql(context.workerPool,
      () => recordModelCallOutcome(claim.lease, {
        operationId: randomUUID(),
        outcome: 'synthetic_unknown_outcome',
      }),
      'unrecognized outcome categories');
    await expectRejectedBeforeSql(context.workerPool,
      () => reserveRepairCycle(claim.lease, {
        key: operationKey(`repair:${claim.lease.runId}:private-text`),
        source: 'qodo',
        headSha: manifest.baseRevision,
        finding: 'synthetic test finding',
      }),
      'repair finding payloads');
    const operations = await context.ownerPool.query(
      'SELECT count(*)::int AS count FROM agent_worker.operations WHERE run_id = $1',
      [claim.lease.runId]);
    assert.equal(operations.rows[0].count, 0);
  } finally { await close(context); }
});

dbTest('queued acquisition without pool timeouts is bounded and destroys the late real connection', async () => {
  const context = await setup();
  const pool = new pg.Pool({ connectionString: process.env.AGENT_INTAKE_TEST_DATABASE_URL, max: 1 });
  let held;
  try {
    const normal = store(context.workerPool);
    const claim = await normal.claimTick({ invocationId: randomUUID(),
      manifest: manifestFor(context.jobs[0]) });
    const run = await normal.getRun(claim.lease.runId);
    assert.equal(claim.deadline, Date.parse(run.tickDeadlineAt));
    assert.ok(claim.deadline < Date.parse(claim.lease.expiresAt));
    held = await pool.connect();
    let queries = 0;
    let discarded = 0;
    const worker = moduleStore.createWorkerStore({
      async connect() {
        const client = await pool.connect();
        return {
          query(...args) { queries += 1; return client.query(...args); },
          release(error) { if (error) discarded += 1; client.release(error); },
        };
      },
    }, { timeoutMs: 30 });
    await assert.rejects(worker.getRun(randomUUID()), { message: SAFE_ERROR });
    assert.equal(pool.waitingCount, 1, 'the driver acquisition remains queued after local expiry');
    held.release();
    held = null;
    const until = Date.now() + 2000;
    while (discarded === 0 && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(discarded, 1);
    assert.equal(queries, 0, 'the late connection must never start SQL');
    assert.equal(pool.waitingCount, 0);
    assert.equal(pool.idleCount, 0, 'the late connection must be removed rather than reused');
  } finally {
    held?.release();
    await pool.end();
    await close(context);
  }
});

for (const phase of ['BEGIN', 'SET LOCAL lock_timeout', 'SET LOCAL statement_timeout']) {
  dbTest(`real PostgreSQL stalled ${phase} cannot continue transaction body after expiry`, async () => {
    const context = await setup();
    const commands = [];
    let backendId;
    let discarded = 0;
    try {
      const worker = moduleStore.createWorkerStore({
        async connect() {
          const client = await context.workerPool.connect();
          backendId = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          return {
            query(sql, values) {
              commands.push(typeof sql === 'string' ? sql : sql.text);
              if (typeof sql === 'string' && sql.startsWith(phase)) {
                // PostgreSQL really accepts BEGIN/startup before suspending on a server-side wait.
                return client.query(`${sql}; SELECT pg_sleep(1)`);
              }
              return client.query(sql, values);
            },
            release(error) { if (error) discarded += 1; client.release(error); },
          };
        },
      }, { timeoutMs: 60 });
      await assert.rejects(worker.claimTick({ invocationId: randomUUID(),
        manifest: manifestFor(context.jobs[0]) }), { message: SAFE_ERROR });
      assert.equal(discarded, 1);
      const before = [...commands];
      const until = Date.now() + 2500;
      let active = true;
      while (active && Date.now() < until) {
        active = (await context.ownerPool.query('SELECT pid FROM pg_stat_activity WHERE pid = $1',
          [backendId])).rows.length !== 0;
        if (active) await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(active, false, 'release(error) destroys the active backend instead of pooling it');
      assert.deepEqual(commands, before);
      assert.equal(commands.some(sql => sql.includes('pg_try_advisory_xact_lock')), false);
      assert.equal(commands.includes('COMMIT'), false);
      assert.equal((await context.ownerPool.query('SELECT run_id FROM agent_worker.runs WHERE job_id = $1',
        [context.jobs[0].jobId])).rows.length, 0);
    } finally { await close(context); }
  });
}

for (const method of ['putIntent', 'confirmIntent', 'finishRun']) {
  dbTest(`row-lock expiry prevents late durable ${method} writes`, async () => {
    const context = await setup();
    let blocker;
    try {
      const normal = store(context.workerPool);
      const claim = await normal.claimTick({ invocationId: randomUUID(),
        manifest: manifestFor(context.jobs[0]) });
      const intent = { key: operationKey(`bounded-lock-${method}`), kind: 'commit_create',
        inputHash: 'd'.repeat(64), expectedHeadSha: 'b'.repeat(40) };
      if (method === 'confirmIntent') assert.equal((await normal.putIntent(claim.lease, intent)).status, 'created');
      blocker = await context.ownerPool.connect();
      await blocker.query('BEGIN');
      await blocker.query('SELECT run_id FROM agent_worker.runs WHERE run_id = $1 FOR UPDATE', [claim.lease.runId]);
      const worker = moduleStore.createWorkerStore(context.workerPool, { timeoutMs: 40 });
      const proof = { status: 'confirmed', branch: `agent-work/${claim.lease.runId}`,
        inputHash: intent.inputHash, baseSha: intent.expectedHeadSha,
        parentSha: intent.expectedHeadSha, commitSha: 'e'.repeat(40),
        treeSha: 'f'.repeat(40), branchHeadSha: 'e'.repeat(40) };
      const pending = method === 'putIntent' ? worker.putIntent(claim.lease, intent, { deadline: claim.deadline })
        : method === 'confirmIntent' ? worker.confirmIntent(claim.lease, intent, proof, { deadline: claim.deadline })
          : worker.finishRun(claim.lease, 'needs_attention', { blockerCode: 'recovery_effect_unconfirmed' },
            { deadline: claim.deadline });
      await assert.rejects(pending, { message: SAFE_ERROR });
      await blocker.query('ROLLBACK');
      blocker.release();
      blocker = null;
      await new Promise(resolve => setTimeout(resolve, 60));
      const operations = (await context.ownerPool.query(`SELECT effect_phase FROM agent_worker.operations
        WHERE run_id = $1`, [claim.lease.runId])).rows;
      assert.deepEqual(operations, method === 'confirmIntent' ? [{ effect_phase: 'prepared' }] : []);
      const run = await normal.getRun(claim.lease.runId);
      assert.equal(run.state, 'claimed');
      assert.equal(run.terminalAt, null);
      assert.equal(run.expectedHeadSha, null);
    } finally {
      if (blocker) { await blocker.query('ROLLBACK'); blocker.release(); }
      await close(context);
    }
  });
}

for (const deadline of ['tick', 'run']) {
  dbTest(`database-authoritative ${deadline} expiry denies confirmation and terminal writes`, async () => {
    const context = await setup();
    try {
      const worker = store(context.workerPool);
      const manifest = manifestFor(context.jobs[0]);
      const { lease } = await worker.claimTick({ invocationId: randomUUID(), manifest });
      const intent = { key: operationKey(`expired-${deadline}`), kind: 'commit_create',
        inputHash: 'd'.repeat(64), expectedHeadSha: manifest.baseRevision };
      assert.equal((await worker.putIntent(lease, intent)).status, 'created');
      await context.ownerPool.query(deadline === 'tick'
        ? `UPDATE agent_worker.runs SET lease_started_at = clock_timestamp() - interval '91 seconds' WHERE run_id = $1`
        : `UPDATE agent_worker.runs SET created_at = clock_timestamp() - interval '7201 seconds' WHERE run_id = $1`,
      [lease.runId]);
      const proof = { status: 'confirmed', branch: `agent-work/${lease.runId}`,
        inputHash: intent.inputHash, baseSha: manifest.baseRevision,
        parentSha: manifest.baseRevision, commitSha: 'e'.repeat(40),
        treeSha: 'f'.repeat(40), branchHeadSha: 'e'.repeat(40) };
      assert.equal(await worker.confirmIntent(lease, intent, proof), false);
      assert.equal(await worker.finishRun(lease, 'needs_attention', { blockerCode: 'recovery_deadline' }), false);
      const run = await worker.getRun(lease.runId);
      assert.equal(run.state, 'claimed');
      assert.equal(run.terminalAt, null);
      assert.equal((await context.ownerPool.query('SELECT effect_phase FROM agent_worker.operations WHERE run_id = $1',
        [lease.runId])).rows[0].effect_phase, 'prepared');
    } finally { await close(context); }
  });
}

dbTest('a stalled actual COMMIT acknowledgment retains one durable invocation without replay', async () => {
  const context = await setup();
  let discarded = 0;
  let injected = false;
  try {
    const manifest = manifestFor(context.jobs[0]);
    const invocationId = randomUUID();
    const worker = moduleStore.createWorkerStore({
      async connect() {
        const client = await context.workerPool.connect();
        return {
          query(sql, values) {
            if (sql === 'COMMIT' && !injected) {
              injected = true;
              return client.query('COMMIT; SELECT pg_sleep(1)');
            }
            return client.query(sql, values);
          },
          release(error) { if (error) discarded += 1; client.release(error); },
        };
      },
    }, { timeoutMs: 100 });
    await assert.rejects(worker.claimTick({ invocationId, manifest }), { message: SAFE_ERROR });
    assert.equal(injected, true);
    assert.equal(discarded, 1);
    const normal = store(context.workerPool);
    assert.equal((await normal.claimTick({ invocationId, manifest })).status, 'busy');
    const rows = (await context.ownerPool.query(`SELECT runs.run_id, runs.generation,
      count(events.event_id)::integer AS claims FROM agent_worker.runs AS runs
      JOIN agent_worker.events AS events USING (run_id)
      WHERE runs.job_id = $1 AND events.event_type = 'tick_claimed'
      GROUP BY runs.run_id, runs.generation`, [context.jobs[0].jobId])).rows;
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].generation), 1);
    assert.equal(rows[0].claims, 1);
  } finally { await close(context); }
});
