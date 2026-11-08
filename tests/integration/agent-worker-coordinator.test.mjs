import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { available, ROLE, withCoordinator, expectTick, toRed, toImplementation,
  toGreen, toReview } from '../support/agent-worker-coordinator-database.mjs';
import { hash, HEAD, nativeIdentity } from '../fixtures/worker-coordinator-db/transport.mjs';

const guarded = { skip: !available };
async function awaitEntered(started, pending) {
  await Promise.race([started, pending.then(() => {
    assert.fail('The configured Function returned before the controlled target await.');
  })]);
}
function noForbiddenEffects(context) {
  assert.equal(context.state.mutations.every(kind => ['branch', 'commit', 'draft'].includes(kind)), true);
  assert.equal(context.state.calls.some(call => ['PATCH', 'PUT', 'DELETE'].includes(call.method)), false);
  assert.equal(context.state.calls.filter(call => call.method !== 'GET')
    .every(call => ['/git/refs', '/graphql', '/pulls'].includes(call.path)), true);
  assert.equal(context.state.prs.length <= 1, true);
  assert.equal(context.state.prs.every(pr => pr.draft === true && pr.state === 'open'), true);
}
async function released(context) {
  const row = await context.row();
  assert.equal(row.lease_token === null, true); assert.equal(row.lease_expires_at === null, true);
  return row;
}
function storedEvidence(row) {
  return { headSha: row.last_check_head_sha, workflowId: Number(row.last_workflow_id),
    workflowRunId: Number(row.last_workflow_run_id), checkRunId: Number(row.last_check_run_id),
    checksSha256: row.check_evidence_sha256,
    reviewId: row.review_head_sha === row.last_check_head_sha ? Number(row.prior_review_id) || null : null };
}
function assertEvidence(row, expected) {
  assert.deepEqual(storedEvidence(row), expected);
  assert.equal(Number(row.prior_check_run_id), expected.checkRunId);
  if (expected.reviewId !== null) {
    assert.equal(row.review_head_sha, expected.headSha);
    assert.equal(Number(row.prior_review_id), expected.reviewId);
  }
}
async function assertProjection(h, expected, lease) {
  const row = await h.row();
  const run = await h.actualStore.getRun(row.run_id);
  assert.deepEqual(run.checkEvidence, expected);
  const safeKeys = ['checkEvidence', 'runId', 'jobId', 'repositoryId', 'repositoryFullName',
    'issueId', 'issueNumber', 'actorId', 'manifestHash', 'baseRevision', 'policyRevision',
    'limits', 'state', 'generation', 'recoveryCount', 'modelCallCount', 'reservedInputTokens',
    'reservedOutputTokens', 'repairCycleCount', 'leaseExpiresAt', 'tickDeadlineAt',
    'runDeadlineAt', 'expectedHeadSha', 'branchName', 'pullRequestNumber', 'lastCheckRunId',
    'reviewHeadSha', 'blockerCode', 'createdAt', 'updatedAt', 'terminalAt'];
  assert.deepEqual(Object.keys(run).sort(), safeKeys.sort());
  if (lease) {
    const snapshot = await h.actualStore.getCoordinatorSnapshot(lease);
    assert.equal(snapshot.status, 'owned'); assert.deepEqual(snapshot.run.checkEvidence, expected);
    assert.equal(JSON.stringify(snapshot.run).includes(lease.token), false);
  }
}
const shortWait = { configure: transport => {
  transport.manifest.limits.ciWaitSeconds = 10; transport.manifest.limits.reviewWaitSeconds = 10;
} };
async function withWaitClock(h, callback) {
  const realNow = Date.now; let now = realNow();
  Date.now = () => now;
  try {
    const row = await h.row();
    await callback(() => { now = row.wait_started_at.getTime() + 11000; });
  } finally { Date.now = realNow; }
}
async function noForward(h, before) {
  const after = await h.row();
  assert.equal(after.phase_key, before.phase_key);
  assert.equal(after.repair_cycle_count, before.repair_cycle_count);
  assert.deepEqual(storedEvidence(after), storedEvidence(before));
  assert.equal(after.state === 'ready_for_human', false);
  assert.equal(h.state.modelCalls, before.model_call_count);
  assert.equal(h.control.calls.some(call => call.evidence !== null), false);
  assert.equal(h.control.calls.every(call => call.name === 'claimTick'
    || call.deadline === call.expectedDeadline), true);
}
async function repair(context) {
  const source = (await context.row()).state === 'waiting_review' ? 'qodo' : 'ci';
  const cause = context.expectedEvidence(source === 'qodo' ? context.syntheticFutureReview().reviewId : null);
  await expectTick(context, 'advanced');
  assertEvidence(await context.row(), cause);
  const reservation = context.control.calls.findLast(call => call.name === 'beginRepair');
  assert.deepEqual(reservation.evidence, cause); assert.equal(reservation.change.source, source);
  assert.equal((await context.row()).phase_purpose, 'repair_investigation');
  const models = context.state.modelCalls;
  await expectTick(context, 'advanced'); assert.equal(context.state.modelCalls, models);
  const phase = (await context.row()).phase_key;
  await expectTick(context, 'advanced');
  let row = await context.row(); assert.equal(row.state, 'waiting_red_ci');
  assert.equal(row.phase_key, phase);
  const investigation = context.state.contexts.at(-1).investigation;
  assert.equal(investigation.regressionFileIndex > 0, true);
  assert.notEqual(investigation.regressionFileIndex, context.manifest.coordinator.regression.testPathIndex);
  assert.equal(investigation.references.every(reference => reference.fileIndex > 0), true);
  const operations = await context.operations();
  const model = operations.find(operation => operation.phase_key === phase && operation.kind === 'model_call');
  const candidate = operations.find(operation => operation.phase_key === phase && operation.kind === 'commit_create');
  assert.equal(candidate.model_operation_id, model.operation_id);
  context.state.ci = 'waiting'; context.restart({ futureReview: source === 'qodo' });
  const waitBefore = await context.row();
  assert.equal(typeof waitBefore.prior_check_run_id, 'string');
  if (source === 'qodo') assert.equal(typeof waitBefore.prior_review_id, 'string');
  await expectTick(context, 'waiting');
  const waitAfter = await context.row();
  assert.equal(waitAfter.wait_started_at.getTime(), waitBefore.wait_started_at.getTime());
  assert.equal(waitAfter.prior_check_run_id, waitBefore.prior_check_run_id);
  assert.equal(waitAfter.prior_review_id, waitBefore.prior_review_id);
  context.state.ci = 'red'; const redEvidence = context.expectedEvidence();
  await expectTick(context, 'advanced');
  row = await context.row(); assertEvidence(row, redEvidence);
  await assertProjection(context, redEvidence);
  assert.equal(row.phase_purpose, 'repair_implementation');
  assert.equal(row.phase_head_sha, row.expected_head_sha);
  await expectTick(context, 'advanced'); assert.equal((await context.row()).state, 'waiting_ci');
  context.state.ci = 'green'; const greenEvidence = context.expectedEvidence();
  await expectTick(context, 'advanced');
  row = await released(context); assertEvidence(row, greenEvidence);
  await assertProjection(context, greenEvidence);
  if (row.state === 'opening_pr') { await expectTick(context, 'advanced'); row = await released(context); }
  assert.equal(row.state, 'waiting_review');
  noForbiddenEffects(context);
}

