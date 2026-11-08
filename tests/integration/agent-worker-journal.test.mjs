import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { openDisposablePool } from '../support/agent-intake-database.mjs';
import { createWorkerStore } from '../../src/automation/worker/store.mjs';
import { createRecoveryCoordinator } from '../../src/automation/worker/recovery.mjs';
import { buildOperationHash, validationBaseFromTree } from '../../src/automation/worker/publication-validation.mjs';
import { validateChanges } from '../../src/automation/worker/patch.mjs';
import { createPublisherFixture, RUN_ID, COMMIT_SHA, CHANGE_PATH } from '../fixtures/agent-worker-publication.mjs';
import { SAFE, HEAD, CHILD, HASH, ROLE, hash, withJournal, phase, initialize,
  modelRequest, successfulModel, descriptor, candidate, proof, prepared,
  rejectedQuery, rolledBack, acknowledgmentLoss } from '../support/agent-worker-journal-database.mjs';

const enabled = Boolean(process.env.AGENT_INTAKE_TEST_DATABASE_URL && process.env.AGENT_INTAKE_TEST_RUN_ID);
const dbTest = enabled ? test : test.skip;

async function move(context, purpose, state) {
  const row = await context.row();
  const p = phase(context, purpose, { headSha: row.expected_head_sha ?? row.base_revision,
    repairCycle: row.repair_cycle_count, findingSha256: row.finding_sha256 });
  assert.equal(await context.worker.checkpoint(context.lease, { state, coordinator: p }), true);
  await context.claim();
  return p;
}
async function publish(context, p, child) {
  const modelId = await successfulModel(context, { expectedHeadSha: p.headSha });
  let intent = candidate(context, p, modelId);
  if (!p.purpose.endsWith('_tests')) {
    const snapshot = await context.worker.getCoordinatorSnapshot(context.lease);
    intent.coordinator.expectedRegression = snapshot.phase.expectedRegression;
    intent.coordinator.criterionSha256 = snapshot.phase.criterionSha256;
  }
  assert.equal((await context.worker.putIntent(context.lease, intent)).status, 'created');
  assert.equal(await context.worker.confirmIntent(context.lease, intent, proof(context, intent, child)), true);
  return intent;
}
async function initialImplementation(context) {
  const p = await initialize(context);
  await publish(context, p, CHILD);
  const implementation = await move(context, 'initial_implementation', 'implementing');
  await publish(context, implementation, 'd'.repeat(40));
}
async function openDraft(context) {
  const p = await move(context, 'draft_pr', 'opening_pr');
  const snapshot = await context.worker.getCoordinatorSnapshot(context.lease);
  const intent = { key: hash(randomUUID()), kind: 'pr_create', inputHash: HASH,
    expectedHeadSha: p.headSha, coordinator: { version: 1, purpose: 'draft_pr', phaseKey: p.key,
      repairCycle: p.repairCycle, modelOperationId: null,
      expectedRegression: snapshot.phase.expectedRegression,
      criterionSha256: snapshot.phase.criterionSha256, candidateDescriptors: [] } };
  assert.equal((await context.worker.putIntent(context.lease, intent)).status, 'created');
  const confirmation = { status: 'confirmed', branch: `agent-work/${context.lease.runId}`,
    inputHash: intent.inputHash, baseSha: context.manifest.baseRevision,
    branchHeadSha: p.headSha, prId: 900, prNumber: 42, prCount: 1, headSha: p.headSha, draft: true };
  assert.equal(await context.worker.confirmIntent(context.lease, intent, confirmation), true);
  return { intent, confirmation };
}

