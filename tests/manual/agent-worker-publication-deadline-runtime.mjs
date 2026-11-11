import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createProductionWorkerFunction } from '../../src/automation/worker/function.mjs';
import { createWorkerStore } from '../../src/automation/worker/store.mjs';
import { runtimeFixture } from '../fixtures/worker-runtime.mjs';
import { controlledTransport, nativeIdentity } from '../fixtures/worker-coordinator-db/transport.mjs';
import { blob, POLICY, PATH } from '../fixtures/worker-candidates/inputs.mjs';
import { runtimePostgres } from '../support/agent-worker-runtime-postgres-context.mjs';

const CASE = process.env.MELLON_PUBLICATION_DEADLINE_CASE;
const READINESS_CASE = ['readiness', 'readiness-baseline'].includes(CASE);
const LATENCY = Object.freeze({ startupMs: 4500, policyBlobMs: 770, modelMs: 30713,
  githubRequestMs: READINESS_CASE ? 100 : 0 });
const BASELINE_REVISION = '1c08180084dac9807a031bcc61b3c97435c868eb';

async function baselineEntry(revision = BASELINE_REVISION) {
  const directory = join(tmpdir(), `mellon-publication-baseline-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  symlinkSync(resolve('node_modules'), join(directory, 'node_modules'), 'dir');
  // Restore every tracked source, including the runtime and all publication dependencies.
  const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', revision, '--', 'src'], { encoding: 'utf8' }).trim().split('\n');
  for (const path of paths) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), execFileSync('git', ['show', `${revision}:${path}`]));
  }
  if (CASE === 'source-pin') {
    const revision = '1c08180084dac9807a031bcc61b3c97435c868eb';
    const expected = execFileSync('git', ['ls-tree', '-r', '--name-only', revision, '--', 'src'],
      { encoding: 'utf8' }).trim().split('\n');
    const restored = readdirSync(join(directory, 'src'), { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => join(entry.parentPath, entry.name).slice(directory.length + 1)).sort();
    assert.deepEqual(restored, expected.sort());
    for (const path of expected) {
      assert.deepEqual(readFileSync(join(directory, path)),
        execFileSync('git', ['show', `${revision}:${path}`]), `Pinned baseline source: ${path}`);
    }
    console.log(JSON.stringify({ case: 'source-pin', revision, verifiedSources: expected.length }));
  }
  return (await import(pathToFileURL(join(directory, 'src/automation/worker/function.mjs')).href)).createProductionWorkerFunction;
}

async function runtimeHarness({ entry = createProductionWorkerFunction, profile = false, stall = false } = {}) {
  const f = await runtimeFixture();
  const generatedIssue = Number.parseInt(randomUUID().slice(0, 8), 16) + 1;
  const transport = await controlledTransport({ issueId: generatedIssue, issueNumber: generatedIssue });
  Object.assign(transport.manifest, { model: structuredClone(f.config.manifest.model),
    limits: structuredClone(f.config.manifest.limits), qodoIdentities: structuredClone(f.config.manifest.qodoIdentities) });
  f.config.manifest = transport.manifest;
  f.config.policyManifest = transport.policyManifest;
  Object.assign(f.config.github.actor, transport.actor);
  f.pin();
  const jobId = randomUUID();
  await runtimePostgres.admin(`INSERT INTO agent_intake.jobs
    (job_id,repository_id,repository_full_name,issue_id,issue_number,actor_id,initial_delivery_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [jobId, f.config.manifest.repository.id,
    f.config.manifest.repository.name, f.config.manifest.issue.id, f.config.manifest.issue.number,
    f.config.manifest.approver.id, randomUUID()]);
  const policyBlobs = new Set([...transport.commits.get(POLICY).files.values()].map(blob));
  const reports = [];
  const metrics = { http: {}, profiledHttp: {}, calls: [], closes: [], sdkCalls: [], outcomes: [],
    statuses: [], reservations: 0, modelRequests: 0, starts: 0, profileStart: null,
    profileActive: false, modelStart: null, modelEnd: null, intentAt: null, lateDatabaseStarts: 0 };
  let releaseStall;
  const stalled = new Promise(resolve => { releaseStall = resolve; });
  if (stall) transport.state.afterMutation = async kind => { if (kind === 'branch') await stalled; };
  const gateway = new URL(f.env.WORKER_MODEL_BASE_URL);
  const fetch = async (url, options) => {
    const target = new URL(url);
    const key = `${options.method ?? 'GET'} ${target.origin === gateway.origin ? 'model' : target.pathname.replace(/[a-f0-9]{40}/g, ':sha')}`;
    metrics.http[key] = (metrics.http[key] ?? 0) + 1;
    if (metrics.profileActive) metrics.profiledHttp[key] = (metrics.profiledHttp[key] ?? 0) + 1;
    if (target.origin === gateway.origin) {
      assert.equal(target.pathname, '/openai/v1/responses');
      assert.equal(options.method, 'POST'); assert.ok(options.signal);
      metrics.modelRequests += 1;
      const body = JSON.parse(options.body);
      metrics.sdkCalls.push({ toolChoice: body.tool_choice, tools: body.tools.map(tool => tool.name),
        maxOutputTokens: body.max_output_tokens, store: body.store, temperature: body.temperature });
      metrics.modelStart = Date.now();
      const testing = transport.state.phase.purpose.endsWith('_tests');
      const proposal = { baseSha: transport.state.baseSha, manifestHash: f.config.manifestSha256,
        changes: [{ operation: 'create', path: testing ? PATH : 'src/parser.mjs', content: testing
          ? "import test from 'node:test';\nimport assert from 'node:assert/strict';\n\ntest('approved regression location', () => {\n  assert.equal(1, 2);\n});\n"
          : 'export const fixed = true;\n' }] };
      if (metrics.profileActive || READINESS_CASE) await delay(LATENCY.modelMs);
      metrics.modelEnd = Date.now();
      return Response.json({ id: `resp_${metrics.modelRequests}`, object: 'response', model: f.config.manifest.model.id,
        output: [{ id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'proposeChanges',
          arguments: JSON.stringify(proposal), status: 'completed' }],
        usage: { input_tokens: 800, output_tokens: 100, total_tokens: 900,
          output_tokens_details: { reasoning_tokens: 25 } } });
    }
    assert.equal(target.origin, 'https://api.github.com');
    if (LATENCY.githubRequestMs) await delay(LATENCY.githubRequestMs);
    if (target.pathname === '/apps/qodo-code-review') return Response.json({
      id: f.config.manifest.qodoIdentities[0].appId, slug: f.config.manifest.qodoIdentities[0].appSlug });
    if (decodeURIComponent(target.pathname) === `/users/${f.config.manifest.qodoIdentities[0].appSlug}[bot]`) return Response.json({
      id: f.config.manifest.qodoIdentities[0].userId, login: `${f.config.manifest.qodoIdentities[0].appSlug}[bot]`, type: 'Bot' });
    if ((metrics.profileActive || READINESS_CASE) && target.pathname.includes('/git/blobs/')
      && policyBlobs.has(target.pathname.split('/').at(-1))) await delay(LATENCY.policyBlobMs);
    return transport.fetch(url, options);
  };
  const factories = {
    fetch,
    createDatabase() {
      metrics.starts += 1;
      metrics.profileActive = profile && metrics.starts === 2;
      if (metrics.profileActive) metrics.profileStart = Date.now();
      const database = runtimePostgres.openDatabase();
      return { pool: database.pool,
        async verifyRole(options) {
          // Docker has no TLS. Execute the real catalog query, then allow only this local transport exception.
          await runtimePostgres.verifyLocalRole(database, options);
          if (metrics.profileActive || READINESS_CASE) await delay(LATENCY.startupMs);
        },
        async close() { metrics.closes.push(Date.now()); await database.close(); },
      };
    },
    createStore(pool) {
      const store = createWorkerStore(pool);
      const runtimeIndex = metrics.starts;
      return Object.fromEntries(Object.entries(store).map(([name, operation]) => [name, async (...args) => {
        if (metrics.closes.length >= runtimeIndex) metrics.lateDatabaseStarts += 1;
        const call = { name, at: Date.now(), deadline: args.at(-1)?.deadline };
        metrics.calls.push(call);
        if (name === 'reserveModelCall') metrics.reservations += 1;
        if (name === 'recordModelCallOutcome') metrics.outcomes.push(args[1].outcome);
        if (name === 'putIntent') metrics.intentAt = Date.now();
        const result = await operation(...args);
        call.finishedAt = Date.now();
        if (name === 'claimTick' && result.status === 'claimed') transport.state.runId = result.lease.runId;
        if (name === 'getCoordinatorSnapshot' && result.status === 'owned') {
          transport.state.phase = result.phase; transport.state.run = result.run;
          transport.state.baseSha = result.run.expectedHeadSha ?? result.run.baseRevision;
          transport.state.selected = result.phase?.expectedRegression;
          if (result.phase?.purpose === 'initial_tests') transport.state.selected = {
            testIdentitySha256: nativeIdentity(transport.manifest.coordinator.regression.initial.testName) };
        }
        return result;
      }]));
    },
    createBroker() {
      // Installation authority is synthetic. Fixed-resource readers, publisher and SDK remain real.
      return { async getReadToken() { return 'synthetic-runtime-read-token'; }, async verifyRuntime() {},
        getPublicationContext: transport.publicationDependencies.getPublicationContext,
        getPullRequestContext: transport.publicationDependencies.getPullRequestContext };
    },
  };
  const worker = entry({ env: f.env, report: line => reports.push(line), factories });
  async function tick() {
    const id = randomUUID();
    const startedAt = Date.now();
    const response = await worker.fetch(new Request('https://worker.invalid/tick', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-neon-trigger-invocation-id': id },
      body: JSON.stringify({ version: 1, invocation_id: id,
        trigger: { type: 'schedule', id: f.config.triggerId, name: 'issueworkertick' },
        data: { scheduled_at: new Date().toISOString() } }),
    }));
    const body = await response.json();
    metrics.statuses.push({ status: body.status, elapsedMs: Date.now() - startedAt });
    return { status: response.status, body };
  }
  async function ledger() {
    const { rows } = await runtimePostgres.owner.query(`SELECT state, blocker_code, pull_request_number,
      pending_operation_id, lease_token FROM agent_worker.runs WHERE job_id=$1`, [jobId]);
    const operations = await runtimePostgres.owner.query(`SELECT kind, outcome_code, effect_phase,
      effect_reference, branch_attempted, commit_attempted, pr_attempted FROM agent_worker.operations
      WHERE run_id IN (SELECT run_id FROM agent_worker.runs WHERE job_id=$1)`, [jobId]);
    return { run: rows[0], operations: operations.rows };
  }
  function receipt(name, extra = {}) {
    console.log(JSON.stringify({ case: name, latencyAssumptions: LATENCY, statuses: metrics.statuses,
      modelRequests: metrics.modelRequests, reservations: metrics.reservations, outcomes: metrics.outcomes,
      elapsedToModelMs: metrics.profileStart === null || metrics.modelStart === null ? null : metrics.modelStart - metrics.profileStart,
      elapsedModelMs: metrics.modelEnd === null || metrics.modelStart === null ? null : metrics.modelEnd - metrics.modelStart,
      elapsedToIntentMs: metrics.profileStart === null || metrics.intentAt === null ? null : metrics.intentAt - metrics.profileStart,
      http: metrics.http, profiledHttp: metrics.profiledHttp, lateDatabaseStarts: metrics.lateDatabaseStarts,
      reports, mutations: transport.state.mutations, ...extra }));
  }
  return { f, transport, metrics, reports, tick, ledger, receipt, releaseStall };
}

