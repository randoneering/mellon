// Scripted journal plus actual recovery, publisher, and immutable reconstruction transport.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPublisherFixture, createDraftPrFixture, RUN_ID, COMMIT_SHA } from '../agent-worker-publication.mjs';
import { prepareCandidate } from '../../../src/automation/worker/candidate.mjs';
import { createRepositoryReader } from '../../../src/automation/worker/repository.mjs';
import { candidateInput, hash, canonical } from '../worker-candidates/inputs.mjs';
import { buildCoordinatorPhaseKey } from '../../../src/automation/worker/store-validation.mjs';
import { harness } from './harness.mjs';

export async function publicationHarness(options = {}) {
  const h = await harness();
  h.state.run.runId = RUN_ID;
  const fixture = createPublisherFixture({ manifest: h.manifest, ...options });
  h.dependencies.publicationDependencies = fixture.dependencies;
  delete h.adapters.createRecoveryCoordinator;
  const effects = new Set();
  h.store.getRun = async (_runId, wait) => { assert.equal(wait.deadline, h.state.deadline); return structuredClone(h.state.run); };
  h.store.putIntent = async (_lease, intent, wait) => {
    assert.equal(wait.deadline, h.state.deadline);
    if (h.state.pendingOperation) return { status: 'existing', operation: structuredClone(h.state.pendingOperation) };
    h.state.pendingOperation = { operationId: randomUUID(), ...structuredClone(intent) };
    h.state.phase.pendingOperationId = h.state.pendingOperation.operationId;
    h.state.phase.expectedRegression = intent.coordinator.expectedRegression;
    h.state.phase.criterionSha256 = intent.coordinator.criterionSha256;
    return { status: 'created', operation: structuredClone(h.state.pendingOperation) };
  };
  h.store.fenceIntent = async (_lease, _intent, phase, wait) => {
    assert.equal(wait.deadline, h.state.deadline);
    const used = effects.has(phase); effects.add(phase);
    if (h.state.fenceHook) return h.state.fenceHook(phase);
    return { status: 'owned', decision: used ? 'reconcile_only' : 'execute' };
  };
  h.store.confirmIntent = async (_lease, _intent, proof, wait) => {
    assert.equal(wait.deadline, h.state.deadline);
    if (h.state.confirmHook) await h.state.confirmHook(proof);
    h.state.run.expectedHeadSha = proof.commitSha;
    h.state.run.branchName = proof.branch;
    h.state.run.state = 'waiting_red_ci';
    h.state.pendingOperation = null; h.state.phase.pendingOperationId = null;
    h.state.phase.waitStartedAt = new Date().toISOString();
    return true;
  };
  const candidate = () => {
    const input = candidateInput();
    input.publicationRun.id = h.state.run.runId;
    input.phase = { ...h.state.phase };
    return prepareCandidate(input);
  };
  const transport = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/repos/randoneering/mellon') return Response.json({ id: h.manifest.repository.id, full_name: h.manifest.repository.name, private: false });
    const selected = h.state.pendingOperation?.coordinator.candidateDescriptors[0];
    if (selected && path.endsWith(`/git/blobs/${selected.afterBlobSha}`)) {
      const source = candidateInput().changes[0].content;
      return Response.json({ sha: selected.afterBlobSha, size: Buffer.byteLength(source), encoding: 'base64', content: Buffer.from(source).toString('base64') });
    }
    return fixture.dependencies.fetch(url, init);
  };
  function useActualReconstruction() {
    const reader = createRepositoryReader({ token: 'synthetic', repository: h.manifest.repository.name,
      repositoryId: h.manifest.repository.id, policyRevision: h.manifest.policyRevision, trustedPaths: [],
      ownedActor: fixture.context.actor, fetch: transport });
    h.adapters.repository.reconstructCandidate = request => reader.reconstructCandidate(request);
  }
  function installObservedCandidate() {
    const selected = candidate();
    h.state.modelOperation = { operationId: selected.metadata.modelOperationId, outcome: 'success' };
    h.state.pendingOperation = { operationId: randomUUID(), ...structuredClone(selected.intent) };
    h.state.phase.pendingOperationId = h.state.pendingOperation.operationId;
    h.state.phase.expectedRegression = selected.expectedRegression;
    h.state.phase.criterionSha256 = selected.metadata.criterionSha256;
    const path = selected.publication.proposedChanges[0].path;
    const parts = path.split('/');
    fixture.state.commitTree = parts.slice(0, -1).map((_, index) => ({ path: parts.slice(0, index + 1).join('/'), mode: '040000', type: 'tree', sha: '8'.repeat(40) }));
    fixture.state.commitTree.push({ path, mode: '100644', type: 'blob', sha: selected.metadata.candidateDescriptors[0].afterBlobSha });
    fixture.state.branchHead = COMMIT_SHA;
    return selected;
  }
  return { ...h, fixture, candidate, useActualReconstruction, installObservedCandidate };
}