// These eight stable top-level identities intentionally remain visible to normal discovery.
dbTest('journal DB: marker authorization, migrations and restricted runtime grants', async t => {
  await t.test('environment variables do not replace the database marker', async () => {
    await assert.rejects(openDisposablePool({ ...process.env,
      AGENT_INTAKE_TEST_RUN_ID: process.env.AGENT_INTAKE_TEST_RUN_ID === 'e'.repeat(64)
        ? 'd'.repeat(64) : 'e'.repeat(64) }),
    /^Error: Disposable database verification failed; no migrations are authorized\.$/);
    const verified = await openDisposablePool();
    try {
      const result = await verified.query(`SELECT to_regnamespace('agent_intake') IS NULL AS no_intake,
        to_regnamespace('agent_worker') IS NULL AS no_worker,
        NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'journal_test_runtime') AS no_role`)
        .catch(() => { throw new Error('Journal preflight check failed; private details withheld.'); });
      assert.deepEqual(result.rows, [{ no_intake: true, no_worker: true, no_role: true }]);
    } finally { await verified.end(); }
  });
  await withJournal(async context => {
    await t.test('001 002 and 003 objects exist after guarded owner setup', async () => {
      const { rows } = await context.runtime.query(`SELECT
        to_regclass('agent_intake.jobs') IS NOT NULL AS intake,
        to_regclass('agent_worker.operations') IS NOT NULL AS operations,
        to_regclass('agent_worker.candidate_descriptors') IS NOT NULL AS descriptors,
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'agent_worker'
          AND table_name = 'operations' AND column_name = 'outcome_code') AS recovery,
        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'coordinator_candidate_operation'
          AND tgdeferrable AND tginitdeferred) AS deferred`);
      assert.deepEqual(rows, [{ intake: true, operations: true, descriptors: true, recovery: true, deferred: true }]);
    });
    await t.test('the driver authenticates as the nonadministrative runtime itself', async () => {
      const { rows } = await context.runtime.query(`SELECT current_user AS effective, session_user AS session,
        rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolinherit,
        EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid) AS memberships
        FROM pg_roles r WHERE rolname = current_user`);
      assert.deepEqual(rows, [{ effective: ROLE, session: ROLE, rolsuper: false,
        rolcreatedb: false, rolcreaterole: false, rolbypassrls: false, rolinherit: false, memberships: false }]);
    });
    await t.test('table privileges exactly match the journal runtime contract', async () => {
      for (const [table, allowed] of [
        ['agent_intake.jobs', ['SELECT']],
        ['agent_worker.runs', ['SELECT', 'INSERT', 'UPDATE']],
        ['agent_worker.operations', ['SELECT', 'INSERT', 'UPDATE']],
        ['agent_worker.events', ['SELECT', 'INSERT']],
        ['agent_worker.candidate_descriptors', ['SELECT', 'INSERT']],
      ]) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
          const result = await context.runtime.query('SELECT has_table_privilege(current_user, $1, $2) AS allowed', [table, privilege]);
          assert.equal(result.rows[0].allowed, allowed.includes(privilege), `${table} ${privilege}`);
        }
      }
    });
    await t.test('runtime owns no schema or table and cannot create in schemas', async () => {
      const result = await context.runtime.query(`SELECT
        has_schema_privilege(current_user, 'agent_worker', 'CREATE') AS worker_create,
        has_schema_privilege(current_user, 'agent_intake', 'CREATE') AS intake_create,
        has_schema_privilege(current_user, 'public', 'CREATE') AS public_create,
        has_database_privilege(current_user, current_database(), 'CREATE') AS database_create,
        EXISTS (SELECT 1 FROM pg_class WHERE relnamespace IN
          ('agent_worker'::regnamespace, 'agent_intake'::regnamespace)
          AND relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)) AS owns_table,
        EXISTS (SELECT 1 FROM pg_namespace WHERE nspname IN ('agent_worker','agent_intake')
          AND nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)) AS owns_schema`);
      assert.deepEqual(result.rows, [{ worker_create: false, intake_create: false,
        public_create: false, database_create: false, owns_table: false, owns_schema: false }]);
      await rejectedQuery(context.runtime, 'CREATE TABLE agent_worker.journal_forbidden (id integer)', [], ['42501']);
    });
    await t.test('actual writes cannot update descriptors or intake jobs', async () => {
      await rejectedQuery(context.runtime, 'UPDATE agent_intake.jobs SET actor_id = actor_id WHERE job_id = $1', [context.job.jobId], ['42501']);
      await rejectedQuery(context.runtime, 'UPDATE agent_worker.candidate_descriptors SET byte_count = byte_count WHERE run_id = $1', [context.lease.runId], ['42501']);
      await rejectedQuery(context.runtime, 'DELETE FROM agent_worker.candidate_descriptors WHERE run_id = $1', [context.lease.runId], ['42501']);
    });
  });
});

dbTest('journal DB: phase initialization, legacy compatibility and forged transitions', async t => {
  await t.test('legacy snapshot and methods still work after 003', () => withJournal(async context => {
    const snapshot = await context.worker.getCoordinatorSnapshot(context.lease);
    assert.equal(snapshot.status, 'owned');
    assert.equal(snapshot.phase, null);
    assert.equal((await context.worker.getRun(context.lease.runId)).state, 'claimed');
    assert.equal(await context.worker.checkpoint(context.lease, { state: 'generating_tests' }), true);
  }));
  await t.test('initialization persists the closed phase and database time', () => withJournal(async context => {
    const before = (await context.owner.query('SELECT clock_timestamp() AS now')).rows[0].now;
    const p = await initialize(context);
    const snapshot = await context.worker.getCoordinatorSnapshot(context.lease);
    assert.equal(snapshot.phase.key, p.key);
    assert.equal(snapshot.phase.purpose, 'initial_tests');
    assert.equal(snapshot.phase.waitStartedAt, null);
    assert.ok(Date.parse(snapshot.phase.startedAt) >= before.getTime());
    assert.equal(await context.worker.checkpoint(context.lease, { state: 'waiting_ci' }), false);
  }));
  for (const [label, mutate] of [
    ['version', p => ({ ...p, version: 2 })], ['key', p => ({ ...p, key: HASH })],
    ['parent', p => ({ ...p, headSha: CHILD })],
    ['purpose', p => ({ ...p, purpose: 'initial_implementation' })],
    ['round', p => ({ ...p, repairCycle: 1 })],
    ['regression', p => ({ ...p, expectedRegression: { workflowId: 7, testIdentitySha256: HASH, proposalSha256: HASH } })],
    ['criterion', p => ({ ...p, criterionSha256: HASH })],
    ['caller wait timestamp', p => ({ ...p, waitStartedAt: new Date().toISOString() })],
  ]) {
    await t.test(`forged ${label} is rejected without phase mutation`, () => withJournal(async context => {
      const p = phase(context);
      await assert.rejects(context.worker.checkpoint(context.lease,
        { state: 'generating_tests', coordinator: mutate(p) }), SAFE);
      assert.equal((await context.row()).coordinator_version, null);
    }));
  }
  for (const [label, purpose, state, overrides] of [
    ['implementation before a confirmed regression', 'initial_implementation', 'implementing', {}],
    ['draft before green implementation', 'draft_pr', 'opening_pr', {}],
    ['repair without a reserved finding', 'repair_tests', 'repairing', { repairCycle: 1, findingSha256: HASH }],
    ['caller-created regression wait', 'initial_tests', 'waiting_red_ci', {}],
  ]) {
    await t.test(`legal-shaped phase cannot skip ${label}`, () => withJournal(async context => {
      await initialize(context);
      const before = await context.row();
      await assert.rejects(context.worker.checkpoint(context.lease, { state,
        coordinator: phase(context, purpose, overrides) }), SAFE);
      assert.equal((await context.row()).phase_key, before.phase_key);
      assert.equal((await context.row()).state, before.state);
    }));
  }
  for (const [label, assignment] of [
    ['version without phase', 'coordinator_version = 1'],
    ['partial regression', 'regression_workflow_id = 7'],
    ['partial finding', `finding_sha256 = '${HASH}'`],
  ]) {
    await t.test(`database check rejects ${label}`, () => withJournal(async context => {
      await rejectedQuery(context.runtime, `UPDATE agent_worker.runs SET ${assignment} WHERE run_id = $1`, [context.lease.runId], ['23514']);
    }));
  }
});

