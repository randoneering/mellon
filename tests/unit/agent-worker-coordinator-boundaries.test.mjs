import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoordinator } from '../../src/automation/worker/coordinator.mjs';
import { createRecoveryCoordinator } from '../../src/automation/worker/recovery.mjs';
import { prepareCandidate } from '../../src/automation/worker/candidate.mjs';
import { createRepositoryReader } from '../../src/automation/worker/repository.mjs';
import { createWorkflowDiscovery } from '../../src/automation/worker/discovery.mjs';
import { createCheckReader } from '../../src/automation/worker/checks.mjs';
import { candidateInput } from '../fixtures/worker-candidates/inputs.mjs';
import { harness, delivery } from '../fixtures/worker-coordinator/harness.mjs';

const tick = h => h.coordinator.advanceTick(delivery());
async function setup() { const h = await harness(); h.coordinator = createCoordinator(h.dependencies); return h; }
async function generating(h) { assert.equal((await tick(h)).status, 'advanced'); }

for (const boundary of ['reservation', 'outcome', 'confirmation']) {
  test(`coordinator scripted crash: uncertain ${boundary} never compensates or continues`, async () => {
    const h = await setup();
    await generating(h);
    if (boundary === 'reservation') h.state.reserveHook = () => { throw new Error('sensitive SQL'); };
    if (boundary === 'outcome') h.state.outcomeHook = () => { throw new Error('sensitive SQL'); };
    if (boundary === 'confirmation') h.state.recoveryHook = () => ({ status: 'needs_attention', reason: 'recovery_database_uncertain', persisted: false });
    const response = await tick(h);
    assert.equal(response.status, 'needs_attention');
    assert.equal(response.reason, 'recovery_database_uncertain');
    assert.equal(response.persisted, false);
    assert.equal(h.state.stops.length, 0);
    assert.doesNotMatch(JSON.stringify(response), /sensitive|SQL/);
  });
}

test('coordinator known snapshot read failure finalizes with a sanitized journal category', async () => {
  const h = await setup();
  h.state.snapshotHook = () => { throw new Error('sensitive SQL'); };
  const response = await tick(h);
  assert.equal(response.reason, 'coordinator_journal_conflict');
  assert.deepEqual(response.diagnostics,
    { stage: 'finalization', category: 'coordinator_journal_conflict' });
  assert.equal(response.persisted, true);
  assert.equal(h.state.stops.length, 1);
  assert.equal(h.state.modelRequests, 0);
  assert.doesNotMatch(JSON.stringify(response), /sensitive|SQL/);
});

test('coordinator unrecognized recovery rejection never permits a compensating DB write', async () => {
  const h = await setup(); await generating(h);
  h.state.recoveryHook = () => { throw new Error('Uncertain custom recovery acknowledgment'); };
  const response = await tick(h);
  assert.equal(response.status, 'needs_attention');
  assert.equal(response.persisted, false);
  assert.equal(h.state.stops.length, 0);
});

for (const boundary of ['before_model', 'after_model', 'after_reservation']) {
  test(`coordinator revocation fence ${boundary}: explicit withdrawal cancels without publication`, async () => {
    const h = await setup(); await generating(h);
    if (boundary === 'before_model') h.state.filesHook = () => { h.state.approvalReason = 'readiness_label_missing'; };
    if (boundary === 'after_model') {
      const original = h.model.sdk.generateText;
      h.model.sdk.generateText = async options => { const value = await original(options); h.state.approvalReason = 'readiness_label_missing'; return value; };
    }
    if (boundary === 'after_reservation') {
      const original = h.store.reserveModelCall;
      h.store.reserveModelCall = async (...args) => { const receipt = await original(...args); h.state.approvalReason = 'readiness_label_missing'; return receipt; };
    }
    assert.equal((await tick(h)).status, 'cancelled');
    assert.equal(h.state.publications.length, 0);
    assert.ok(h.state.modelRequests <= (boundary === 'after_model' ? 1 : 0));
  });
}

test('coordinator persistence receipt: uncertain successful-model acknowledgment has no terminal follow-up', async () => {
  const h = await setup(); await generating(h);
  h.state.outcomeHook = () => ({});
  assert.equal((await tick(h)).status, 'needs_attention');
  assert.equal(h.state.stops.length, 0);
  assert.equal(h.state.publications.length, 0);
});

test('coordinator transient assessment refusal maps to a fixed human-stop code', async () => {
  const h = await setup(); await generating(h); await tick(h);
  h.state.checkStatus = 'intended_red'; await tick(h); await tick(h);
  h.state.checkStatus = 'needs_attention'; await tick(h); await tick(h);
  h.state.disposition = 'suspected_false_positive';
  assert.equal((await tick(h)).status, 'needs_attention');
  assert.equal(h.state.stops.at(-1), 'coordinator_investigation_human_stop');
});