test('coordinator DB: authenticated restricted role and configured Function ingress guards', guarded, async t => {
  await t.test('real password login has separate session identity and least-privilege grants', () => withCoordinator(async h => {
    assert.equal(await h.rejectsWrongPassword(), true);
    const { rows: [identity] } = await h.runtime.query(`SELECT current_user=$1 AS current_role,
      session_user=$1 AS session_role, rolsuper,rolcreatedb,rolcreaterole,rolbypassrls
      FROM pg_roles WHERE rolname=current_user`, [ROLE]);
    assert.deepEqual(identity, { current_role: true, session_role: true, rolsuper: false,
      rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
    const { rows: [grants] } = await h.runtime.query(`SELECT
      has_table_privilege(current_user,'agent_intake.jobs','SELECT') AS jobs_read,
      has_table_privilege(current_user,'agent_intake.jobs','INSERT,UPDATE,DELETE') AS jobs_write,
      has_table_privilege(current_user,'agent_worker.runs','SELECT,INSERT,UPDATE') AS runs_write,
      has_table_privilege(current_user,'agent_worker.operations','SELECT,INSERT,UPDATE') AS ops_write,
      has_table_privilege(current_user,'agent_worker.events','SELECT,INSERT') AS events_append,
      has_table_privilege(current_user,'agent_worker.events','UPDATE,DELETE') AS events_mutate,
      has_table_privilege(current_user,'agent_worker.candidate_descriptors','SELECT,INSERT') AS descriptor_append,
      has_table_privilege(current_user,'agent_worker.candidate_descriptors','UPDATE,DELETE') AS descriptor_mutate,
      has_schema_privilege(current_user,'agent_worker','CREATE') AS schema_create,
      has_database_privilege(current_user,current_database(),'CREATE') AS database_create,
      EXISTS (SELECT 1 FROM pg_tables WHERE schemaname IN ('agent_intake','agent_worker')
        AND tableowner=current_user) AS owns_tables,
      EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS role_membership`);
    assert.deepEqual(grants, { jobs_read: true, jobs_write: false, runs_write: true, ops_write: true,
      events_append: true, events_mutate: false, descriptor_append: true, descriptor_mutate: false,
      schema_create: false, database_create: false, owns_tables: false, role_membership: false });
    for (const sql of [
      'UPDATE agent_intake.jobs SET actor_id=actor_id WHERE job_id=$1',
      'DELETE FROM agent_intake.jobs WHERE job_id=$1',
      'UPDATE agent_worker.candidate_descriptors SET byte_count=byte_count WHERE operation_id=$1',
      'DELETE FROM agent_worker.events WHERE run_id=$1',
    ]) await assert.rejects(h.runtime.query(sql, [h.job.jobId]), error => error.code === '42501');
    await assert.rejects(h.runtime.query('CREATE TABLE agent_worker.forbidden_fixture(id int)'), error => error.code === '42501');
    await expectTick(h, 'advanced'); assert.equal((await released(h)).state, 'generating_tests');
  }));
  await t.test('actual catalog exposes exactly four nullable typed evidence columns without extra tables', () => withCoordinator(async h => {
    const { rows } = await h.runtime.query(`SELECT column_name,data_type,is_nullable
      FROM information_schema.columns WHERE table_schema='agent_worker' AND table_name='runs'
      AND column_name=ANY($1::text[]) ORDER BY column_name`,
    [['last_check_head_sha', 'last_workflow_id', 'last_workflow_run_id', 'check_evidence_sha256']]);
    assert.deepEqual(rows, [
      { column_name: 'check_evidence_sha256', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'last_check_head_sha', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'last_workflow_id', data_type: 'bigint', is_nullable: 'YES' },
      { column_name: 'last_workflow_run_id', data_type: 'bigint', is_nullable: 'YES' },
    ]);
    const { rows: tables } = await h.runtime.query(`SELECT tablename FROM pg_tables
      WHERE schemaname='agent_worker' ORDER BY tablename`);
    assert.deepEqual(tables.map(row => row.tablename), ['candidate_descriptors', 'events', 'operations', 'runs']);
  }));
  for (const entry of [
    { name: 'wrong path', request: { path: '/other' }, code: 404, status: 'not_found' },
    { name: 'wrong method', request: { method: 'GET' }, code: 405, status: 'method_not_allowed' },
    { name: 'synthetic provenance denies', configure: h => { h.native = false; }, code: 401, status: 'unauthorized' },
    { name: 'SDK parser rejects inconsistent invocation header', request: { headers: { 'x-neon-trigger-invocation-id': 'wrong' } }, code: 401, status: 'unauthorized' },
    { name: 'SDK parser rejects invalid body', request: { body: '{}' }, code: 401, status: 'unauthorized' },
    { name: 'kill switch', configure: h => { h.environment.AGENT_WORKER_ENABLED = 'false'; }, code: 200, status: 'disabled' },
    { name: 'branch gate', configure: h => { h.environment.NEON_BRANCH = 'preview'; }, code: 200, status: 'disabled' },
    { name: 'strict TLS configuration validation', configure: h => { h.environment.AGENT_WORKER_DATABASE_URL = 'postgresql://coordinator_test_runtime:synthetic@db.invalid/worker?sslmode=require'; }, code: 503, status: 'unavailable' },
    { name: 'synthetic activation denies', configure: h => { h.activation = false; }, code: 503, status: 'unavailable' },
  ]) await t.test(entry.name, () => withCoordinator(async h => {
    entry.configure?.(h); assert.deepEqual(await h.tick(entry.request), { code: entry.code, status: entry.status });
    assert.equal(h.control.calls.length, 0); assert.equal(await h.row(), undefined);
    assert.equal(h.state.calls.length, 0); assert.equal(h.state.modelCalls, 0);
  }));
});

test('coordinator DB: initial regression lifecycle, durable claims and no-model waits', guarded, async t => {
  await t.test('Function fetch drives actual approval policy repository Agent candidate recovery publisher and SQL journal', () => withCoordinator(async h => {
    await expectTick(h, 'advanced');
    let row = await released(h); assert.equal(row.phase_purpose, 'initial_tests');
    assert.equal(h.state.modelCalls, 0);
    await expectTick(h, 'advanced');
    row = await released(h); assert.equal(row.state, 'waiting_red_ci');
    const parent = row.phase_head_sha; const child = row.expected_head_sha;
    assert.equal(parent, HEAD); assert.equal(child !== parent, true);
    assert.equal(row.criterion_sha256, hash(h.manifest.acceptanceCriteria[0]));
    assert.equal(row.regression_test_sha256, nativeIdentity('approved regression location'));
    const wait = row.wait_started_at.toISOString(); const phaseKey = row.phase_key;
    const models = h.state.modelCalls;
    for (let i = 0; i < 3; i += 1) {
      h.restart(); await expectTick(h, 'waiting'); row = await released(h);
      assert.equal(row.phase_key, phaseKey); assert.equal(row.phase_head_sha, parent);
      assert.equal(row.expected_head_sha, child); assert.equal(row.wait_started_at.toISOString(), wait);
    }
    assert.equal(h.state.modelCalls, models); assert.deepEqual(h.state.mutations, ['branch', 'commit']);
    h.state.ci = 'red'; await expectTick(h, 'advanced');
    row = await released(h); assert.equal(row.phase_purpose, 'initial_implementation'); assert.equal(row.phase_head_sha, child);
    await expectTick(h, 'advanced'); row = await released(h); assert.equal(row.state, 'waiting_ci');
    assert.equal(row.phase_head_sha, child); assert.equal(row.expected_head_sha !== child, true);
    h.state.ci = 'green'; await expectTick(h, 'advanced');
    assert.equal((await released(h)).state, 'opening_pr'); await expectTick(h, 'advanced');
    row = await released(h); assert.equal(row.state, 'waiting_review'); assert.equal(Number(row.pull_request_number), 31);
    assert.equal(h.state.prs.length, 1); assert.equal(h.state.modelCalls, 2);
    const operations = await h.operations();
    const modelRows = operations.filter(operation => operation.kind === 'model_call');
    assert.equal(modelRows.length, 2);
    assert.equal(modelRows.every(operation => operation.outcome_code === 'success'
      && operation.actual_input_tokens === 100 && operation.actual_output_tokens === 20), true);
    assert.equal(row.model_call_count, 2); assert.equal(row.reserved_input_tokens > 0, true);
    assert.equal(row.reserved_output_tokens > 0, true);
    assert.equal(operations.filter(operation => operation.kind === 'commit_create').length, 2);
    assert.equal(operations.filter(operation => operation.kind === 'pr_create').length, 1);
    for (const call of h.control.calls.filter(call => call.name !== 'claimTick')) {
      assert.equal(Number.isFinite(call.deadline), true); assert.equal(call.deadline, call.expectedDeadline);
    }
    for (const source of h.manifest.requiredWorkflowIdentities[0].diagnostics.sources) {
      assert.equal(h.state.calls.some(call => call.path === `/contents/${source.path}`), true);
    }
    for (const context of h.state.contexts) {
      assert.equal(context.files.some(file => file.path === 'src'), true);
      assert.equal(context.files.some(file => file.path === 'tests'), true);
      assert.equal(context.files.filter(file => file.mode === '100644')
        .every(file => file.sha256 === hash(file.text) && /^[a-f0-9]{40}$/.test(file.blobSha)), true);
    }
    const { rows: events } = await h.runtime.query('SELECT * FROM agent_worker.events WHERE run_id=$1', [row.run_id]);
    const serialized = JSON.stringify({ operations, events, row });
    for (const secret of ['approved body', 'synthetic-model-private', 'synthetic-app-private', 'export const fixed']) {
      assert.equal(serialized.includes(secret), false);
    }
    noForbiddenEffects(h);
  }));
  await t.test('atomic RED and green evidence follows controlled packets and survives bigint polls and restart', () => withCoordinator(async h => {
    await toRed(h); h.state.ci = 'red'; const red = h.expectedEvidence();
    h.control.writes.length = 0; h.control.calls.length = 0;
    await expectTick(h, 'advanced'); assertEvidence(await released(h), red);
    assert.equal(h.control.writes.filter(write => write.method === 'checkpoint' && write.evidence && write.clearsLease).length, 1);
    const change = h.control.calls.find(call => call.name === 'checkpoint').change;
    assert.deepEqual(change.evidence, red); assert.equal(change.lastCheckRunId, red.checkRunId);
    assert.equal(change.coordinator.priorCheckRunId, red.checkRunId);
    await assertProjection(h, red);
    await expectTick(h, 'advanced'); h.state.ci = 'waiting'; h.restart();
    const before = await h.row(); assert.equal(typeof before.prior_check_run_id, 'string');
    await expectTick(h, 'waiting'); assert.equal((await h.row()).wait_started_at.getTime(), before.wait_started_at.getTime());
    h.state.ci = 'green'; const green = h.expectedEvidence();
    await expectTick(h, 'advanced'); assertEvidence(await released(h), green);
    await assertProjection(h, green); await expectTick(h, 'advanced');
    const claim = await h.claim(); assert.equal(claim.status, 'claimed');
    await assertProjection(h, green, claim.lease);
  }));
  await t.test('same invocation remains duplicate across new Function/coordinator objects', () => withCoordinator(async h => {
    const id = randomUUID(); assert.deepEqual(await h.tick({ id }), { code: 200, status: 'advanced' });
    h.restart(); assert.deepEqual(await h.tick({ id }), { code: 200, status: 'duplicate' });
    assert.equal(h.state.modelCalls, 0); assert.equal((await h.row()).model_call_count, 0);
  }));
  await t.test('overlapping real SQL lease excludes concurrent invocation and second pilot', () => withCoordinator(async h => {
    let entered; const enteredPromise = new Promise(resolve => { entered = resolve; });
    let release; const blocked = new Promise(resolve => { release = resolve; });
    let first = true;
    h.state.beforeHTTP = async () => { if (first) { first = false; entered(); await blocked; } };
    const pending = h.tick(); await awaitEntered(enteredPromise, pending);
    try {
      const competing = await h.tick(); assert.deepEqual(competing, { code: 200, status: 'duplicate' });
      const manifest = { repositoryId: 123456, repositoryFullName: 'randoneering/mellon', issueId: h.job.issueId + 100000,
        issueNumber: h.job.issueNumber + 100000, actorId: 42, manifestHash: hash('second pilot'), baseRevision: HEAD,
        policyRevision: h.manifest.policyRevision, limits: h.manifest.limits };
      const secondJob = randomUUID();
      await h.owner.query(`INSERT INTO agent_intake.jobs (job_id,repository_id,repository_full_name,issue_id,issue_number,actor_id,initial_delivery_id)
        VALUES ($1,123456,'randoneering/mellon',$2,$3,42,$4)`, [secondJob, manifest.issueId, manifest.issueNumber, randomUUID()]);
      assert.notEqual((await h.actualStore.claimTick({ invocationId: randomUUID(), manifest })).status, 'claimed');
    } finally { release(); }
    assert.deepEqual(await pending, { code: 200, status: 'advanced' }); assert.equal(h.state.modelCalls, 0);
    assert.equal((await h.runtime.query('SELECT count(*)::int AS count FROM agent_worker.runs WHERE terminal_at IS NULL')).rows[0].count, 1);
  }));
  for (const budget of ['calls', 'input', 'output']) {
    await t.test(`durable ${budget} budget blocks a second model reservation before SDK execution`, () => withCoordinator(async h => {
      await toImplementation(h); await expectTick(h, 'needs_attention');
      const row = await released(h);
      assert.equal(row.blocker_code, budget === 'calls' ? 'model_call_budget_exhausted' : 'model_token_budget_exhausted');
      assert.equal(h.state.modelCalls, 1); assert.equal(row.model_call_count, 1);
      assert.deepEqual(h.state.mutations, ['branch', 'commit']);
      assert.equal((await h.operations()).filter(operation => operation.kind === 'model_call').length, 1);
      noForbiddenEffects(h);
    }, { configure: transport => {
      if (budget === 'calls') transport.manifest.limits.modelCallsPerRun = 1;
      if (budget === 'input') {
        transport.manifest.limits.inputTokensPerCall = 500;
        transport.manifest.limits.inputTokensPerRun = 500;
      }
      if (budget === 'output') transport.manifest.limits.outputTokensPerRun = 2000;
    } }));
  }
  await t.test('SQL-authored CI deadline survives polling and expires without another model', () => withCoordinator(async h => {
    await toRed(h); const before = await h.row(); await expectTick(h, 'waiting');
    assert.equal((await h.row()).wait_started_at.toISOString(), before.wait_started_at.toISOString());
    await h.owner.query(`UPDATE agent_worker.runs SET wait_started_at=clock_timestamp()-interval '1801 seconds'
      WHERE job_id=$1`, [h.job.jobId]);
    await expectTick(h, 'needs_attention'); const row = await released(h);
    assert.equal(row.blocker_code, 'coordinator_wait_expired'); assert.equal(h.state.modelCalls, 1);
  }));
});

test('coordinator DB: authenticated CI gates and actual unsupported review never authorize readiness', guarded, async t => {
  for (const tamper of ['wrong assertion', 'formatter', 'policy', 'skip list', 'run head', 'incomplete',
    'App', 'event', 'job', ...['automation/ci/guard-command.mjs', 'automation/ci/run-tests.mjs',
      'automation/ci/test-reporter.mjs', 'automation/ci/report-annotations.mjs',
      'scripts/lib/output-guard.mjs', 'package.json'].map(path => `producer ${path}`)]) {
    await t.test(`raw synthetic V2 rejects ${tamper}`, () => withCoordinator(async h => {
      await toRed(h); h.state.ci = 'red';
      if (tamper === 'wrong assertion') h.state.findingIdentity = 'f'.repeat(64);
      else if (tamper.startsWith('producer ')) h.state.producerTamper = tamper.slice('producer '.length);
      else if (['App', 'event', 'job'].includes(tamper)) h.state.transformHTTP = async (path, response) => {
        const value = await response.json();
        if (tamper === 'App' && path === '/check-suites/88/check-runs') value.check_runs[0].app.id = 999;
        if (tamper === 'event' && path === '/actions/workflows/3000/runs') value.workflow_runs[0].event = 'pull_request';
        if (tamper === 'job' && path === '/actions/runs/77/attempts/1/jobs') value.jobs[0].run_id = 999;
        return Response.json(value, { status: response.status });
      };
      else h.state.reportTamper = report => {
        if (tamper === 'formatter') report.formatterRevision = 'f'.repeat(40);
        if (tamper === 'policy') report.skipPolicySha256 = 'f'.repeat(64);
        if (tamper === 'skip list') report.skippedTestIdentitySha256s.pop();
        if (tamper === 'run head') report.context.headSha = HEAD;
        if (tamper === 'incomplete') report.complete = false;
      };
      await expectTick(h, 'needs_attention'); assert.equal(h.state.modelCalls, 1);
      assert.equal(h.state.mutations.filter(kind => kind === 'commit').length, 1);
      assert.equal((await h.row()).state, 'needs_attention'); noForbiddenEffects(h);
    }));
  }
  for (const boundary of ['red reader', 'green reader', 'actual review reader', 'future review reader',
    'CI finding reader', 'Qodo finding checks', 'ready final authority', 'CI final authority', 'Qodo final authority']) {
    await t.test(`controlled local wait expires after awaited ${boundary}, before any forward write`, () => withCoordinator(async h => {
      if (boundary === 'red reader') { await toRed(h); h.state.ci = 'red'; }
      else if (boundary.startsWith('green') || boundary.startsWith('CI')) {
        await toGreen(h); if (boundary.startsWith('CI')) h.state.ci = 'failure';
      } else { await toReview(h); h.state.review = boundary.includes('finding') || boundary.startsWith('Qodo') ? 'finding' : 'complete'; }
      const before = await h.row(); h.control.calls.length = 0;
      let entered = false;
      await withWaitClock(h, async expire => {
        const expireOnce = () => { entered = true; expire(); };
        if (boundary.includes('final authority')) {
          let authorities = 0;
          h.observeApproval(async () => { if (++authorities === 2) expireOnce(); });
        } else if (boundary === 'actual review reader') h.observeReview(async () => { expireOnce(); });
        else if (boundary === 'future review reader') h.afterFutureReview = async () => { expireOnce(); };
        else h.observeChecks(async (name, value) => {
          if (boundary === 'CI finding reader' ? name === 'readFailure' && value.status === 'failure'
            : name === 'readChecks' && ['success', 'intended_red'].includes(value.status)) expireOnce();
        });
        h.restart({ futureReview: !['red reader', 'green reader', 'actual review reader', 'CI finding reader', 'CI final authority'].includes(boundary) });
        await expectTick(h, 'needs_attention'); assert.equal(entered, true);
        assert.equal(h.results.at(-1).reason, 'coordinator_wait_expired');
        assert.equal(Date.now() < h.control.lastClaim.deadline, true);
      });
      await noForward(h, before);
      assert.equal((await h.row()).blocker_code, 'coordinator_wait_expired');
      noForbiddenEffects(h);
    }, shortWait));
  }
  for (const decision of ['phase', 'repair', 'ready']) {
    await t.test(`actual PostgreSQL wait expiry rejects ${decision} write after reader with cached application clock`, () => withCoordinator(async h => {
      if (decision === 'phase') { await toRed(h); h.state.ci = 'red'; }
      else if (decision === 'repair') { await toGreen(h); h.state.ci = 'failure'; }
      else { await toReview(h); h.state.review = 'complete'; }
      const before = await h.row(); let read = false; let expired = false;
      h.observeChecks(async (name, value) => { if (['success', 'intended_red', 'failure'].includes(value.status)) read = true; });
      h.control.beforeStore = async (name, args) => {
        if (name !== ({ phase: 'checkpoint', repair: 'beginRepair', ready: 'finishRun' })[decision]
          || !(name === 'finishRun' ? args[2]?.evidence : args[1]?.evidence)) return;
        assert.equal(read, true); expired = true;
        await h.owner.query(`UPDATE agent_worker.runs SET wait_started_at=clock_timestamp()-interval '11 seconds'
          WHERE job_id=$1 AND terminal_at IS NULL`, [h.job.jobId]);
      };
      await withWaitClock(h, async () => {
        h.restart({ futureReview: decision === 'ready' });
        await expectTick(h, 'needs_attention');
      });
      assert.equal(expired, true);
      const after = await h.row(); assert.equal(after.state, before.state);
      assert.equal(after.phase_key, before.phase_key); assert.equal(after.repair_cycle_count, before.repair_cycle_count);
      assert.deepEqual(storedEvidence(after), storedEvidence(before));
      assert.equal(after.terminal_at, null); assert.equal(after.lease_token !== null, true);
      assert.equal((await h.terminalEvents()).length, 0);
      const { rows: [clock] } = await h.runtime.query(`SELECT
        wait_started_at+interval '10 seconds' < clock_timestamp() AS wait_expired,
        lease_started_at+interval '90 seconds' > clock_timestamp() AS tick_live
        FROM agent_worker.runs WHERE job_id=$1`, [h.job.jobId]);
      assert.deepEqual(clock, { wait_expired: true, tick_live: true });
      assert.equal(h.state.modelCalls, before.model_call_count); noForbiddenEffects(h);
    }, shortWait));
  }
  for (const denial of ['no evidence', 'head mismatch', 'stale owner', 'partial API', 'CI-only API',
    'partial SQL', 'missing review SQL', 'wrong head SQL', 'invalid ID SQL', 'invalid digest SQL']) {
    await t.test(`readiness denial ${denial} retains prior references, lease and no terminal event`, () => withCoordinator(async h => {
      await toReview(h); const claim = await h.claim(); assert.equal(claim.status, 'claimed');
      let before = await h.row(); const evidence = h.expectedEvidence(h.syntheticFutureReview().reviewId);
      if (denial === 'stale owner') {
        await h.expireLease(); const successor = await h.claim(); assert.equal(successor.status, 'claimed');
        assert.equal(successor.lease.generation > claim.lease.generation, true); before = await h.row();
      }
      if (denial.endsWith('SQL')) {
        const assignment = {
          'partial SQL': 'check_evidence_sha256=NULL',
          'missing review SQL': "state='ready_for_human',terminal_at=clock_timestamp(),lease_token=NULL,lease_started_at=NULL,lease_expires_at=NULL",
          'wrong head SQL': "state='ready_for_human',terminal_at=clock_timestamp(),lease_token=NULL,lease_started_at=NULL,lease_expires_at=NULL,review_head_sha=repeat('f',40),prior_review_id=900",
          'invalid ID SQL': 'last_workflow_run_id=0',
          'invalid digest SQL': "check_evidence_sha256=repeat('F',64)",
        }[denial];
        await assert.rejects(h.runtime.query(`UPDATE agent_worker.runs SET ${assignment} WHERE job_id=$1`, [h.job.jobId]),
          error => error.code === '23514');
      } else if (denial === 'partial API' || denial === 'CI-only API') {
        const invalid = denial === 'partial API' ? { headSha: evidence.headSha } : { ...evidence, reviewId: null };
        await assert.rejects(h.actualStore.finishRun(claim.lease, 'ready_for_human', { evidence: invalid }));
      } else {
        const lease = claim.lease;
        const options = denial === 'no evidence' ? {} : { evidence: {
          ...evidence, ...(denial === 'head mismatch' ? { headSha: 'f'.repeat(40) } : {}) } };
        assert.equal(await h.actualStore.finishRun(lease, 'ready_for_human', options), false);
      }
      const after = await h.row(); assert.equal(after.state, 'waiting_review');
      assert.deepEqual(storedEvidence(after), storedEvidence(before));
      assert.equal(after.prior_review_id, before.prior_review_id); assert.equal(after.review_head_sha, before.review_head_sha);
      assert.equal(after.lease_token === before.lease_token, true); assert.equal(after.terminal_at, null);
      assert.equal((await h.terminalEvents()).length, 0);
      assert.equal(after.lease_expires_at.getTime(), before.lease_expires_at.getTime());
    }));
  }
  await t.test('actual store rejects nonclosed evidence, unsafe IDs and uppercase hashes without any SQL write', () => withCoordinator(async h => {
    await toReview(h); const claim = await h.claim(); assert.equal(claim.status, 'claimed');
    const expected = h.expectedEvidence(h.syntheticFutureReview().reviewId); const before = await h.row();
    h.control.writes.length = 0;
    for (const invalid of [
      { ...expected, workflowId: 0 }, { ...expected, workflowRunId: -77 },
      { ...expected, checkRunId: '101' }, { ...expected, reviewId: Number.MAX_SAFE_INTEGER + 1 },
      { ...expected, checksSha256: 'F'.repeat(64) }, { ...expected, headSha: 'F'.repeat(40) },
      { ...expected, body: 'synthetic private field forbidden' },
    ]) await assert.rejects(h.actualStore.finishRun(claim.lease, 'ready_for_human', { evidence: invalid }));
    assert.equal(h.control.writes.length, 0);
    const after = await h.row(); assert.deepEqual(storedEvidence(after), storedEvidence(before));
    assert.equal(after.lease_token === before.lease_token, true); assert.equal(after.terminal_at, null);
    assert.equal((await h.terminalEvents()).length, 0);
  }));
  await t.test('real current draft review reader waits across restarts with persistent deadline and no completion inference', () => withCoordinator(async h => {
    await toReview(h); const before = await h.row(); const models = h.state.modelCalls;
    for (let i = 0; i < 2; i += 1) { h.restart(); await expectTick(h, 'waiting'); }
    const after = await released(h); assert.equal(after.state, 'waiting_review');
    assert.equal(after.wait_started_at.toISOString(), before.wait_started_at.toISOString());
    assert.equal(h.state.modelCalls, models); assert.equal(h.state.prs.length, 1);
    await h.owner.query(`UPDATE agent_worker.runs SET wait_started_at=clock_timestamp()-interval '1801 seconds'
      WHERE job_id=$1`, [h.job.jobId]);
    await expectTick(h, 'needs_attention'); assert.equal((await h.row()).blocker_code, 'coordinator_wait_expired');
    noForbiddenEffects(h);
  }));
  await t.test('real reader rejects unsupported authenticated current-head bot completion prose', () => withCoordinator(async h => {
    await toReview(h); h.state.reviewResponseDraft = false;
    h.state.reviewObjects = [{ id: 901, user: { id: 4000, type: 'Bot', login: 'qodo[bot]' },
      commit_id: h.state.head, state: 'APPROVED', body: 'synthetic unsupported completion prose' }];
    await expectTick(h, 'needs_attention'); assert.equal((await h.row()).state, 'needs_attention');
    assert.equal(h.state.modelCalls, 2); assert.equal(h.state.prs[0].draft, true); noForbiddenEffects(h);
  }));
  await t.test('explicit SYNTHETIC future Qodo completion finishes only metadata and leaves one draft', () => withCoordinator(async h => {
    await toReview(h); h.restart({ futureReview: true }); h.state.review = 'complete';
    const expected = h.expectedEvidence(h.syntheticFutureReview().reviewId);
    h.control.calls.length = 0; h.control.writes.length = 0;
    const before = await h.row();
    let observed = false;
    h.control.beforeCommit = async method => {
      if (method !== 'finishRun') return;
      observed = true; const invisible = await h.row();
      assert.equal(invisible.state, 'waiting_review'); assert.equal(invisible.terminal_at, null);
      assert.deepEqual(storedEvidence(invisible), storedEvidence(before));
      assert.equal((await h.terminalEvents()).length, 0);
    };
    await expectTick(h, 'ready_for_human'); h.control.beforeCommit = null;
    const row = await released(h); assert.equal(observed, true); assertEvidence(row, expected);
    assert.equal(row.state, 'ready_for_human'); const models = h.state.modelCalls;
    assert.equal(h.control.calls.filter(call => call.name === 'checkpoint').length, 0);
    assert.equal(h.control.calls.filter(call => call.name === 'finishRun').length, 1);
    assert.deepEqual(h.control.calls.find(call => call.name === 'finishRun').evidence, expected);
    assert.equal(h.control.writes.filter(write => write.method === 'finishRun' && write.evidence && write.terminal && write.clearsLease).length, 1);
    assert.equal((await h.terminalEvents()).length, 1);
    await assertProjection(h, expected); h.restart({ futureReview: true });
    await expectTick(h, 'idle'); assert.equal(h.state.modelCalls, models);
    assert.equal(h.state.prs.length, 1); noForbiddenEffects(h);
  }));
});

test('coordinator DB: shared CI and synthetic future Qodo repairs retain phase and single draft identity', guarded, async t => {
  await t.test('CI then synthetic Qodo consumes exactly two durable repairs; third stops without model or write', () => withCoordinator(async h => {
    await toGreen(h); h.state.ci = 'failure'; await repair(h);
    assert.equal(h.state.prs.length, 1); assert.equal((await h.row()).repair_cycle_count, 1);
    const draft = (await h.operations()).find(operation => operation.kind === 'pr_create');
    h.restart({ futureReview: true }); h.state.review = 'finding'; await repair(h);
    assert.equal((await h.row()).repair_cycle_count, 2);
    assert.equal(h.state.modelCalls, 6);
    assert.equal(h.state.mutations.filter(kind => kind === 'commit').length, 6);
    assert.equal(h.state.prs.length, 1);
    assert.equal((await h.operations()).filter(operation => operation.kind === 'pr_create').length, 1);
    assert.equal((await h.operations()).find(operation => operation.kind === 'pr_create').operation_id, draft.operation_id);
    const models = h.state.modelCalls; const writes = h.state.mutations.length;
    const limitEvidence = h.expectedEvidence(h.syntheticFutureReview().reviewId);
    await expectTick(h, 'needs_attention'); const stopped = await released(h);
    assertEvidence(stopped, limitEvidence);
    assert.deepEqual(h.control.calls.findLast(call => call.name === 'beginRepair').evidence, limitEvidence);
    assert.equal(stopped.repair_cycle_count, 2);
    await assertProjection(h, limitEvidence);
    assert.equal(stopped.blocker_code, 'repair_cycle_limit'); assert.equal(h.state.modelCalls, models);
    assert.equal(h.state.mutations.length, writes); await expectTick(h, 'idle'); noForbiddenEffects(h);
  }));
  await t.test('CI-only third repair limit atomically persists its latest causal evidence without a third reservation', () => withCoordinator(async h => {
    await toGreen(h);
    for (let cycle = 1; cycle <= 2; cycle += 1) {
      h.state.ci = 'failure'; const expected = h.expectedEvidence();
      await expectTick(h, 'advanced'); let row = await released(h);
      assertEvidence(row, expected); assert.equal(row.repair_cycle_count, cycle);
      assert.equal(row.finding_source, 'ci'); assert.equal(row.finding_head_sha, expected.headSha);
      await expectTick(h, 'advanced'); await expectTick(h, 'advanced');
      assert.equal((await h.row()).state, 'waiting_red_ci'); h.state.ci = 'red';
      await expectTick(h, 'advanced'); assertEvidence(await h.row(), h.expectedEvidence());
      await expectTick(h, 'advanced'); assert.equal((await h.row()).state, 'waiting_ci');
    }
    h.state.ci = 'failure'; const expected = h.expectedEvidence();
    const before = await h.row(); const writes = h.state.mutations.length;
    h.control.writes.length = 0;
    let outside;
    h.control.beforeCommit = async method => { if (method === 'beginRepair') outside = await h.row(); };
    await expectTick(h, 'needs_attention'); h.control.beforeCommit = null;
    assert.equal(outside.state, 'waiting_ci'); assert.deepEqual(storedEvidence(outside), storedEvidence(before));
    const after = await released(h); assertEvidence(after, expected);
    assert.equal(after.blocker_code, 'repair_cycle_limit'); assert.equal(after.repair_cycle_count, 2);
    assert.equal(h.control.writes.filter(write => write.method === 'beginRepair' && write.evidence && write.terminal && write.clearsLease).length, 1);
    const { rows: repairs } = await h.runtime.query(`SELECT repair_source FROM agent_worker.events
      WHERE run_id=$1 AND event_type='repair_reserved'`, [after.run_id]);
    assert.equal(repairs.length, 2); assert.equal(repairs.every(row => row.repair_source === 'ci'), true);
    assert.equal(h.state.modelCalls, before.model_call_count); assert.equal(h.state.mutations.length, writes);
    await expectTick(h, 'idle'); noForbiddenEffects(h);
  }));
  for (const disposition of ['suspected_false_positive', 'scope_change', 'insufficient_evidence']) {
    await t.test(`structured ${disposition} assessment stops for humans without a candidate`, () => withCoordinator(async h => {
      await toReview(h); h.restart({ futureReview: true }); h.state.review = 'finding';
      await expectTick(h, 'advanced'); await expectTick(h, 'advanced');
      h.state.disposition = disposition;
      const writes = h.state.mutations.length;
      await expectTick(h, 'needs_attention'); const row = await released(h);
      assert.equal(row.blocker_code, 'coordinator_investigation_human_stop');
      assert.equal(h.state.modelCalls, 3); assert.equal(h.state.mutations.length, writes);
      assert.equal((await h.operations()).filter(operation => operation.kind === 'commit_create').length, 2);
      await expectTick(h, 'idle'); noForbiddenEffects(h);
    }));
  }
  await t.test('unassociated native assertion rejects repair before investigation or model reservation', () => withCoordinator(async h => {
    await toGreen(h); h.state.ci = 'failure'; h.state.findingIdentity = '9'.repeat(64);
    await expectTick(h, 'needs_attention'); assert.equal(h.state.modelCalls, 2);
    assert.equal((await h.row()).repair_cycle_count, 0); noForbiddenEffects(h);
  }));
});

test('coordinator DB: real transaction acknowledgment loss and restart never blindly replay effects', guarded, async t => {
  for (const afterCommit of [false, true]) {
    await t.test(`atomic evidence readiness acknowledgment ${afterCommit ? 'after' : 'before'} real COMMIT`, () => withCoordinator(async h => {
      await toReview(h); h.state.review = 'complete'; h.restart({ futureReview: true });
      const before = await h.row(); const expected = h.expectedEvidence(h.syntheticFutureReview().reviewId);
      h.control.calls.length = 0; h.control.writes.length = 0;
      h.control.fault = { method: 'finishRun', afterCommit, injected: false };
      await expectTick(h, 'needs_attention'); assert.equal(h.control.fault.injected, true);
      assert.equal(h.control.calls.length, h.control.fault.callIndex);
      assert.equal(h.control.calls.some(call => call.name === 'checkpoint'), false);
      assert.equal(h.control.writes.filter(write => write.method === 'finishRun' && write.evidence && write.terminal && write.clearsLease).length, 1);
      const uncertain = await h.row();
      if (afterCommit) {
        assert.equal(uncertain.state, 'ready_for_human'); assertEvidence(await released(h), expected);
        assert.equal((await h.terminalEvents()).length, 1);
      } else {
        assert.equal(uncertain.state, 'waiting_review'); assert.equal(uncertain.terminal_at, null);
        assert.deepEqual(storedEvidence(uncertain), storedEvidence(before));
        assert.equal(uncertain.review_head_sha, before.review_head_sha);
        assert.equal(uncertain.prior_review_id, before.prior_review_id);
        assert.equal(uncertain.lease_token !== null, true); assert.equal((await h.terminalEvents()).length, 0);
        await h.expireLease();
      }
      const writes = h.state.mutations.length; const models = h.state.modelCalls;
      h.control.fault = null; h.restart({ futureReview: true });
      await expectTick(h, afterCommit ? 'idle' : 'ready_for_human');
      assertEvidence(await released(h), expected); await assertProjection(h, expected);
      h.restart({ futureReview: true }); await expectTick(h, 'idle');
      assert.equal((await h.terminalEvents()).length, 1);
      assert.equal(h.state.mutations.length, writes); assert.equal(h.state.modelCalls, models); noForbiddenEffects(h);
    }));
    for (const transition of ['RED checkpoint', 'CI repair']) {
      await t.test(`${transition} evidence acknowledgment ${afterCommit ? 'after' : 'before'} COMMIT keeps phase and refs atomic`, () => withCoordinator(async h => {
        if (transition === 'RED checkpoint') { await toRed(h); h.state.ci = 'red'; }
        else { await toGreen(h); h.state.ci = 'failure'; }
        const before = await h.row(); const expected = h.expectedEvidence();
        const method = transition === 'RED checkpoint' ? 'checkpoint' : 'beginRepair';
        h.control.fault = { method, afterCommit, injected: false };
        await expectTick(h, 'needs_attention'); assert.equal(h.control.fault.injected, true);
        assert.equal(h.control.calls.length, h.control.fault.callIndex);
        const after = await h.row();
        if (afterCommit) {
          assertEvidence(after, expected);
          assert.equal(after.phase_purpose, transition === 'RED checkpoint' ? 'initial_implementation' : 'repair_investigation');
          assert.equal(after.repair_cycle_count, before.repair_cycle_count + (method === 'beginRepair' ? 1 : 0));
        } else {
          assert.equal(after.state, before.state); assert.equal(after.phase_key, before.phase_key);
          assert.deepEqual(storedEvidence(after), storedEvidence(before));
          assert.equal(after.repair_cycle_count, before.repair_cycle_count);
        }
        assert.equal((await h.terminalEvents()).length, 0);
        noForbiddenEffects(h);
      }));
    }
  }
  for (const afterCommit of [false, true]) {
    for (const method of ['checkpoint', 'reserveModelCall', 'recordModelCallOutcome', 'putIntent', 'fenceIntent', 'confirmIntent']) {
      await t.test(`${method} acknowledgment ${afterCommit ? 'after' : 'before'} COMMIT`, () => withCoordinator(async h => {
        if (method !== 'checkpoint') await expectTick(h, 'advanced');
        h.control.fault = { method, afterCommit, injected: false };
        await expectTick(h, 'needs_attention'); assert.equal(h.control.fault.injected, true);
        const models = h.state.modelCalls; const writes = h.state.mutations.length;
        assert.equal(h.control.calls.length, h.control.fault.callIndex,
          'Unknown database acknowledgment must end the continuation without another store call.');
        await h.expireLease(); h.control.fault = null; h.restart();
        const response = await h.tick();
        assert.equal(['advanced', 'needs_attention', 'waiting'].includes(response.status), true);
        // A pending or uncertain model/effect never runs another model during recovery.
        if (method !== 'checkpoint' && !(method === 'reserveModelCall' && !afterCommit)) {
          assert.equal(h.state.modelCalls, models); assert.equal(h.state.mutations.length, writes);
        }
        noForbiddenEffects(h);
      }));
    }
  }
  for (const afterCommit of [false, true]) {
    for (const phase of ['commit', 'pr']) {
      await t.test(`${phase} fence acknowledgment ${afterCommit ? 'after' : 'before'} real COMMIT is reconcile-only on restart`, () => withCoordinator(async h => {
        if (phase === 'pr') { await toGreen(h); await expectTick(h, 'advanced'); }
        else await expectTick(h, 'advanced');
        h.control.fault = { method: 'fenceIntent', phase, afterCommit, injected: false };
        await expectTick(h, 'needs_attention'); assert.equal(h.control.fault.injected, true);
        assert.equal(h.control.calls.length, h.control.fault.callIndex);
        const operations = await h.operations(); const pending = operations.find(operation => operation.kind === (phase === 'pr' ? 'pr_create' : 'commit_create'));
        const models = h.state.modelCalls; const writes = h.state.mutations.length;
        await h.expireLease(); h.control.fault = null; h.restart();
        const result = await h.tick();
        assert.equal(result.status, 'needs_attention');
        assert.equal(h.state.modelCalls, models);
        // Every pending intent takes the exclusive reconcile-only path, even before an attempted write.
        assert.equal(h.state.mutations.length, writes);
        assert.equal((await h.operations()).some(operation => operation.operation_id === pending.operation_id), true);
        noForbiddenEffects(h);
      }));
    }
    await t.test(`post-publication checkpoint acknowledgment ${afterCommit ? 'after' : 'before'} COMMIT retains confirmed wait`, () => withCoordinator(async h => {
      await expectTick(h, 'advanced');
      h.control.fault = { method: 'checkpoint', afterCommit, injected: false };
      await expectTick(h, 'needs_attention'); assert.equal(h.control.fault.injected, true);
      const before = await h.row(); assert.equal(before.state, 'waiting_red_ci');
      assert.equal(before.pending_operation_id, null);
      await h.expireLease(); h.control.fault = null; h.restart(); await expectTick(h, 'waiting');
      const after = await released(h); assert.equal(after.wait_started_at.toISOString(), before.wait_started_at.toISOString());
      assert.equal(h.state.modelCalls, 1); assert.deepEqual(h.state.mutations, ['branch', 'commit']);
    }));
  }
  for (const purpose of ['initial_implementation', 'draft_pr']) {
    for (const afterCommit of [false, true]) {
      await t.test(`${purpose} confirmation acknowledgment ${afterCommit ? 'after' : 'before'} COMMIT retains its original purpose and identity`, () => withCoordinator(async h => {
        if (purpose === 'draft_pr') { await toGreen(h); await expectTick(h, 'advanced'); }
        else await toImplementation(h);
        const parent = (await h.row()).phase_head_sha;
        h.control.fault = { method: 'confirmIntent', afterCommit, injected: false };
        await expectTick(h, 'needs_attention'); assert.equal(h.control.fault.injected, true);
        const before = await h.row(); const operations = await h.operations();
        assert.equal(before.phase_purpose, purpose);
        const models = h.state.modelCalls; const writes = h.state.mutations.length;
        await h.expireLease(); h.control.fault = null; h.state.ci = 'waiting'; h.restart();
        await expectTick(h, afterCommit ? 'waiting' : 'advanced');
        const after = await released(h); assert.equal(after.state, purpose === 'draft_pr' ? 'waiting_review' : 'waiting_ci');
        assert.equal(after.phase_head_sha, parent); assert.equal(after.expected_head_sha, h.state.head);
        assert.equal(after.pending_operation_id, null); assert.equal(h.state.modelCalls, models);
        assert.equal(h.state.mutations.length, writes); assert.equal((await h.operations()).length, operations.length);
        if (purpose === 'draft_pr') assert.equal(h.state.prs.length, 1);
        noForbiddenEffects(h);
      }));
    }
  }
  await t.test('successful model receipt with no durable candidate stops explicitly instead of regenerating', () => withCoordinator(async h => {
    await expectTick(h, 'advanced');
    h.control.fault = { method: 'putIntent', afterCommit: false, injected: false };
    await expectTick(h, 'needs_attention'); assert.equal(h.control.fault.injected, true);
    assert.equal((await h.operations()).filter(operation => operation.outcome_code === 'success').length, 1);
    await h.expireLease(); h.control.fault = null; h.restart(); await expectTick(h, 'needs_attention');
    assert.equal((await h.row()).blocker_code, 'coordinator_candidate_lost');
    assert.equal(h.state.modelCalls, 1); assert.equal(h.state.mutations.length, 0);
  }));
  await t.test('pending observed commit reconciles the exact stored candidate before any model', () => withCoordinator(async h => {
    await expectTick(h, 'advanced');
    h.control.fault = { method: 'confirmIntent', afterCommit: false, injected: false };
    await expectTick(h, 'needs_attention'); assert.equal(h.control.fault.injected, true);
    const before = await h.row(); const operations = await h.operations();
    assert.equal(before.pending_operation_id !== null, true);
    const pendingId = before.pending_operation_id;
    await h.expireLease(); h.control.fault = null; h.restart(); await expectTick(h, 'advanced');
    const after = await released(h); assert.equal(after.pending_operation_id, null);
    assert.equal(after.expected_head_sha, h.state.head); assert.equal(after.phase_head_sha, HEAD);
    assert.equal(h.state.modelCalls, 1); assert.deepEqual(h.state.mutations, ['branch', 'commit']);
    assert.equal((await h.operations()).find(operation => operation.operation_id === pendingId).effect_phase, 'confirmed');
    assert.equal((await h.operations()).length, operations.length);
  }));
  for (const effect of ['branch', 'commit', 'draft']) {
    await t.test(`lost synthetic ${effect} HTTP acknowledgment reconciles one durable effect`, () => withCoordinator(async h => {
      if (effect === 'draft') { await toGreen(h); await expectTick(h, 'advanced'); }
      else await expectTick(h, 'advanced');
      h.state.loss = effect; await expectTick(h, 'advanced');
      assert.equal(h.state.mutations.filter(kind => kind === effect).length, 1);
      assert.equal((await released(h)).pending_operation_id, null);
      noForbiddenEffects(h);
    }));
  }
});

test('coordinator DB: stale ownership, revocation and human stops prevent later model or publication', guarded, async t => {
  await t.test('approval revoked before model cancels durably with zero reservations', () => withCoordinator(async h => {
    await expectTick(h, 'advanced'); h.state.revoked = true;
    const response = await h.tick(); assert.equal(h.state.modelCalls, 0);
    assert.equal((await h.operations()).length, 0);
    const next = await h.tick(); assert.equal(h.state.modelCalls, 0); assert.equal(h.state.mutations.length, 0);
    noForbiddenEffects(h);
    assert.deepEqual(response, { code: 200, status: 'cancelled' });
    assert.deepEqual(next, { code: 200, status: 'idle' });
  }));
  for (const boundary of ['branch', 'commit', 'draft']) {
    await t.test(`fresh authority revoked immediately before ${boundary} write`, () => withCoordinator(async h => {
      if (boundary === 'draft') { await toGreen(h); await expectTick(h, 'advanced');
        const original = h.dependencies.publicationDependencies.getPullRequestContext;
        h.dependencies.publicationDependencies.getPullRequestContext = async request => {
          const value = await original(request); h.state.revoked = true; return value;
        }; h.restart();
      } else {
        await expectTick(h, 'advanced');
        if (boundary === 'branch') {
          const original = h.dependencies.publicationDependencies.getPublicationContext;
          h.dependencies.publicationDependencies.getPublicationContext = async request => {
            const value = await original(request); h.state.revoked = true; return value;
          }; h.restart();
        } else h.state.afterMutation = async kind => { if (kind === 'branch') h.state.revoked = true; };
      }
      const before = h.state.mutations.filter(kind => kind === boundary).length;
      const response = await h.tick(); assert.equal(h.state.mutations.filter(kind => kind === boundary).length, before);
      const models = h.state.modelCalls; const writes = h.state.mutations.length;
      const next = await h.tick(); assert.equal(h.state.modelCalls, models); assert.equal(h.state.mutations.length, writes);
      noForbiddenEffects(h);
      assert.deepEqual(response, { code: 200, status: 'cancelled' });
      assert.deepEqual(next, { code: 200, status: 'idle' });
    }));
  }
  await t.test('expired SQL owner cannot terminalize or publish over a successor lease', () => withCoordinator(async h => {
    let entered; const started = new Promise(resolve => { entered = resolve; });
    let unblock; const gate = new Promise(resolve => { unblock = resolve; });
    let blocked = false;
    h.state.beforeHTTP = async () => { if (!blocked) { blocked = true; entered(); await gate; } };
    const pending = h.tick(); await awaitEntered(started, pending);
    const oldLease = h.control.lastClaim.lease;
    try {
      await h.expireLease();
      const manifest = { repositoryId: h.job.repositoryId, repositoryFullName: h.job.repositoryFullName,
        issueId: h.job.issueId, issueNumber: h.job.issueNumber, actorId: h.job.actorId,
        manifestHash: h.dependencies.expectedManifestSha256, baseRevision: HEAD,
        policyRevision: h.manifest.policyRevision, limits: h.manifest.limits };
      const successor = await h.actualStore.claimTick({ invocationId: randomUUID(), manifest });
      assert.equal(successor.status, 'claimed'); assert.equal(successor.lease.generation > oldLease.generation, true);
      assert.equal(await h.actualStore.finishRun(oldLease, 'cancelled', {}), false);
      assert.equal((await h.actualStore.getCoordinatorSnapshot(oldLease)).status, 'stale');
      const expectedGeneration = successor.lease.generation;
      unblock(); assert.deepEqual(await pending, { code: 200, status: 'needs_attention' });
      const row = await h.row(); assert.equal(Number(row.generation), expectedGeneration);
      assert.equal(row.terminal_at, null); assert.equal(row.lease_token === successor.lease.token, true);
      assert.equal(h.state.modelCalls, 0); assert.equal(h.state.mutations.length, 0);
    } finally { unblock(); await pending; }
  }));
  await t.test('SQL-server tick deadline expires only after the target HTTP await is entered', () => withCoordinator(async h => {
    let entered; const started = new Promise(resolve => { entered = resolve; });
    let unblock; const gate = new Promise(resolve => { unblock = resolve; }); let blocked = false;
    h.state.beforeHTTP = async () => { if (!blocked) { blocked = true; entered(); await gate; } };
    const pending = h.tick(); await awaitEntered(started, pending);
    try {
      await h.owner.query(`UPDATE agent_worker.runs SET lease_started_at=clock_timestamp()-interval '91 seconds'
        WHERE job_id=$1 AND lease_token IS NOT NULL`, [h.job.jobId]);
    } finally { unblock(); }
    assert.deepEqual(await pending, { code: 200, status: 'needs_attention' });
    assert.equal(h.state.modelCalls, 0); assert.equal(h.state.mutations.length, 0);
    assert.equal((await h.row()).terminal_at, null);
  }));
  await t.test('controlled local clock expiry after model await blocks late publication; does not claim SQL or HTTP cancellation', () => withCoordinator(async h => {
    await expectTick(h, 'advanced');
    let entered; const started = new Promise(resolve => { entered = resolve; });
    let unblock; const gate = new Promise(resolve => { unblock = resolve; });
    h.state.beforeModel = async () => { entered(); await gate; };
    const pending = h.tick(); await awaitEntered(started, pending);
    const realNow = Date.now;
    try {
      const future = realNow() + 100000; Date.now = () => future; unblock();
      assert.deepEqual(await pending, { code: 200, status: 'needs_attention' });
    } finally { Date.now = realNow; unblock(); }
    assert.equal(h.state.modelCalls, 1); assert.equal(h.state.mutations.length, 0);
    assert.equal((await h.operations()).filter(operation => operation.kind === 'commit_create').length, 0);
    const { rows: [server] } = await h.runtime.query(`SELECT
      lease_started_at+interval '90 seconds'>clock_timestamp() AS sql_deadline_live
      FROM agent_worker.runs WHERE job_id=$1`, [h.job.jobId]);
    assert.equal(server.sql_deadline_live, true);
  }));
  await t.test('model uncertainty is durable and never authorizes candidate publication or provider fallback', () => withCoordinator(async h => {
    await expectTick(h, 'advanced'); h.state.modelFailure = true;
    await expectTick(h, 'needs_attention'); assert.equal(h.state.modelCalls, 1);
    assert.equal(h.state.mutations.length, 0); await expectTick(h, 'idle'); assert.equal(h.state.modelCalls, 1);
  }));
});