dbTest('journal DB: atomic model and candidate intents with typed ownership', async t => {
  await t.test('reservation success candidate descriptors and pending reference are durable', () => withJournal(async context => {
    const { intent, modelId, operationId } = await prepared(context);
    const snapshot = await context.worker.getCoordinatorSnapshot(context.lease);
    assert.equal(snapshot.modelOperation.operationId, modelId);
    assert.equal(snapshot.modelOperation.outcome, 'success');
    assert.equal(snapshot.pendingOperation.operationId, operationId);
    assert.deepEqual(snapshot.pendingOperation.coordinator, intent.coordinator);
    assert.equal(snapshot.phase.pendingOperationId, operationId);
    const row = await context.row();
    assert.equal(row.model_call_count, 1);
    assert.equal(row.reserved_input_tokens, 10);
    assert.equal(row.reserved_output_tokens, 10);
    assert.equal((await context.worker.putIntent(context.lease, intent)).status, 'existing');
    assert.equal((await context.worker.putIntent(context.lease,
      { ...intent, key: hash(randomUUID()) })).status, 'conflict');
    const blocked = await context.worker.reserveModelCall(context.lease, modelRequest(context));
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.blockerCode, 'coordinator_pending_effect');
    await assert.rejects(context.worker.checkpoint(context.lease, { state: 'generating_tests',
      coordinator: phase(context) }), SAFE);
    assert.equal((await context.row()).model_call_count, 1);
  }));
  for (const [label, change] of [
    ['same-run foreign model', intent => ({ ...intent.coordinator, modelOperationId: randomUUID() })],
    ['foreign phase', intent => ({ ...intent.coordinator, phaseKey: HASH })],
    ['wrong purpose', intent => ({ ...intent.coordinator, purpose: 'initial_implementation' })],
  ]) {
    await t.test(`${label} cannot create an intent`, () => withJournal(async context => {
      const p = await initialize(context);
      const modelId = await successfulModel(context);
      const intent = candidate(context, p, modelId);
      intent.coordinator = change(intent);
      assert.equal((await context.worker.putIntent(context.lease, intent)).status, 'conflict');
      assert.equal((await context.row()).pending_operation_id, null);
    }));
  }
  await t.test('wrong parent cannot create an intent', () => withJournal(async context => {
    const p = await initialize(context);
    const intent = candidate(context, p, await successfulModel(context), { expectedHeadSha: CHILD });
    assert.equal((await context.worker.putIntent(context.lease, intent)).status, 'conflict');
  }));
  await t.test('unresolved model is not a successful candidate authority', () => withJournal(async context => {
    const p = await initialize(context);
    const reservation = await context.worker.reserveModelCall(context.lease, modelRequest(context));
    assert.equal((await context.worker.putIntent(context.lease, candidate(context, p, reservation.operationId))).status, 'conflict');
  }));
  await t.test('typed model and descriptor FKs reject two existing but different runs', () => withJournal(async first => {
    const original = await prepared(first);
    assert.equal(await first.worker.finishRun(first.lease, 'cancelled'), true);
    await withJournal(async second => {
      const p = await initialize(second);
      const forged = candidate(second, p, original.modelId);
      assert.equal((await second.worker.putIntent(second.lease, forged)).status, 'conflict');
      await rolledBack(second.runtime, async client => {
        await assert.rejects(rawCandidate(second, client, { p, modelId: original.modelId }),
          { code: '23503', constraint: 'operation_model_phase' });
      });
      await rejectedQuery(second.runtime, `INSERT INTO agent_worker.candidate_descriptors
        (run_id, operation_id, ordinal, approved_path_index, change_kind, after_blob_sha,
         content_sha256, byte_count, file_mode) VALUES ($1,$2,1,1,'create',$3,$4,1,'100644')`,
      [second.lease.runId, original.operationId, HEAD, HASH], ['23503']);
      await rejectedQuery(second.runtime, `UPDATE agent_worker.runs SET pending_operation_id = $2
        WHERE run_id = $1`, [second.lease.runId, original.operationId], ['P0001']);
      assert.equal((await second.row()).pending_operation_id, null);
    });
  }));
  for (const [label, mutation] of [
    ['model kind', 'pending_operation_id = $2'],
    ['parent', 'phase_head_sha = $3, pending_operation_id = $2'],
    ['round', 'repair_cycle_count = 1, phase_round = 1, phase_purpose = \'repair_tests\', finding_sha256 = $4, finding_source = \'ci\', finding_head_sha = $3, pending_operation_id = $2'],
    ['purpose', 'phase_purpose = \'initial_implementation\', pending_operation_id = $2'],
  ]) {
    await t.test(`pending reference rejects wrong ${label}`, () => withJournal(async context => {
      const { modelId, operationId } = await prepared(context);
      await rejectedQuery(context.runtime, `UPDATE agent_worker.runs SET ${mutation} WHERE run_id = $1`,
        label === 'round' ? [context.lease.runId, operationId, CHILD, HASH]
          : label === 'parent' ? [context.lease.runId, operationId, CHILD]
            : [context.lease.runId, label === 'model kind' ? modelId : operationId], ['P0001', '23503']);
    }));
  }
});

