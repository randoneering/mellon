import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoordinator } from '../../src/automation/worker/coordinator.mjs';
import { harness, delivery } from '../fixtures/worker-coordinator/harness.mjs';
import { publicationHarness } from '../fixtures/worker-coordinator/publication.mjs';

const tick = h => h.coordinator.advanceTick(delivery());

async function generating(h) {
  h.coordinator = createCoordinator(h.dependencies);
  assert.equal((await tick(h)).status, 'advanced');
}

test('read-only admission expiry finalizes without continuing the model or late snapshot', async t => {
  const h = await harness();
  let clock = Date.now(), modelDeadline;
  t.mock.method(Date, 'now', () => clock);
  const createAgent = h.adapters.createAgentWorker;
  h.adapters.createAgentWorker = options => {
    modelDeadline = options.deadline;
    return createAgent(options);
  };
  await generating(h);
  h.state.snapshotHook = () => {
    if (modelDeadline) clock = modelDeadline - 40_000 + 1;
  };
  const response = await tick(h);
  assert.equal(response.reason, 'recovery_deadline');
  assert.equal(response.persisted, true);
  assert.equal(h.state.run.state, 'needs_attention');
  assert.equal(h.state.stops.length, 1);
  assert.equal(h.state.modelRequests, 0);
  assert.equal(h.state.calls.some(call => call[0] === 'reserveModelCall'), false);
});

test('publication finalization expiry before terminal SQL preserves partial work as a deadline', async t => {
  const h = await publicationHarness();
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  await generating(h);
  const context = h.dependencies.publicationDependencies.getPublicationContext;
  h.dependencies.publicationDependencies.getPublicationContext = async request => {
    clock = h.state.deadline + 1;
    return context(request);
  };
  // Publication dependencies are captured by the constructor.
  h.coordinator = createCoordinator(h.dependencies);
  const response = await tick(h);
  assert.equal(response.reason, 'recovery_deadline');
  assert.equal(response.persisted, false);
  assert.equal(response.diagnostics.stage, 'publication');
  assert.equal(response.diagnostics.category, 'recovery_deadline');
  assert.equal(response.diagnostics.modelOperationId, h.state.modelOperation.operationId);
  assert.equal(response.diagnostics.candidateOperationId, h.state.pendingOperation.key);
  assert.equal(response.diagnostics.actualInputTokens, 100);
  assert.equal(h.state.calls.some(call => call[0] === 'finishRun'), false);
  assert.equal(h.state.run.terminalAt, null);
  assert.equal(h.fixture.state.branchWrites, 0);
});

test('publication expiry with terminal SQL in flight remains uncertain and never compensates', async t => {
  const h = await publicationHarness();
  let clock = Date.now(), late;
  t.mock.method(Date, 'now', () => clock);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  h.dependencies.publicationDependencies.getPublicationContext = async () => ({});
  await generating(h);
  h.state.finishHook = () => {
    clock = h.state.deadline + 1;
    t.mock.timers.tick(90_000);
    return new Promise(resolve => { late = resolve; });
  };
  const response = await tick(h);
  assert.equal(response.reason, 'recovery_database_uncertain');
  assert.equal(response.persisted, false);
  assert.equal(h.state.calls.filter(call => call[0] === 'finishRun').length, 1);
  late(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.calls.filter(call => call[0] === 'finishRun').length, 1);
});

test('confirmed cancellation survives a later recovery rejection and expiry', async t => {
  const h = await harness();
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  h.adapters.createRecoveryCoordinator = ({ publicationDependencies }) => ({
    async perform() {
      h.state.approvalReason = 'readiness_label_missing';
      await assert.rejects(publicationDependencies.checkApproval());
      assert.equal(h.state.run.state, 'cancelled');
      clock = h.state.deadline + 1;
      throw new Error('Untrusted recovery rejection');
    },
  });
  await generating(h);
  const response = await tick(h);
  assert.equal(response.status, 'cancelled');
  assert.equal(response.reason, 'recovery_approval_denied');
  assert.equal(response.persisted, true);
  assert.equal(h.state.calls.filter(call => call[0] === 'finishRun').length, 1);
});