export async function draftHarness() {
  const h = await harness();
  const fixture = createDraftPrFixture({ manifest: h.manifest });
  Object.assign(h.manifest, { requiredChecks: fixture.request.approvedManifest.requiredChecks,
    requiredWorkflowIdentities: fixture.request.approvedManifest.requiredWorkflowIdentities });
  h.manifest.coordinator.regression.workflowId = h.manifest.requiredWorkflowIdentities[0].id;
  const manifestHash = hash(canonical(h.manifest));
  h.dependencies.expectedManifestSha256 = manifestHash;
  h.dependencies.publicationDependencies = fixture.dependencies;
  const expectedRegression = { workflowId: h.manifest.coordinator.regression.workflowId,
    testIdentitySha256: '1'.repeat(64), proposalSha256: '2'.repeat(64) };
  Object.assign(h.state.run, { runId: RUN_ID, state: 'opening_pr', manifestHash,
    expectedHeadSha: COMMIT_SHA, branchName: fixture.branch });
  h.state.phase = { version: 1, purpose: 'draft_pr', repairCycle: 0, headSha: COMMIT_SHA,
    findingSha256: null, expectedRegression, criterionSha256: hash(h.manifest.acceptanceCriteria[0]),
    startedAt: new Date().toISOString(), waitStartedAt: null, pendingOperationId: null };
  h.state.phase.key = buildCoordinatorPhaseKey({ ...h.state.phase, runId: RUN_ID, manifestSha256: manifestHash });
  delete h.adapters.createRecoveryCoordinator;
  const green = await fixture.dependencies.checkInitialChecks({});
  h.adapters.discovery = { async discoverWorkflowRuns() { return { status: 'discovered', runs: green.runs.map(({ workflowId, runId, runAttempt, headSha }) => ({ workflowId, runId, runAttempt, headSha, branch: fixture.branch })) }; } };
  h.adapters.checks = { async readChecks() { h.state.calls.push(['draftChecks']); return structuredClone(green); } };
  h.store.getRun = async () => structuredClone(h.state.run);
  h.store.putIntent = async (_lease, intent) => {
    h.state.pendingOperation = { operationId: randomUUID(), ...structuredClone(intent) };
    h.state.phase.pendingOperationId = h.state.pendingOperation.operationId;
    return { status: 'created', operation: structuredClone(h.state.pendingOperation) };
  };
  h.store.fenceIntent = async () => ({ status: 'owned', decision: 'execute' });
  h.store.confirmIntent = async (_lease, _intent, proof) => {
    Object.assign(h.state.run, { state: 'waiting_review', pullRequestNumber: proof.prNumber });
    h.state.pendingOperation = null; h.state.phase.pendingOperationId = null;
    h.state.phase.waitStartedAt = new Date().toISOString();
    return true;
  };
  return { ...h, fixture };
}