if (CASE === 'source-pin') test('baseline restoration uses only the public pre-change source tree', async () => {
  assert.equal(typeof await baselineEntry(), 'function');
});

if (CASE === 'baseline') test('untouched production baseline exposes the outer runtime publication race', async () => {
  const h = await runtimeHarness({ entry: await baselineEntry(), profile: true });
  assert.deepEqual(await h.tick(), { status: 200, body: { status: 'advanced' } });
  const response = await h.tick();
  const { run, operations } = await h.ledger();
  h.receipt('baseline', { publicStatus: response, state: run.state, blocker: run.blocker_code,
    pending: Boolean(run.pending_operation_id), operations });
  assert.equal(h.metrics.modelRequests, 1); assert.equal(h.metrics.reservations, 1);
  assert.deepEqual(h.metrics.outcomes, ['success']);
  assert.deepEqual(response, { status: 503, body: { status: 'unavailable' } });
  assert.equal(run.state, 'generating_tests'); assert.equal(run.blocker_code, null);
  assert.ok(run.pending_operation_id);
  assert.ok(h.reports.includes('[agent_worker] coordinator_unavailable'));
  assert.ok(h.metrics.statuses.at(-1).elapsedMs >= 89_000);
  assert.equal(h.transport.state.mutations.length, 0);
});

