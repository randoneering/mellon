import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createRecoveryCoordinator } from '../../src/automation/worker/recovery.mjs';
import { buildOperationHash, validationBaseFromTree } from '../../src/automation/worker/publication-validation.mjs';
import { validateChanges } from '../../src/automation/worker/patch.mjs';
import { buildCoordinatorPhaseKey } from '../../src/automation/worker/store-validation.mjs';
import { createPublisherFixture, CHANGE_PATH, COMMIT_SHA } from '../fixtures/agent-worker-publication.mjs';
import { MODEL_ID, descriptor } from '../fixtures/agent-worker-journal.mjs';

function harness({ outcome = 'success', pending = false, conflict = false, uncertain = false } = {}) {
  const fixture = createPublisherFixture();
  fixture.context.signingPreflight.expiresAt = fixture.context.contextExpiresAt;
  const publication = fixture.request;
  const { run } = publication;
  const phaseKey = buildCoordinatorPhaseKey({ runId: run.id, manifestSha256: run.manifestSha256,
    purpose: 'initial_tests', repairCycle: 0, headSha: run.expectedHeadSha, findingSha256: null });
  const hash = buildOperationHash(publication, validateChanges(validationBaseFromTree(new Map(), [CHANGE_PATH]), publication.proposedChanges,
    { allowedPaths: publication.approvedManifest.allowedPaths, pilotScope: publication.approvedManifest.pilotScope }));
  const intent = { key: publication.intent.id, kind: 'commit_create', inputHash: hash,
    expectedHeadSha: run.expectedHeadSha, coordinator: { version: 1, purpose: 'initial_tests',
      phaseKey, repairCycle: 0, modelOperationId: MODEL_ID,
      expectedRegression: { workflowId: 7, testIdentitySha256: 'b'.repeat(64), proposalSha256: hash },
      criterionSha256: 'b'.repeat(64), candidateDescriptors: [descriptor()] } };
  const lease = { runId: run.id, jobId: randomUUID(), repositoryId: run.repositoryId,
    repositoryFullName: 'randoneering/mellon', issueId: run.issueId, issueNumber: run.issueNumber,
    actorId: run.approverId, generation: run.generation, token: randomUUID(),
    expiresAt: new Date(Date.now() + 180000).toISOString() };
  const calls = [];
  const store = {
    async getRun() { return { manifestHash: run.manifestSha256, baseRevision: run.baseSha,
      policyRevision: publication.approvedManifest.policyRevision }; },
    async getCoordinatorSnapshot(value, options) {
      calls.push('snapshot');
      assert.ok(options.deadline <= input.deadline);
      if (uncertain) throw new Error('private');
      return { status: 'owned', phase: { key: phaseKey, purpose: 'initial_tests', repairCycle: 0 },
        modelOperation: { operationId: MODEL_ID, outcome },
        pendingOperation: pending ? { ...intent, key: conflict ? '0'.repeat(64) : intent.key } : null };
    },
    async putIntent(value, candidate) {
      calls.push('intent');
      assert.deepEqual(candidate.coordinator, intent.coordinator);
      return { status: pending ? 'existing' : 'created' };
    },
    async fenceIntent() { calls.push('fence'); return { status: 'owned', decision: 'execute' }; },
    async confirmIntent() { calls.push('confirm'); return true; },
    async finishRun(value, state, options) { calls.push(options.blockerCode); return true; },
  };
  const input = { lease, intent, publication, deadline: Date.now() + 90000 };
  return { input, calls, fixture, perform: createRecoveryCoordinator({ store,
    publicationDependencies: fixture.dependencies }).perform };
}

test('journal purpose is durable before publication and fixed publisher request remains unchanged', async () => {
  const h = harness();
  const shape = Object.keys(h.input.publication).sort();
  assert.equal((await h.perform(h.input)).commitSha, COMMIT_SHA);
  assert.deepEqual(Object.keys(h.input.publication).sort(), shape);
  assert.equal(Object.hasOwn(h.input.publication, 'coordinator'), false);
  assert.ok(h.calls.includes('snapshot'));
  assert.ok(h.calls.indexOf('snapshot') < h.calls.indexOf('intent'));
  assert.ok(h.calls.indexOf('intent') < h.calls.indexOf('fence'));
});

for (const options of [{ outcome: null }, { outcome: 'uncertain' }, { pending: true, conflict: true }, { uncertain: true }]) {
  test(`journal recovery rejects unknown model, wrong pending identity or database uncertainty ${JSON.stringify(options)}`, async () => {
    const h = harness(options);
    const result = await h.perform(h.input);
    assert.equal(result.status, 'needs_attention');
    assert.equal(result.reason, options.uncertain ? 'recovery_database_uncertain'
      : options.conflict ? 'coordinator_journal_conflict' : 'coordinator_model_uncertain');
    assert.equal(h.fixture.state.branchWrites + h.fixture.state.commitWrites, 0);
    assert.equal(h.calls.includes('intent'), false);
    if (options.uncertain) {
      assert.equal(result.persisted, false);
      assert.equal(h.calls.includes('recovery_database_uncertain'), false);
    }
  });
}