test('latest admitted model completion retains separately funded fresh post-model authority', async t => {
  const h = await harness();
  let clock = Date.now(), modelDeadline, modelTimeout, callDeadline, postModel = false;
  t.mock.method(Date, 'now', () => clock);
  const createAgent = h.adapters.createAgentWorker;
  h.adapters.createAgentWorker = options => {
    modelDeadline = options.deadline;
    modelTimeout = options.timeoutMs;
    return createAgent(options);
  };
  const generate = h.model.sdk.generateText;
  h.model.sdk.generateText = async options => {
    clock = callDeadline - 1;
    const response = await generate(options);
    postModel = true;
    return response;
  };
  const reserve = h.store.reserveModelCall;
  h.store.reserveModelCall = async (...args) => {
    callDeadline = Math.min(modelDeadline, clock + modelTimeout);
    return { ...await reserve(...args), deadlineAt: new Date(modelDeadline).toISOString() };
  };
  const outcome = h.store.recordModelCallOutcome;
  h.store.recordModelCallOutcome = async (...args) => {
    clock += 4_000;
    return outcome(...args);
  };
  h.state.filesHook = () => { clock = h.state.deadline - 73_000 - 2_000; };
  h.state.approvalHook = () => {
    if (postModel || h.state.modelOperation) clock += 1_000;
  };
  const issue = h.adapters.repository.readIssue;
  h.adapters.repository.readIssue = async request => {
    if (postModel) clock += 3_300;
    else if (h.state.modelOperation) clock += 4_000;
    return issue(request);
  };
  await generating(h);
  const response = await tick(h);
  assert.equal(response.status, 'advanced', JSON.stringify(response));
  assert.equal(response.persisted, true);
  assert.equal(h.state.modelRequests, 1);
  assert.equal(h.state.modelOperation.outcome, 'success');
  assert.equal(h.state.publications.length, 1);
  assert.ok(h.state.publications[0].deadline - clock >= 8_000);
  assert.equal(h.state.calls.filter(call => call[0] === 'policy').length, 70);
});

test('reservation SQL expires before the separately funded post-reservation authority window', async t => {
  const h = await harness();
  let clock = Date.now(), modelDeadline, reservationDeadline;
  t.mock.method(Date, 'now', () => clock);
  const createAgent = h.adapters.createAgentWorker;
  h.adapters.createAgentWorker = options => {
    modelDeadline = options.deadline;
    return createAgent(options);
  };
  await generating(h);
  const reserve = h.store.reserveModelCall;
  h.store.reserveModelCall = async (...args) => {
    reservationDeadline = args.at(-1).deadline;
    const receipt = await reserve(...args);
    clock = modelDeadline - 40_000 + 1;
    return receipt;
  };
  const response = await tick(h);
  assert.equal(reservationDeadline, modelDeadline - 40_000);
  assert.equal(response.reason, 'recovery_database_uncertain');
  assert.equal(response.persisted, false);
  assert.equal(h.state.stops.length, 0);
  assert.equal(h.state.modelRequests, 0);
  assert.equal(h.state.calls.some(call => call[0] === 'recordModelCallOutcome'), false);
});

test('settled uncertain model outcome survives post-reservation authority expiry', async t => {
  const h = await harness();
  let clock = Date.now(), modelDeadline;
  t.mock.method(Date, 'now', () => clock);
  const createAgent = h.adapters.createAgentWorker;
  h.adapters.createAgentWorker = options => {
    modelDeadline = options.deadline;
    return createAgent(options);
  };
  await generating(h);
  h.state.approvalHook = () => {
    if (h.state.modelOperation) clock = modelDeadline - 30_000 + 1;
  };
  const recordOutcome = h.store.recordModelCallOutcome;
  h.store.recordModelCallOutcome = async (...args) => {
    const receipt = await recordOutcome(...args);
    assert.equal(receipt.outcome, 'uncertain');
    assert.equal(receipt.blockerCode, 'model_outcome_uncertain');
    h.state.run.state = 'needs_attention';
    h.state.run.terminalAt = new Date(clock).toISOString();
    h.state.lease = null;
    return receipt;
  };
  h.store.finishRun = async (...args) => {
    h.state.calls.push(['finishRun', ...args]);
    return false;
  };
  const response = await tick(h);
  assert.equal(response.status, 'needs_attention');
  assert.equal(response.reason, 'model_outcome_uncertain');
  assert.equal(h.state.modelOperation.outcome, 'uncertain');
  assert.equal(h.state.run.state, 'needs_attention');
  assert.equal(h.state.modelRequests, 0);
  assert.equal(h.state.calls.filter(call => call[0] === 'recordModelCallOutcome').length, 1);
  assert.equal(h.state.calls.some(call => call[0] === 'finishRun'), false);
});