async function rawCandidate(context, client, { modelId, p, descriptors = [descriptor()],
  count = descriptors.length, modelRunId = context.lease.runId, overrides = {} }) {
  const id = randomUUID();
  const fields = { purpose: p.purpose, round: p.repairCycle, head: p.headSha,
    phaseKey: p.key, regression: 7, criterion: HASH, proposal: HASH, ...overrides };
  await client.query(`INSERT INTO agent_worker.operations
    (operation_id, run_id, operation_key, kind, input_hash, expected_head_sha, coordinator_version,
     phase_purpose, phase_key, phase_round, model_operation_id, descriptor_count,
     regression_workflow_id, regression_test_sha256, regression_proposal_sha256, criterion_sha256)
    VALUES ($1,$2,$3,'commit_create',$4,$5,1,$6,$7,$8,$9,$10,$11,$4,$12,$13)`,
  [id, modelRunId, hash(randomUUID()), HASH, fields.head, fields.purpose,
    fields.phaseKey, fields.round, modelId, count, fields.regression, fields.proposal, fields.criterion]);
  for (const [ordinal, d] of descriptors.entries()) {
    await client.query(`INSERT INTO agent_worker.candidate_descriptors
      (run_id, operation_id, ordinal, approved_path_index, change_kind, before_blob_sha,
       after_blob_sha, content_sha256, byte_count, file_mode)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [modelRunId, id, ordinal,
      d.approvedPathIndex, d.operation, d.beforeBlobSha, d.afterBlobSha, d.contentSha256, d.bytes, d.mode]);
  }
  return id;
}

dbTest('journal DB: descriptor bounds, deferred validation and immutable identities', async t => {
  for (const [label, descriptors] of [
    ['one file', [descriptor()]],
    ['ten files', Array.from({ length: 10 }, (_, approvedPathIndex) => descriptor({ approvedPathIndex }))],
    ['64 KiB file and 256 KiB aggregate', Array.from({ length: 4 }, (_, approvedPathIndex) => descriptor({ approvedPathIndex, bytes: 65536 }))],
  ]) {
    await t.test(`${label} commits through the real store`, () => withJournal(async context => {
      const p = await initialize(context);
      const intent = candidate(context, p, await successfulModel(context));
      intent.coordinator.candidateDescriptors = descriptors;
      const result = await context.worker.putIntent(context.lease, intent);
      assert.equal(result.status, 'created');
      const snapshot = await context.worker.getCoordinatorSnapshot(context.lease);
      assert.deepEqual(snapshot.pendingOperation.coordinator.candidateDescriptors, descriptors);
    }));
  }
  for (const [label, options, deferred, codes] of [
    ['no descriptors', { descriptors: [], count: 1 }, true, ['P0001']],
    ['forged descriptor count', { count: 2 }, true, ['P0001']],
    ['256 KiB aggregate plus one', { descriptors: Array.from({ length: 5 }, (_, i) => descriptor({ approvedPathIndex: i, bytes: i === 4 ? 1 : 65536 })) }, true, ['P0001']],
    ['zero declared count', { count: 0 }, false, ['23514']],
    ['eleven files', { count: 10, descriptors: Array.from({ length: 11 }, (_, approvedPathIndex) => descriptor({ approvedPathIndex })) }, false, ['23514']],
    ['64 KiB plus one', { descriptors: [descriptor({ bytes: 65537 })] }, false, ['23514']],
    ['negative bytes', { descriptors: [descriptor({ bytes: -1 })] }, false, ['23514']],
    ['duplicate approved indexes', { descriptors: [descriptor(), descriptor()] }, false, ['23505']],
    ['create with before blob', { descriptors: [descriptor({ beforeBlobSha: HEAD })] }, false, ['23514']],
    ['modify without before blob', { descriptors: [descriptor({ operation: 'modify' })] }, false, ['23514']],
    ['unapproved file mode', { descriptors: [descriptor({ mode: '100755' })] }, false, ['23514']],
    ['regression proposal mismatch', { overrides: { proposal: 'e'.repeat(64) } }, false, ['23514']],
    ['regression criterion null', { overrides: { criterion: null } }, false, ['23514']],
    ['partial regression tuple', { overrides: { regression: null } }, false, ['23514']],
    ['wrong model parent', { overrides: { head: CHILD } }, false, ['23503']],
    ['wrong model phase', { overrides: { phaseKey: 'e'.repeat(64) } }, false, ['23503']],
    ['wrong model purpose', { overrides: { purpose: 'initial_implementation' } }, true, ['P0001']],
    ['wrong model round', { overrides: { purpose: 'repair_tests', round: 1 } }, true, ['P0001']],
  ]) {
    await t.test(`database rejects ${label}${deferred ? ' at COMMIT' : ''}`, () => withJournal(async context => {
      const p = await initialize(context);
      const modelId = await successfulModel(context);
      await rolledBack(context.runtime, async client => {
        const body = () => rawCandidate(context, client, { p, modelId, ...options });
        if (deferred) {
          await body();
          await rejectedQuery(client, 'COMMIT', [], codes);
        } else await assert.rejects(body(), error => codes.includes(error.code));
      });
      const result = await context.runtime.query(`SELECT count(*)::integer AS count FROM agent_worker.operations
        WHERE run_id = $1 AND kind = 'commit_create'`, [context.lease.runId]);
      assert.equal(result.rows[0].count, 0);
    }));
  }
  await t.test('unsuccessful model is rejected by the deferred trigger at COMMIT', () => withJournal(async context => {
    const p = await initialize(context);
    const reservation = await context.worker.reserveModelCall(context.lease, modelRequest(context));
    await rolledBack(context.runtime, async client => {
      await rawCandidate(context, client, { p, modelId: reservation.operationId });
      await rejectedQuery(client, 'COMMIT', [], ['P0001']);
    });
  }));
  await t.test('recorded uncertain model is rejected by the deferred trigger at COMMIT', () => withJournal(async context => {
    const p = await initialize(context);
    const reservation = await context.worker.reserveModelCall(context.lease, modelRequest(context));
    const outcome = await context.worker.recordModelCallOutcome(context.lease,
      { operationId: reservation.operationId, outcome: 'uncertain' });
    assert.equal(outcome.status, 'needs_attention');
    await rolledBack(context.runtime, async client => {
      await rawCandidate(context, client, { p, modelId: reservation.operationId });
      await rejectedQuery(client, 'COMMIT', [], ['P0001']);
    });
  }));
  await t.test('descriptors cannot belong to a model at COMMIT', () => withJournal(async context => {
    await initialize(context);
    const modelId = await successfulModel(context);
    await rolledBack(context.runtime, async client => {
      await client.query(`INSERT INTO agent_worker.candidate_descriptors
        (run_id, operation_id, ordinal, approved_path_index, change_kind, after_blob_sha,
         content_sha256, byte_count, file_mode) VALUES ($1,$2,0,0,'create',$3,$4,1,'100644')`,
      [context.lease.runId, modelId, HEAD, HASH]);
      await rejectedQuery(client, 'COMMIT', [], ['P0001']);
    });
  }));
  for (const kind of ['model_call', 'commit_create']) {
    await t.test(`database unique phase index prevents a second ${kind}`, () => withJournal(async context => {
      const { modelId, operationId } = await prepared(context);
      // Change legacy index keys so only the new phase index can supply this rejection.
      await assert.rejects(context.runtime.query(`INSERT INTO agent_worker.operations
        SELECT (jsonb_populate_record(NULL::agent_worker.operations,
          to_jsonb(o) || jsonb_build_object('operation_id', $2::uuid, 'operation_key', $3::text,
            'owner_generation', o.owner_generation + 1,
            'expected_head_sha', CASE WHEN o.kind = 'commit_create' THEN $4::text ELSE o.expected_head_sha END))).*
        FROM agent_worker.operations o WHERE operation_id = $1`,
      [kind === 'model_call' ? modelId : operationId, randomUUID(), hash(randomUUID()), CHILD]),
      { code: '23505', constraint: kind === 'model_call'
        ? 'one_model_per_coordinator_phase' : 'one_effect_per_coordinator_phase' });
    }));
  }
  await t.test('legacy operations cannot acquire descriptors at COMMIT', () => withJournal(async context => {
    const legacy = await context.worker.putIntent(context.lease, {
      key: hash(randomUUID()), kind: 'commit_create', inputHash: HASH, expectedHeadSha: HEAD,
    });
    assert.equal(legacy.status, 'created');
    await rolledBack(context.runtime, async client => {
      await client.query(`INSERT INTO agent_worker.candidate_descriptors
        (run_id, operation_id, ordinal, approved_path_index, change_kind, after_blob_sha,
         content_sha256, byte_count, file_mode) VALUES ($1,$2,0,0,'create',$3,$4,1,'100644')`,
      [context.lease.runId, legacy.operation.operationId, HEAD, HASH]);
      await rejectedQuery(client, 'COMMIT', [], ['P0001']);
    });
  }));
  await t.test('identity outcome and descriptor triggers also bind the owner', () => withJournal(async context => {
    const { modelId, operationId } = await prepared(context);
    for (const [column, value] of [['operation_key', hash(randomUUID())], ['input_hash', HASH],
      ['expected_head_sha', CHILD], ['phase_key', HASH], ['phase_purpose', 'initial_implementation'],
      ['descriptor_count', 2], ['model_operation_id', randomUUID()], ['criterion_sha256', 'e'.repeat(64)]]) {
      await rejectedQuery(context.owner, `UPDATE agent_worker.operations SET ${column} = $2 WHERE operation_id = $1`, [operationId, value], ['P0001']);
    }
    await rejectedQuery(context.owner, `UPDATE agent_worker.operations SET actual_input_tokens = 7 WHERE operation_id = $1`, [modelId], ['P0001']);
    await rejectedQuery(context.owner, 'UPDATE agent_worker.candidate_descriptors SET byte_count = 1 WHERE operation_id = $1', [operationId], ['P0001']);
    await rejectedQuery(context.owner, 'DELETE FROM agent_worker.candidate_descriptors WHERE operation_id = $1', [operationId], ['P0001']);
  }));
});

dbTest('journal DB: purpose-aware confirmation and database-authored wait persistence', async t => {
  await t.test('regression implementation and draft confirmations choose their durable waits', () => withJournal(async context => {
    const { intent, p } = await prepared(context);
    const before = (await context.owner.query('SELECT clock_timestamp() AS now')).rows[0].now;
    assert.equal(await context.worker.confirmIntent(context.lease, intent, proof(context, intent)), true);
    const first = await context.worker.getCoordinatorSnapshot(context.lease);
    assert.equal(first.run.state, 'waiting_red_ci');
    assert.equal(first.phase.pendingOperationId, null);
    assert.ok(Date.parse(first.phase.waitStartedAt) >= before.getTime());
    assert.equal(first.phase.headSha, HEAD);
    assert.equal(first.run.expectedHeadSha, CHILD);
    assert.equal(await context.worker.confirmIntent(context.lease, intent, proof(context, intent)), true);
    assert.equal((await context.worker.getCoordinatorSnapshot(context.lease)).phase.waitStartedAt, first.phase.waitStartedAt);
    for (let poll = 0; poll < 2; poll += 1) {
      assert.equal(await context.worker.checkpoint(context.lease, { state: 'waiting_red_ci', coordinator: p }), true);
      await context.claim();
      const polled = await context.worker.getCoordinatorSnapshot(context.lease);
      assert.equal(polled.phase.waitStartedAt, first.phase.waitStartedAt);
      assert.equal(polled.phase.startedAt, first.phase.startedAt);
    }
    const implementation = await move(context, 'initial_implementation', 'implementing');
    const next = await context.worker.getCoordinatorSnapshot(context.lease);
    assert.equal(next.phase.waitStartedAt, null);
    assert.notEqual(next.phase.key, p.key);
    assert.notEqual(next.phase.startedAt, first.phase.startedAt);
    assert.equal(next.phase.headSha, CHILD);
    await publish(context, implementation, 'd'.repeat(40));
    assert.equal((await context.row()).state, 'waiting_ci');
    await openDraft(context);
    assert.equal((await context.row()).state, 'waiting_review');
    assert.equal(Number((await context.row()).pull_request_number), 42);
  }));
  await t.test('forged confirmation cannot change regression wait or head', () => withJournal(async context => {
    const { intent } = await prepared(context);
    await assert.rejects(context.worker.confirmIntent(context.lease, intent,
      { ...proof(context, intent), parentSha: CHILD }), SAFE);
    assert.equal(await context.worker.confirmIntent(context.lease, intent,
      { ...proof(context, intent), baseSha: CHILD }), false);
    assert.equal((await context.row()).state, 'generating_tests');
    assert.notEqual((await context.row()).pending_operation_id, null);
  }));
});

dbTest('journal DB: acknowledgment loss reconciles durable boundaries without replay', async t => {
  for (const boundary of ['checkpoint', 'reservation', 'outcome', 'candidate', 'fence', 'confirmation']) {
    for (const afterCommit of [false, true]) {
      await t.test(`${boundary}: acknowledgment lost ${afterCommit ? 'after' : 'before'} COMMIT`, () => withJournal(async context => {
        let p;
        let modelId;
        let intent;
        if (boundary !== 'checkpoint') p = await initialize(context);
        if (['outcome', 'candidate', 'fence', 'confirmation'].includes(boundary)) {
          if (boundary === 'outcome') {
            modelId = (await context.worker.reserveModelCall(context.lease, modelRequest(context))).operationId;
          } else modelId = await successfulModel(context);
        }
        if (['candidate', 'fence', 'confirmation'].includes(boundary)) intent = candidate(context, p, modelId);
        if (['fence', 'confirmation'].includes(boundary)) {
          assert.equal((await context.worker.putIntent(context.lease, intent)).status, 'created');
        }
        const pool = acknowledgmentLoss(context.runtime, { afterCommit });
        const worker = createWorkerStore(pool);
        const request = modelRequest(context);
        const actions = {
          checkpoint: () => worker.checkpoint(context.lease, { state: 'generating_tests', coordinator: phase(context) }),
          reservation: () => worker.reserveModelCall(context.lease, request),
          outcome: () => worker.recordModelCallOutcome(context.lease,
            { operationId: modelId, outcome: 'success', actualInputTokens: 8, actualOutputTokens: 8 }),
          candidate: () => worker.putIntent(context.lease, intent),
          fence: () => worker.fenceIntent(context.lease, intent, 'commit'),
          confirmation: () => worker.confirmIntent(context.lease, intent, proof(context, intent)),
        };
        await assert.rejects(actions[boundary](), SAFE);
        assert.equal(pool.injected, true);
        const row = await context.row();
        if (boundary === 'checkpoint') {
          assert.equal(row.coordinator_version, afterCommit ? 1 : null);
          if (afterCommit) {
            await context.claim();
            assert.equal((await context.worker.getCoordinatorSnapshot(context.lease)).phase.key, phase(context).key);
          }
        } else if (boundary === 'reservation') {
          assert.equal(row.model_call_count, afterCommit ? 1 : 0);
          const snapshot = await context.worker.getCoordinatorSnapshot(context.lease);
          assert.equal(snapshot.modelOperation === null, !afterCommit);
          const persisted = await context.runtime.query(`SELECT count(*)::integer AS count
            FROM agent_worker.events WHERE run_id = $1 AND event_type = 'model_call_reserved'`, [context.lease.runId]);
          assert.equal(persisted.rows[0].count, afterCommit ? 1 : 0);
          const retry = await context.worker.reserveModelCall(context.lease, request);
          assert.equal(retry.canExecute, !afterCommit);
          assert.equal(retry.status, afterCommit ? 'needs_attention' : 'reserved');
          if (afterCommit) assert.equal(retry.blockerCode, 'coordinator_model_uncertain');
        } else if (boundary === 'outcome') {
          const snapshot = await context.worker.getCoordinatorSnapshot(context.lease);
          assert.equal(snapshot.modelOperation.outcome, afterCommit ? 'success' : null);
          const retry = await context.worker.reserveModelCall(context.lease, request);
          assert.equal(retry.canExecute, false);
          assert.equal(retry.blockerCode, afterCommit ? 'coordinator_candidate_lost' : 'coordinator_model_uncertain');
        } else if (boundary === 'candidate') {
          const snapshot = await context.worker.getCoordinatorSnapshot(context.lease);
          assert.equal(snapshot.pendingOperation?.key ?? null, afterCommit ? intent.key : null);
          assert.equal((await context.worker.putIntent(context.lease, intent)).status, afterCommit ? 'existing' : 'created');
          assert.equal((await context.worker.putIntent(context.lease, { ...intent, key: hash(randomUUID()) })).status, 'conflict');
          const count = await context.runtime.query('SELECT count(*)::integer AS count FROM agent_worker.candidate_descriptors WHERE run_id = $1', [context.lease.runId]);
          assert.equal(count.rows[0].count, 1);
        } else if (boundary === 'fence') {
          const retry = await context.worker.fenceIntent(context.lease, intent, 'commit');
          assert.equal(retry.decision, afterCommit ? 'reconcile_only' : 'execute');
          assert.equal((await context.worker.putIntent(context.lease, { ...intent, key: hash(randomUUID()) })).status, 'conflict');
        } else {
          assert.equal(row.state, afterCommit ? 'waiting_red_ci' : 'generating_tests');
          assert.equal(await context.worker.confirmIntent(context.lease, intent, proof(context, intent)), true);
          assert.equal((await context.row()).state, 'waiting_red_ci');
        }
      }));
    }
  }
  for (const afterCommit of [false, true]) {
    await t.test(`repair: acknowledgment lost ${afterCommit ? 'after' : 'before'} COMMIT`, () => withJournal(async context => {
      await initialImplementation(context);
      const request = { key: hash(randomUUID()), source: 'ci', headSha: 'd'.repeat(40), findingSha256: HASH };
      const pool = acknowledgmentLoss(context.runtime, { afterCommit });
      await assert.rejects(createWorkerStore(pool).beginRepair(context.lease, request), SAFE);
      assert.equal(pool.injected, true);
      assert.equal((await context.row()).repair_cycle_count, afterCommit ? 1 : 0);
      if (afterCommit) await context.claim();
      const retry = await context.worker.beginRepair(context.lease, request);
      assert.equal(retry.status, afterCommit ? 'existing' : 'reserved');
      if (!afterCommit) await context.claim();
      assert.equal((await context.worker.beginRepair(context.lease,
        { ...request, key: hash(randomUUID()) })).status, 'conflict');
      assert.equal((await context.row()).repair_cycle_count, 1);
      const events = await context.runtime.query(`SELECT count(*)::integer AS count FROM agent_worker.events
        WHERE run_id = $1 AND event_type = 'repair_reserved'`, [context.lease.runId]);
      assert.equal(events.rows[0].count, 1);
    }));
  }
  await t.test('real recovery persists journal purpose while mocked GitHub loses write acknowledgments', async () => {
    const fixture = createPublisherFixture({ loseBranchAck: true, loseCommitAck: true });
    fixture.context.signingPreflight.expiresAt = fixture.context.contextExpiresAt;
    await withJournal(async context => {
      fixture.request.run.id = context.lease.runId;
      const p = await initialize(context);
      const modelId = await successfulModel(context);
      fixture.request.run.generation = context.lease.generation;
      const inputHash = buildOperationHash(fixture.request, validateChanges(
        validationBaseFromTree(new Map(), [CHANGE_PATH]), fixture.request.proposedChanges,
        { allowedPaths: fixture.request.approvedManifest.allowedPaths,
          pilotScope: fixture.request.approvedManifest.pilotScope }));
      const intent = candidate(context, p, modelId, { key: fixture.request.intent.id, inputHash });
      intent.coordinator.expectedRegression.proposalSha256 = inputHash;
      const originalFetch = fixture.dependencies.fetch;
      const dependencies = { ...fixture.dependencies, async fetch(url, init) {
        const response = await originalFetch(String(url).replaceAll(context.lease.runId, RUN_ID), {
          ...init, ...(init.body ? { body: init.body.replaceAll(context.lease.runId, RUN_ID) } : {}),
        });
        return new Response((await response.text()).replaceAll(RUN_ID, context.lease.runId),
          { status: response.status, headers: response.headers });
      } };
      const result = await createRecoveryCoordinator({ store: context.worker, publicationDependencies: dependencies }).perform({
        lease: context.lease, intent, publication: fixture.request, deadline: Date.now() + 80000,
      });
      assert.equal(result.status, 'confirmed');
      assert.equal(result.commitSha, COMMIT_SHA);
      assert.equal(fixture.state.branchWrites, 1);
      assert.equal(fixture.state.commitWrites, 1);
      assert.equal((await context.row()).state, 'waiting_red_ci');
    }, { manifestOverrides: { manifestHash: fixture.request.run.manifestSha256 },
      jobOverrides: { issueId: fixture.request.run.issueId, issueNumber: fixture.request.run.issueNumber } });
  });
});

dbTest('journal DB: CI and Qodo share two idempotent repair reservations', async t => {
  await t.test('CI duplicate and rekey reserve once and release the lease', () => withJournal(async context => {
    await initialImplementation(context);
    const request = { key: hash(randomUUID()), source: 'ci', headSha: 'd'.repeat(40), findingSha256: HASH };
    const before = context.lease;
    const first = await context.worker.beginRepair(context.lease, request);
    assert.equal(first.status, 'reserved');
    assert.equal(first.repairCycleCount, 1);
    const row = await context.row();
    assert.equal(row.lease_token, null);
    assert.equal(row.wait_started_at, null);
    assert.equal(row.phase_purpose, 'repair_investigation');
    assert.equal((await context.worker.beginRepair(before, request)).status, 'stale');
    await context.claim();
    assert.equal((await context.worker.beginRepair(context.lease, request)).status, 'existing');
    assert.equal((await context.worker.beginRepair(context.lease, { ...request, key: hash(randomUUID()) })).status, 'conflict');
    assert.equal((await context.row()).repair_cycle_count, 1);
  }));
  await t.test('repair test and implementation confirmations preserve purposes and the existing draft', () => withJournal(async context => {
    await initialImplementation(context);
    await openDraft(context);
    for (const [round, source] of [[1, 'qodo'], [2, 'ci']]) {
      if (source === 'ci') {
        // Exercise CI against the last repaired implementation before returning to review.
        const row = await context.row();
        assert.equal(row.state, 'waiting_ci');
      }
      const row = await context.row();
      const request = { key: hash(randomUUID()), source, headSha: row.expected_head_sha,
        findingSha256: hash(`finding-${round}`) };
      const repair = await context.worker.beginRepair(context.lease, request);
      assert.equal(repair.status, 'reserved');
      assert.equal(repair.repairCycleCount, round);
      await context.claim();
      const tests = await move(context, 'repair_tests', 'repairing');
      await publish(context, tests, (round === 1 ? 'e' : '1').repeat(40));
      assert.equal((await context.row()).state, 'waiting_red_ci');
      const implementation = await move(context, 'repair_implementation', 'implementing');
      await publish(context, implementation, (round === 1 ? 'f' : '2').repeat(40));
      assert.equal((await context.row()).state, 'waiting_ci');
    }
    const row = await context.row();
    const reviewPhase = phase(context, 'draft_pr', { headSha: row.expected_head_sha,
      repairCycle: 2, findingSha256: row.finding_sha256 });
    assert.equal(await context.worker.checkpoint(context.lease, { state: 'waiting_review', coordinator: reviewPhase }), true);
    await context.claim();
    assert.equal(Number((await context.row()).pull_request_number), 42);
    const third = await context.worker.beginRepair(context.lease, { key: hash(randomUUID()), source: 'qodo',
      headSha: row.expected_head_sha, findingSha256: hash('third-finding') });
    assert.equal(third.status, 'needs_attention');
    assert.equal(third.blockerCode, 'repair_cycle_limit');
    const stopped = await context.row();
    assert.equal(stopped.repair_cycle_count, 2);
    assert.equal(stopped.state, 'needs_attention');
    assert.equal(stopped.lease_token, null);
    const count = await context.runtime.query(`SELECT count(*)::integer AS count FROM agent_worker.operations
      WHERE run_id = $1 AND kind = 'pr_create'`, [context.lease.runId]);
    assert.equal(count.rows[0].count, 1);
  }));
  await t.test('finding source and current head cannot be forged', () => withJournal(async context => {
    await initialImplementation(context);
    for (const request of [
      { key: hash(randomUUID()), source: 'qodo', headSha: 'd'.repeat(40), findingSha256: HASH },
      { key: hash(randomUUID()), source: 'ci', headSha: HEAD, findingSha256: HASH },
    ]) assert.equal((await context.worker.beginRepair(context.lease, request)).status, 'conflict');
    assert.equal((await context.row()).repair_cycle_count, 0);
  }));
});

dbTest('journal DB: stale owners, expired phases and lost candidate human stops', async t => {
  for (const outcome of ['success', 'unresolved']) {
    await t.test(`${outcome} model without candidate cannot replay or rekey`, () => withJournal(async context => {
      await initialize(context);
      if (outcome === 'success') await successfulModel(context);
      else await context.worker.reserveModelCall(context.lease, modelRequest(context));
      const result = await context.worker.reserveModelCall(context.lease, modelRequest(context));
      assert.equal(result.status, 'needs_attention');
      assert.equal(result.canExecute, false);
      assert.equal(result.blockerCode, outcome === 'success' ? 'coordinator_candidate_lost' : 'coordinator_model_uncertain');
      assert.equal((await context.row()).state, 'needs_attention');
      assert.equal((await context.row()).lease_token, null);
      assert.equal((await context.row()).model_call_count, 1);
    }));
  }
  for (const expiry of ['lease', 'tick', 'run', 'generation']) {
    await t.test(`${expiry} invalidates all journal writes`, () => withJournal(async context => {
      const { p, intent, modelId } = await prepared(context);
      if (expiry === 'generation') {
        await context.owner.query(`UPDATE agent_worker.runs SET lease_expires_at = clock_timestamp() - interval '1 second'
          WHERE run_id = $1`, [context.lease.runId]);
        const stale = context.lease;
        await context.claim();
        context.lease = stale;
      } else {
        const assignment = { lease: "lease_expires_at = clock_timestamp() - interval '1 second'",
          tick: "lease_started_at = clock_timestamp() - interval '100 seconds'",
          run: "created_at = clock_timestamp() - interval '7300 seconds'" }[expiry];
        await context.owner.query(`UPDATE agent_worker.runs SET ${assignment} WHERE run_id = $1`, [context.lease.runId]);
      }
      const before = await context.row();
      assert.equal((await context.worker.getCoordinatorSnapshot(context.lease)).status, 'stale');
      assert.equal(await context.worker.checkpoint(context.lease, { state: 'generating_tests', coordinator: p }), false);
      assert.equal((await context.worker.putIntent(context.lease, intent)).status, 'stale');
      const fenced = await context.worker.fenceIntent(context.lease, intent, 'commit');
      assert.equal(fenced.status, ['tick', 'run'].includes(expiry) ? 'blocked' : 'stale');
      if (fenced.status === 'blocked') assert.equal(fenced.blockerCode, 'recovery_deadline');
      const effect = await context.runtime.query('SELECT commit_attempted FROM agent_worker.operations WHERE run_id = $1 AND kind = $2',
        [context.lease.runId, 'commit_create']);
      assert.equal(effect.rows[0].commit_attempted, false);
      assert.equal((await context.worker.reserveModelCall(context.lease, modelRequest(context))).status, 'stale');
      // An exact immutable outcome replay is a read, even for an expired owner.
      assert.equal((await context.worker.recordModelCallOutcome(context.lease, { operationId: modelId,
        outcome: 'success', actualInputTokens: 8, actualOutputTokens: 8 })).status, 'existing');
      assert.equal((await context.worker.beginRepair(context.lease, { key: HASH, source: 'ci',
        headSha: HEAD, findingSha256: HASH })).status, 'stale');
      assert.equal(await context.worker.confirmIntent(context.lease, intent, proof(context, intent)), false);
      const after = await context.row();
      assert.equal(after.phase_key, before.phase_key);
      assert.equal(after.pending_operation_id, before.pending_operation_id);
      assert.equal(after.model_call_count, before.model_call_count);
      assert.equal(after.state, before.state);
    }));
  }
});