test('coordinator deadline: one aggregate budget covers slow reads, no lazy model factory after expiry', async () => {
  const h = await harness();
  let late;
  h.state.filesHook = () => new Promise(resolve => { late = resolve; });
  h.coordinator = createCoordinator({ ...h.dependencies, timeoutMs: 30 });
  await generating(h);
  const response = await tick(h);
  assert.equal(response.status, 'needs_attention'); assert.equal(response.reason, 'recovery_deadline');
  late(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.modelRequests, 0);
  assert.equal(h.state.stops.length, 0);
});

test('coordinator pending recovery: descriptor-exact original candidate precedes all model work', async () => {
  const h = await setup(); await generating(h);
  const candidate = prepareCandidate(candidateInput());
  h.state.modelOperation = { operationId: candidate.metadata.modelOperationId, outcome: 'success' };
  h.state.pendingOperation = { operationId: 'pending', ...candidate.intent }; h.state.phase.pendingOperationId = 'pending';
  h.state.reconstructHook = () => ({ ...candidate, observedHeadSha: 'c'.repeat(40), operationHash: candidate.intent.inputHash });
  h.state.recoveryHook = request => {
    assert.deepEqual(request.intent, candidate.intent);
    assert.deepEqual(request.publication, candidate.publication);
    return { status: 'needs_attention', reason: 'recovery_effect_unconfirmed', persisted: false };
  };
  assert.equal((await tick(h)).status, 'needs_attention');
  assert.equal(h.state.modelRequests, 0); assert.equal(h.state.stops.length, 0);
  assert.equal(h.state.calls.filter(call => call[0] === 'recovery').length, 1);
});

// Real fixed-resource readers against controlled transport, with only the journal scripted.
test('coordinator actual repository reader and discovery factories: current-head fixed resources, missing workflow waits', async () => {
  const h = await harness();
  const observed = [];
  const config = { token: 'synthetic', repository: h.manifest.repository.name, repositoryId: h.manifest.repository.id, policyRevision: h.manifest.policyRevision, trustedPaths: [], fetch: async (url, options) => {
    const parsed = new URL(url); observed.push(parsed.pathname + parsed.search);
    assert.equal(options.method, 'GET'); assert.ok(options.signal);
    if (parsed.pathname === '/repos/randoneering/mellon') return Response.json({ id: h.manifest.repository.id, full_name: h.manifest.repository.name, private: false });
    if (parsed.pathname.endsWith('/issues/22')) return Response.json({ id: h.manifest.issue.id, number: 22, state: 'open', repository_url: 'https://api.github.com/repos/randoneering/mellon', title: 'approved title', body: 'approved body' });
    if (parsed.pathname.endsWith('/runs')) return Response.json({ total_count: 0, workflow_runs: [] });
    throw new Error('Unscripted immutable read');
  } };
  const reader = createRepositoryReader(config);
  h.adapters.repository.readIssue = request => reader.readIssue(request);
  h.adapters.discovery = createWorkflowDiscovery(config);
  h.coordinator = createCoordinator(h.dependencies); await generating(h); await tick(h);
  const count = h.state.modelRequests;
  assert.equal((await tick(h)).status, 'waiting'); assert.equal(h.state.modelRequests, count);
  const workflowURL = observed.find(path => path.includes('/runs?'));
  assert.ok(workflowURL.includes(`head_sha=${h.state.run.expectedHeadSha}`));
});

test('coordinator actual check reader: unsupported transport evidence cannot advance RED', async () => {
  const h = await harness();
  h.adapters.checks = createCheckReader({ token: 'synthetic', repository: h.manifest.repository.name, fetch: async () => Response.json({}) });
  h.coordinator = createCoordinator(h.dependencies); await generating(h); await tick(h);
  assert.equal((await tick(h)).status, 'needs_attention'); assert.equal(h.state.modelRequests, 1);
});

// The actual recovery executes its intent boundary, with no publisher success stub.
test('coordinator actual recovery factory: uncertain intent COMMIT prevents publisher entry', async () => {
  const h = await harness();
  const candidate = prepareCandidate(candidateInput());
  let created = 0;
  h.adapters.createRecoveryCoordinator = options => {
    created += 1;
    return createRecoveryCoordinator(options);
  };
  h.store.getRun = async () => h.state.run;
  h.store.putIntent = async (_lease, intent, options) => {
    assert.equal(options.deadline, h.state.deadline);
    assert.equal(intent.inputHash, candidate.intent.inputHash);
    throw new Error('Injected uncertain COMMIT at actual recovery boundary');
  };
  h.store.fenceIntent = async () => { throw new Error('No network effect allowed'); };
  h.store.confirmIntent = async () => { throw new Error('No confirmation allowed'); };
  h.coordinator = createCoordinator(h.dependencies); await generating(h);
  const response = await tick(h);
  assert.equal(created, 1);
  assert.equal(response.reason, 'recovery_database_uncertain');
  assert.equal(h.state.stops.length, 0);
});
