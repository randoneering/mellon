// Scripted journal, immutable file reads, and synthetic future Qodo only. No database.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createAgentWorker } from '../../../src/automation/worker/agent.mjs';
import { normalizeModelCallOutcome } from '../../../src/automation/worker/budgets.mjs';
import { buildCoordinatorPhaseKey, validateCoordinatorPhase, validateIntent, validateCheckpoint, validateFinishInput, validateBeginRepairInput } from '../../../src/automation/worker/store-validation.mjs';
import { candidateInput, hash, canonical, blob, SOURCE, PATH } from '../worker-candidates/inputs.mjs';

export function delivery(id = randomUUID()) {
  return { invocationId: id, type: 'schedule', trigger: { type: 'schedule', id: 'trusted-trigger', name: 'issueworkertick' }, data: { scheduledAt: new Date().toISOString() } };
}
export async function harness() {
  const input = candidateInput();
  const manifest = input.approvedManifest;
  const bundle = JSON.parse(await readFile(new URL('../../../automation/policy/manifest.json', import.meta.url), 'utf8'));
  const descriptor = source => ({ ...source, hash: source.sha256 });
  const policyManifest = { enabled: true, pilot: { repository: manifest.repository.name, issueNumber: manifest.issue.number }, trustedSources: {
    policy: descriptor(bundle.policy), projectRules: descriptor(bundle.projectRules), guidance: descriptor(bundle.guidance),
    skills: bundle.skills.map(skill => ({ ...descriptor(skill), references: skill.references.map(descriptor) })),
  } };
  const files = structuredClone(input.baseFiles);
  const state = { calls: [], seen: new Set(), modelRequests: 0, contexts: [], publications: [], stops: [], checkStatus: 'waiting', reviewStatus: 'waiting', approvalReason: null,
    run: { runId: input.publicationRun.id, jobId: randomUUID(), repositoryId: manifest.repository.id, repositoryFullName: manifest.repository.name, issueId: manifest.issue.id, issueNumber: manifest.issue.number, actorId: manifest.approver.id,
      manifestHash: hash(canonical(manifest)), baseRevision: manifest.base.revision, policyRevision: manifest.policyRevision, limits: manifest.limits, generation: 1, repairCycleCount: 0, state: 'claimed', expectedHeadSha: null, branchName: null, pullRequestNumber: null, terminalAt: null },
    phase: null, modelOperation: null, pendingOperation: null, files,
  };
  function applyEvidence(evidence) {
    if (!evidence) return;
    state.run.lastCheckRunId = evidence.checkRunId;
    state.run.checkEvidence = structuredClone(evidence);
    if (state.phase) state.phase.priorCheckRunId = evidence.checkRunId;
    if (evidence.reviewId !== null) {
      state.run.reviewHeadSha = evidence.headSha;
      if (state.phase) state.phase.priorReviewId = evidence.reviewId;
    }
  }
  const store = {
    async claimTick(request, options) {
      state.calls.push(['claimTick', request, options]);
      if (state.claimHook) return state.claimHook(request, options);
      if (state.seen.has(request.invocationId)) return { status: 'busy' };
      state.seen.add(request.invocationId);
      if (state.run.terminalAt) return { status: 'idle' };
      const startedAt = Date.now();
      state.deadline = startedAt + 85000;
      state.outerDeadline = startedAt + 90000;
      state.lease = { runId: state.run.runId, jobId: state.run.jobId, repositoryId: state.run.repositoryId, repositoryFullName: state.run.repositoryFullName, issueId: state.run.issueId, issueNumber: state.run.issueNumber, actorId: state.run.actorId, generation: state.run.generation, token: randomUUID(), expiresAt: new Date(Date.now() + 180000).toISOString() };
      return { status: 'claimed', lease: state.lease, deadline: state.deadline };
    },
    async getCoordinatorSnapshot(lease, options) {
      state.calls.push(['snapshot', options]);
      if (state.snapshotHook) await state.snapshotHook();
      return structuredClone({ status: 'owned', run: state.run, phase: state.phase, modelOperation: state.modelOperation, pendingOperation: state.pendingOperation });
    },
    async checkpoint(lease, change, options) {
      state.calls.push(['checkpoint', change, options]);
      validateCheckpoint(change);
      const phase = validateCoordinatorPhase(change.coordinator);
      if (state.checkpointHook) await state.checkpointHook(change);
      const same = state.phase?.key === phase.key;
      if (same) assert.equal(phase.headSha, state.phase.headSha);
      state.phase = { ...phase, startedAt: same ? state.phase.startedAt : new Date().toISOString(), waitStartedAt: same ? state.phase.waitStartedAt : change.state === 'waiting_review' ? new Date().toISOString() : null, pendingOperationId: null };
      if (!same) state.modelOperation = null;
      Object.assign(state.run, { state: change.state });
      applyEvidence(change.evidence);
      return true;
    },
    async reserveModelCall(lease, request, options) {
      state.calls.push(['reserveModelCall', request, options]);
      if (state.reserveHook) return state.reserveHook(request, options);
      assert.equal(state.modelOperation, null);
      assert.equal(request.expectedHeadSha, state.phase.headSha);
      const operationId = randomUUID();
      state.modelOperation = { operationId, outcome: null };
      return { status: 'reserved', canExecute: true, operationId, inputTokens: request.inputTokens, outputTokens: request.outputTokens, deadlineAt: new Date(Date.now() + 40000).toISOString() };
    },
    async putIntent(lease, intent, options) {
      state.calls.push(['putIntent', options]);
      return { status: 'created' };
    },
    async fenceIntent(lease, intent, phase, options) {
      state.calls.push(['fenceIntent', options]);
      return { status: 'owned', decision: 'create' };
    },
    async confirmIntent(lease, intent, proof, options) {
      state.calls.push(['confirmIntent', options]);
      return true;
    },
    async recordModelCallOutcome(lease, outcome, options) {
      state.calls.push(['recordModelCallOutcome', outcome, options]);
      if (state.outcomeHook) return state.outcomeHook(outcome);
      const { operationId: _operationId, ...value } = outcome;
      const normalized = normalizeModelCallOutcome(value);
      state.modelOperation.outcome = normalized.outcome;
      return { status: normalized.blockerCode ? 'needs_attention' : 'recorded', ...normalized };
    },
    async finishRun(lease, status, terminal, options) {
      state.calls.push(['finishRun', status, terminal, options]);
      validateFinishInput(status, terminal);
      if (status === 'ready_for_human' && !terminal.evidence) return false;
      if (state.finishHook) return state.finishHook();
      state.stops.push(terminal.blockerCode);
      applyEvidence(terminal.evidence);
      state.run.state = status; state.run.terminalAt = new Date().toISOString();
      return true;
    },
    async beginRepair(lease, request, options) {
      state.calls.push(['beginRepair', request, options]);
      validateBeginRepairInput(request);
      applyEvidence(request.evidence);
      if (state.run.repairCycleCount >= 2) return { status: 'needs_attention', canRepair: false, blockerCode: 'repair_cycle_limit' };
      const repairCycle = ++state.run.repairCycleCount;
      state.phase = { ...state.phase, purpose: 'repair_investigation', repairCycle, headSha: request.headSha, findingSha256: request.findingSha256, findingSource: request.source, findingHeadSha: request.headSha, waitStartedAt: null, pendingOperationId: null };
      state.phase.key = buildCoordinatorPhaseKey({ ...state.phase, runId: state.run.runId, manifestSha256: state.run.manifestHash });
      state.run.state = 'repairing'; state.modelOperation = null;
      return { status: 'reserved', canRepair: true, repairCycleCount: repairCycle, phaseKey: state.phase.key };
    },
  };
  const api = async (url, options) => {
    state.calls.push(['approvalHTTP', new URL(url).pathname]);
    assert.equal(new URL(url).origin, 'https://api.github.com');
    assert.ok(options.signal);
    const root = '/repos/randoneering/mellon';
    const routes = {
      [root]: { id: manifest.repository.id, full_name: manifest.repository.name, private: false },
      [`${root}/issues/22`]: { id: manifest.issue.id, number: 22, repository_url: `https://api.github.com${root}`, state: state.approvalReason === 'issue_not_open' ? 'closed' : 'open', title: 'approved title', body: 'approved body' },
      [`${root}/issues/22/labels`]: state.approvalReason === 'readiness_label_missing' ? [] : [{ name: 'agent: ready' }],
      '/users/maintainer': { id: 42, login: 'maintainer', type: 'User' },
      [`${root}/collaborators/maintainer/permission`]: { permission: 'write', user: { id: 42, login: 'maintainer', type: 'User' } },
      [`${root}/branches/main`]: { name: 'main', commit: { sha: manifest.base.revision } },
    };
    if (state.approvalHook) await state.approvalHook();
    if (state.approvalReason === 'unavailable') throw new Error('private transport failure');
    const data = routes[new URL(url).pathname];
    if (!data) throw new Error('Unscripted approval URL');
    return Response.json(data);
  };
  const projection = { repository: manifest.repository, requiredChecks: manifest.requiredChecks, requiredWorkflowIdentities: manifest.requiredWorkflowIdentities };
  function checksResult(status) {
    const check = { checkRunId: 811, checkSuiteId: 810, appId: 2000,
      status: 'completed', conclusion: ['intended_red', 'failure'].includes(status) ? 'failure' : 'success',
      headSha: state.run.expectedHeadSha };
    const report = { ...check, checkRunId: 812, conclusion: 'success' };
    const checks = [check, report];
    return { status, repositoryId: manifest.repository.id, headSha: state.run.expectedHeadSha,
      branch: state.run.branchName, event: 'push', checks,
      runs: [{ workflowId: 3000, runId: 800, runAttempt: 1, headSha: state.run.expectedHeadSha,
        checks: [...checks] }], runId: 800, runAttempt: 1,
      ...(status === 'failure' ? { findingSha256: hash(canonical({ head: state.run.expectedHeadSha })),
        evidence: { assertions: [{ workflowId: 3000, runId: 800, runAttempt: 1,
          category: 'assertion', testIdentitySha256: state.phase.expectedRegression.testIdentitySha256,
          producerSha256: '1'.repeat(64), formatterRevision: '2'.repeat(40), reportSha256: '3'.repeat(64) }] } } : {}) };
  }
  const repository = {
    async readIssue() { state.calls.push(['issue']); return { title: 'approved title', body: 'approved body' }; },
    async readTrustedFile(request) {
      state.calls.push(['policy', request.revision, request.path]);
      return readFile(new URL(`../../../${request.path}`, import.meta.url), 'utf8');
    },
    async readPreparedFiles(request) { state.calls.push(['files', request.revision]); if (state.filesHook) await state.filesHook(); return structuredClone(files); },
    async reconstructCandidate(request) { state.calls.push(['reconstruct', request]); if (state.reconstructHook) return state.reconstructHook(request); throw new Error('No observed remote effect'); },
  };
  const adapters = {
    repository,
    discovery: { async discoverWorkflowRuns(request) { assert.deepEqual(request.manifest, projection); state.calls.push(['discover', request.headSha]); return { status: 'discovered', runs: [{ workflowId: 3000, headSha: request.headSha, branch: request.branch, runId: 800, runAttempt: 1 }] }; } },
    checks: { async readChecks(request) { assert.deepEqual(request.manifest, projection); state.calls.push(['checks', request]); if (state.checkHook) return state.checkHook(request); return checksResult(state.checkStatus); }, async readFailure(request) { state.calls.push(['failure', request]); return checksResult(state.failureStatus ?? 'failure'); } },
    review: { async readReview(request) { state.calls.push(['review', request]); return state.reviewResult ?? { status: 'waiting' }; } },
    createAgentWorker(options) {
      return createAgentWorker({ ...options, loadContext: async () => { const context = await options.loadContext(); state.contexts.push(context); return context; } });
    },
    createRecoveryCoordinator({ store }) {
      return { async perform(request) {
        state.calls.push(['recovery', request]);
        if (state.recoveryStoreProbe) await state.recoveryStoreProbe({ request, store });
        assert.equal(request.deadline, Math.min(state.deadline, state.outerDeadline) - 10_000);
        validateIntent(request.intent);
        if (state.recoveryHook) return state.recoveryHook(request);
        state.publications.push(structuredClone(request));
        if (request.intent.kind === 'commit_create') {
          assert.equal(request.intent.coordinator.modelOperationId, state.modelOperation.operationId);
          for (const change of request.publication.proposedChanges) {
            const file = files.find(file => file.path === change.path);
            Object.assign(file, { mode: '100644', text: change.content, blobSha: blob(change.content), sha256: hash(change.content) });
          }
          state.phase.expectedRegression = request.intent.coordinator.expectedRegression;
          state.phase.criterionSha256 = request.intent.coordinator.criterionSha256;
          state.run.expectedHeadSha = String(state.publications.length).repeat(40);
          state.run.branchName = `agent-work/${state.run.runId}`;
          state.run.state = state.phase.purpose.endsWith('_tests') ? 'waiting_red_ci' : 'waiting_ci';
        } else { state.run.pullRequestNumber = 77; state.run.state = 'waiting_review'; }
        state.phase.waitStartedAt ??= new Date().toISOString();
        state.pendingOperation = null;
        return { status: 'confirmed', persisted: true };
      } };
    },
  };
  const model = {
    config: { gateway: { baseURL: 'https://gateway.example', apiKey: 'synthetic-private-key' }, modelId: manifest.model.id },
    tokenizer: { modelId: manifest.model.id, renderer: 'neon-chat-v1', countRendered: () => 500 },
    sdk: { model: {}, async generateText(options) {
      state.modelRequests += 1;
      if (state.modelHook) return state.modelHook(options);
      const context = state.contexts.at(-1);
      const testing = state.phase.purpose.endsWith('_tests');
      const path = testing ? PATH : 'src/parser.mjs';
      const file = files.find(file => file.path === path);
      const name = state.phase.repairCycle ? manifest.coordinator.regression.repairTestNames[state.phase.repairCycle - 1] : manifest.coordinator.regression.initial.testName;
      const content = testing ? SOURCE.replace('approved regression location', name) : `export const fixed = ${state.phase.repairCycle + 1};`;
      const changes = [{ operation: file.mode === null ? 'create' : 'modify', path, content, ...(file.mode === null ? {} : { expectedBlobSha: file.blobSha }) }];
      const investigation = context.investigation;
      const assessment = investigation && { disposition: state.disposition ?? 'confirmed', findingSha256: investigation.findingSha256, ...investigation.criteria[state.assessmentCriterionIndex ?? 0], references: investigation.references };
      const receipt = await options.tools.proposeChanges.execute({ baseSha: context.repository.baseSha, manifestHash: context.manifest.hash, changes: assessment && assessment.disposition !== 'confirmed' ? [] : changes, ...(assessment ? { assessment } : {}) });
      assert.ok(['proposed', 'assessed'].includes(receipt.status), JSON.stringify(receipt));
      return { text: '', steps: [], usage: { inputTokens: 100, outputTokens: 20 }, response: { body: { usage: { prompt_tokens: 100, completion_tokens: 20 } } }, finishReason: 'stop' };
    } },
  };
  return { state, store, manifest, adapters, model, dependencies: { store, manifest, expectedManifestSha256: hash(canonical(manifest)), policyManifest, triggerId: 'trusted-trigger', readToken: 'synthetic-token', fetch: api, model, adapters, publicationDependencies: {} }, checksResult };
}

// No production Qodo parser recognizes this synthetic future adapter result.
export function syntheticFutureReview(state, findings = []) {
  return { status: 'complete', authenticated: true, repository: state.run.repositoryFullName, repositoryId: state.run.repositoryId, pullNumber: state.run.pullRequestNumber, headSha: state.run.expectedHeadSha, draft: true, state: 'open', reviewId: 900, findings };
}