if (CASE === 'readiness-baseline') test('pre-repair production entry reproduces admission expiry without a model reservation', async () => {
  const h = await runtimeHarness({ entry: await baselineEntry('41f6fcce37405829e9645e68e99c0f2e61634bef'), profile: true });
  assert.deepEqual(await h.tick(), { status: 200, body: { status: 'advanced' } });
  const response = await h.tick();
  const { run, operations } = await h.ledger();
  h.receipt('readiness-baseline', { publicStatus: response, state: run.state,
    blocker: run.blocker_code, operations });
  assert.deepEqual(response, { status: 200, body: { status: 'needs_attention' } });
  assert.equal(run.blocker_code, 'recovery_deadline');
  assert.equal(h.metrics.modelRequests, 0);
  assert.equal(h.metrics.reservations, 0);
  assert.equal(operations.length, 0);
  assert.equal(h.transport.state.mutations.length, 0);
});
if (CASE === 'green' || CASE === 'readiness') {
  test('production entry completes the SQL SDK RED GREEN draft and exact head review lifecycle', async () => {
    const h = await runtimeHarness({ profile: true });
    for (let index = 0; index < 2; index += 1) assert.deepEqual(await h.tick(), { status: 200, body: { status: 'advanced' } });
    assert.equal((await h.ledger()).run.state, 'waiting_red_ci');
    assert.equal(h.metrics.modelRequests, 1); assert.deepEqual(h.metrics.outcomes, ['success']);
    const profiled = structuredClone(h.metrics.profiledHttp);
    const modelStart = h.metrics.modelStart, modelEnd = h.metrics.modelEnd, intentAt = h.metrics.intentAt;
    h.transport.state.ci = 'red';
    assert.deepEqual(await h.tick(), { status: 200, body: { status: 'advanced' } });
    assert.equal((await h.ledger()).run.state, 'implementing');
    assert.deepEqual(await h.tick(), { status: 200, body: { status: 'advanced' } });
    assert.equal((await h.ledger()).run.state, 'waiting_ci');
    h.transport.state.ci = 'green';
    assert.deepEqual(await h.tick(), { status: 200, body: { status: 'advanced' } });
    assert.equal((await h.ledger()).run.state, 'opening_pr');
    assert.deepEqual(await h.tick(), { status: 200, body: { status: 'advanced' } });
    assert.equal(h.transport.state.prs.length, 1); assert.equal(h.transport.state.prs[0].draft, true);
    const qodo = h.f.config.manifest.qodoIdentities[0];
    h.transport.state.reviewObjects = [{ id: 900, state: 'APPROVED', commit_id: h.transport.state.head,
      pull_request_url: 'https://api.github.com/repos/randoneering/mellon/pulls/31', body: '',
      submitted_at: new Date().toISOString(), user: { id: qodo.userId, type: 'Bot', login: `${qodo.appSlug}[bot]` } }];
    const reviewed = await h.tick();
    assert.deepEqual(reviewed, { status: 200, body: { status: 'ready_for_human' } });
    const { run, operations } = await h.ledger();
    assert.equal(run.state, 'ready_for_human'); assert.equal(run.blocker_code, null);
    assert.equal(Number(run.pull_request_number), 31); assert.equal(run.pending_operation_id, null);
    assert.equal(h.metrics.reservations, 2); assert.equal(h.metrics.sdkCalls.length, 2);
    assert.ok(h.metrics.sdkCalls.every(call => call.toolChoice?.type === 'function'
      && call.tools.length === 1 && call.tools[0] === 'proposeChanges' && call.store === false
      && call.temperature === undefined && call.maxOutputTokens <= 2000));
    assert.equal(h.metrics.lateDatabaseStarts, 0);
    assert.deepEqual(h.transport.state.mutations, ['branch', 'commit', 'commit', 'draft']);
    h.receipt(CASE === 'readiness' ? 'readiness' : 'green', { state: run.state, operations, profiledHttp: profiled,
      elapsedToModelMs: modelStart - h.metrics.profileStart, elapsedModelMs: modelEnd - modelStart,
      elapsedToIntentMs: intentAt - h.metrics.profileStart });
  });

}
if (CASE === 'green') {
  test('publication expiry finalizes known partial work before closing the SQL pool and ignores late transport', async () => {
    const h = await runtimeHarness({ stall: true });
    assert.deepEqual(await h.tick(), { status: 200, body: { status: 'advanced' } });
    const response = await h.tick();
    const { run, operations } = await h.ledger();
    assert.deepEqual(response, { status: 200, body: { status: 'needs_attention' } });
    assert.equal(run.state, 'needs_attention'); assert.equal(run.blocker_code, 'recovery_deadline');
    assert.equal(run.lease_token, null); assert.ok(run.pending_operation_id);
    const effect = operations.find(operation => operation.kind === 'commit_create');
    assert.equal(effect.branch_attempted, true); assert.equal(effect.commit_attempted, false);
    assert.equal(effect.effect_reference, null);
    const before = h.metrics.calls.length;
    h.releaseStall(); await delay(50);
    assert.equal(h.metrics.calls.length, before); assert.equal(h.metrics.lateDatabaseStarts, 0);
    assert.deepEqual(h.transport.state.mutations, ['branch']);
    assert.ok(h.reports.some(line => line.includes('stage=publication') && line.includes('category=recovery_deadline')));
    h.receipt('publication-expiry', { state: run.state, blocker: run.blocker_code, operations });
  });
}
