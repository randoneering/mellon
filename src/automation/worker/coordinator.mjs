import { createHash } from 'node:crypto';
import { parse } from 'acorn';
import { createAgentWorker } from './agent.mjs';
import { checkApproval, validateCoordinatorConfig } from './approval.mjs';
import { prepareCandidate } from './candidate.mjs';
import { createCheckReader } from './checks.mjs';
import { createWorkflowDiscovery } from './discovery.mjs';
import { loadPolicy } from './policy.mjs';
import { buildDraftPrOperationHash, deriveBranchName, gitBlobSha,
  snapshotDraftPrRequest, validateApprovalResult } from './publication-validation.mjs';
import { createRecoveryCoordinator } from './recovery.mjs';
import { createRepositoryReader } from './repository.mjs';
import { createReviewReader } from './review.mjs';
import { createTrustedReviewRequestPublisher } from './review-request-publisher.mjs';
import { SOL_MODEL_PROFILE, validManifestModel } from './model-profile.mjs';
import { CONSERVATIVE_INPUT_MODE } from './input-budget.mjs';
import { buildCoordinatorPhaseKey, createWaitDeadline, validateClaimInput,
  validateCoordinatorPhase, validateIntent } from './store-validation.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const SHA256 = /^[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const REVOCATIONS = new Set(['readiness_label_missing', 'approver_permission_missing', 'issue_not_open']);
const MODEL_STATES = new Set(['generating_tests', 'implementing', 'repairing']);
const WAIT_STATES = new Set(['waiting_red_ci', 'waiting_ci', 'waiting_review']);
const MODEL_CALL_CEILING_MS = 45_000;
const MIN_MODEL_WINDOW_MS = 30_000;
const POST_RESERVATION_AUTH_MS = 10_000;
const MODEL_OUTCOME_WINDOW_MS = 5_000;
const POST_MODEL_AUTH_MS = 10_000;
const PUBLICATION_WINDOW_MS = 8_000;
const PUBLICATION_ADMISSION_MS = 8_000;
const FINALIZATION_GRACE_MS = 10_000;
const PHASE_FIELDS = ['version', 'purpose', 'key', 'repairCycle', 'headSha', 'findingSha256',
  'expectedRegression', 'criterionSha256', 'findingSource', 'findingHeadSha', 'priorCheckRunId', 'priorReviewId'];
const result = (status, reason, persisted = false, diagnostics, reviewDiagnostics) => Object.freeze({ status,
  ...(reason ? { reason } : {}), persisted, ...(diagnostics ? { diagnostics } : {}),
  ...(reviewDiagnostics ? { reviewDiagnostics: Object.freeze({ ...reviewDiagnostics }) } : {}) });
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
class Stop extends Error {
  constructor(reason = 'coordinator_journal_conflict', status = 'needs_attention') {
    super('Coordinator stopped.'); this.reason = reason; this.status = status;
  }
}
function stop(reason, status) { throw new Stop(reason, status); }
function safeAgentDiagnostics(value) {
  const categories = new Set(['model_failure', 'prose_only', 'read_only', 'rejected_proposal',
    'valid_proposal', 'assessment_only']);
  const names = ['readFile', 'listFiles', 'proposeChanges'];
  if (!value || typeof value !== 'object' || !categories.has(value.proposalCategory)) return null;
  const toolCounts = {};
  for (const name of names) {
    const count = value.toolCounts?.[name];
    if (Number.isSafeInteger(count) && count >= 0 && count <= 16) toolCounts[name] = count;
  }
  const rejections = new Set(['schema', 'binding', 'scope', 'validation', 'duplicate', 'assessment', 'deadline']);
  return Object.freeze({ proposalCategory: value.proposalCategory,
    ...(rejections.has(value.proposalRejection) ? { proposalRejection: value.proposalRejection } : {}),
    toolCounts: Object.freeze(toolCounts) });
}
function phaseInput(phase) {
  return validateCoordinatorPhase(Object.fromEntries(PHASE_FIELDS.filter(key => Object.hasOwn(phase, key)).map(key => [key, phase[key]])));
}
function intentInput(operation) {
  return validateIntent(Object.fromEntries(['key', 'kind', 'inputHash', 'expectedHeadSha', 'coordinator'].filter(key => Object.hasOwn(operation, key)).map(key => [key, operation[key]])));
}
function validDelivery(value, triggerId) {
  return exact(value, ['invocationId', 'type', 'trigger', 'data']) && ID.test(value.invocationId ?? '')
    && value.type === 'schedule' && exact(value.trigger, ['id', 'type', 'name'])
    && value.trigger.id === triggerId && value.trigger.type === 'schedule' && value.trigger.name === 'issueworkertick'
    && exact(value.data, ['scheduledAt']) && typeof value.data.scheduledAt === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.data.scheduledAt)
    && Number.isFinite(Date.parse(value.data.scheduledAt));
}
function publicationRun(run, manifest) {
  return { id: run.runId, repositoryId: run.repositoryId, issueId: run.issueId, issueNumber: run.issueNumber,
    approverId: manifest.approver.id, manifestSha256: run.manifestHash, baseSha: run.baseRevision,
    expectedHeadSha: run.expectedHeadSha ?? run.baseRevision, generation: run.generation };
}
function boundRun(run, lease, claim) {
  return run && run.runId === lease.runId && run.jobId === lease.jobId && run.generation === lease.generation
    && ['repositoryId', 'repositoryFullName', 'issueId', 'issueNumber', 'actorId'].every(key => run[key] === claim[key] && lease[key] === claim[key])
    && run.manifestHash === claim.manifestHash && run.baseRevision === claim.baseRevision && run.policyRevision === claim.policyRevision
    && canonical(run.limits) === canonical(claim.limits) && !run.terminalAt;
}
function checkedHead(value, run) {
  return value?.repositoryId === run.repositoryId && value.headSha === run.expectedHeadSha
    && value.branch === deriveBranchName(run.runId) && value.event === 'push';
}
function projectedChanges(changes) {
  if (!Array.isArray(changes) || !changes.length) stop('coordinator_candidate_lost');
  return changes.map(change => {
    if (!exact(change, ['operation', 'path', 'content', 'mode', 'expectedBlobSha', 'contentBytes', 'contentBlobSha'])
      || change.mode !== '100644' || typeof change.content !== 'string'
      || change.contentBytes !== Buffer.byteLength(change.content) || change.contentBlobSha !== gitBlobSha(change.content)
      || !['create', 'modify'].includes(change.operation)
      || (change.operation === 'create' ? change.expectedBlobSha !== null : !SHA1.test(change.expectedBlobSha ?? ''))) stop();
    return { operation: change.operation, path: change.path, content: change.content,
      ...(change.operation === 'modify' ? { expectedBlobSha: change.expectedBlobSha } : {}) };
  });
}

// This only associates authenticated native hashes with immutable files. It executes no code.
function assertionReferences(assertions, files, manifest) {
  if (!Array.isArray(assertions) || !assertions.length || assertions.length > 64) stop();
  const identities = new Map();
  files.forEach((file, fileIndex) => {
    if (file.mode !== '100644' || !manifest.allowedPaths.includes(file.path) || !file.path.endsWith('.test.mjs')) return;
    const tree = parse(file.text, { ecmaVersion: 2024, sourceType: 'module', locations: true, preserveParens: true });
    const imports = tree.body.filter(node => node.type === 'ImportDeclaration' && node.source.value === 'node:test');
    if (imports.length !== 1 || imports[0].specifiers.length !== 1) return;
    const specifier = imports[0].specifiers[0];
    if (specifier.local.name !== 'test' || !['ImportDefaultSpecifier', 'ImportSpecifier'].includes(specifier.type)
      || specifier.type === 'ImportSpecifier' && specifier.imported.name !== 'test') return;
    for (const statement of tree.body) {
      const call = statement.type === 'ExpressionStatement' ? statement.expression : null;
      if (call?.type !== 'CallExpression' || call.callee.type !== 'Identifier' || call.callee.name !== 'test'
        || call.arguments.length !== 2 || call.arguments[0].type !== 'Literal' || typeof call.arguments[0].value !== 'string'
        || !['ArrowFunctionExpression', 'FunctionExpression'].includes(call.arguments[1].type)
        || call.arguments[1].body.type !== 'BlockStatement') continue;
      const identity = hash(canonical({ column: call.loc.start.column + 1, entryFile: file.path,
        line: call.loc.start.line, name: call.arguments[0].value, nesting: 0, type: 'test' }));
      if (identities.has(identity)) stop();
      identities.set(identity, { fileIndex, blobSha: file.blobSha, testIdentitySha256: identity });
    }
  });
  const references = [];
  for (const assertion of assertions) {
    if (!exact(assertion, ['workflowId', 'runId', 'runAttempt', 'testIdentitySha256', 'category', 'producerSha256', 'formatterRevision', 'reportSha256'])
      || assertion.category !== 'assertion' || assertion.runAttempt !== 1
      || !Number.isSafeInteger(assertion.runId) || assertion.runId < 1
      || !manifest.requiredWorkflowIdentities.some(identity => identity.id === assertion.workflowId)
      || !SHA256.test(assertion.producerSha256 ?? '') || !SHA256.test(assertion.reportSha256 ?? '')
      || !SHA1.test(assertion.formatterRevision ?? '')) stop();
    const reference = identities.get(assertion.testIdentitySha256);
    if (!reference) stop();
    if (!references.some(item => canonical(item) === canonical(reference))) references.push(reference);
  }
  if (references.length > 16) stop();
  return references;
}

/** Compose one bounded phase from private, configured Function dependencies. */
export function createCoordinator(dependencies = {}) {
  const { store, readToken, fetch = globalThis.fetch } = dependencies;
  const publicationDependencies = { ...dependencies.publicationDependencies };
  let manifest, policyManifest, claimManifest, model;
  const timeoutMs = dependencies.timeoutMs ?? 90000;
  const triggerId = dependencies.triggerId;
  try {
    manifest = freeze(structuredClone(dependencies.manifest));
    policyManifest = freeze(structuredClone(dependencies.policyManifest));
    model = { ...dependencies.model, config: freeze(structuredClone(dependencies.model?.config)) };
    if (!manifest?.coordinator || !validateCoordinatorConfig(manifest) || manifest.approved !== true
      || !SHA256.test(dependencies.expectedManifestSha256 ?? '')
      || hash(canonical(manifest)) !== dependencies.expectedManifestSha256
      || !ID.test(triggerId ?? '') || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 90000
      || dependencies.deadline !== undefined && !Number.isSafeInteger(dependencies.deadline)
      || typeof readToken !== 'string' || !readToken.length || typeof fetch !== 'function'
      || policyManifest?.enabled !== true || policyManifest.pilot?.repository !== manifest.repository.name
      || policyManifest.pilot.issueNumber !== manifest.issue.number
      || !validManifestModel(manifest.model)
      || model?.config?.modelId !== manifest.model.id
      || (manifest.model.id === SOL_MODEL_PROFILE.id
        && (model.config.reasoningEffort !== manifest.model.reasoningEffort
          || model.config.inputAdmission !== manifest.model.inputAdmission
          || (manifest.model.inputAdmission !== CONSERVATIVE_INPUT_MODE
            && (model.tokenizer?.modelId !== manifest.model.id
              || model.tokenizer?.renderer !== manifest.model.renderer
              || model.tokenizer?.reasoningEffort !== manifest.model.reasoningEffort
              || typeof model.tokenizer?.countRendered !== 'function'))))) throw new Error();
    claimManifest = freeze(validateClaimInput({ invocationId: 'configuration', manifest: {
      repositoryId: manifest.repository.id, repositoryFullName: manifest.repository.name,
      issueId: manifest.issue.id, issueNumber: manifest.issue.number, actorId: manifest.approver.id,
      manifestHash: dependencies.expectedManifestSha256, baseRevision: manifest.base.revision,
      policyRevision: manifest.policyRevision, limits: manifest.limits,
    } }).manifest);
    for (const method of ['claimTick', 'getCoordinatorSnapshot', 'checkpoint', 'reserveModelCall', 'recordModelCallOutcome', 'finishRun', 'beginRepair']) {
      if (typeof store?.[method] !== 'function') throw new Error();
    }
    if (!dependencies.adapters?.createRecoveryCoordinator) {
      for (const method of ['getRun', 'putIntent', 'fenceIntent', 'confirmIntent']) {
        if (typeof store[method] !== 'function') throw new Error();
      }
      if (typeof publicationDependencies.getPublicationContext !== 'function') throw new Error();
    }
    if (!dependencies.adapters?.repository && (!Number.isSafeInteger(dependencies.ownedActor?.databaseId)
      || dependencies.ownedActor.databaseId < 1 || typeof dependencies.ownedActor.login !== 'string'
      || !dependencies.ownedActor.login.length)) throw new Error();
  } catch { throw new TypeError('Coordinator configuration rejected.'); }
  const adapters = { ...dependencies.adapters };
  const expectedManifestSha256 = claimManifest.manifestHash;
  const checkManifest = freeze({ repository: manifest.repository, requiredChecks: manifest.requiredChecks, requiredWorkflowIdentities: manifest.requiredWorkflowIdentities });
  const sources = policyManifest.trustedSources;
  const descriptors = [sources.policy, sources.projectRules, sources.guidance,
    ...sources.skills.flatMap(skill => [skill, ...skill.references])];
  const repositoryConfiguration = { token: readToken, fetch, repository: manifest.repository.name,
    repositoryId: manifest.repository.id, policyRevision: manifest.policyRevision,
    trustedPaths: descriptors.map(source => ({ path: source.path, sha256: source.hash })),
    ownedActor: dependencies.ownedActor ? freeze(structuredClone(dependencies.ownedActor)) : undefined };
  const repository = adapters.repository ?? createRepositoryReader(repositoryConfiguration);
  const discovery = adapters.discovery ?? createWorkflowDiscovery(repositoryConfiguration);
  const review = adapters.review ?? createReviewReader({ token: readToken, repositoryId: manifest.repository.id, fetch });
  const reviewRequestPublisher = adapters.reviewRequestPublisher ?? createTrustedReviewRequestPublisher({
    getPullRequestContext: publicationDependencies.getPullRequestContext,
    fetch: publicationDependencies.fetch ?? fetch,
  });

  async function advanceTick(delivery) {
    const budget = createWaitDeadline(timeoutMs, dependencies.deadline ?? Infinity);
    const trustedFileSession = typeof repository.createTrustedReadSession === 'function'
      ? repository.createTrustedReadSession() : null;
    let lease, claimedDeadline, finalizationDeadline, publicationDeadline, outcomeDeadline,
      modelDeadline, modelAdmissionDeadline, snapshot, terminalResult, databaseUncertain = false,
      agentDiagnostics = null, reviewDiagnostics, modelUsage = null, modelOperationId = null,
      knownIntent = null, stageFailure = null, activeDatabaseWrites = 0;
    function checkDeadline(deadline) {
      if (!Number.isSafeInteger(deadline) || Date.now() >= deadline) {
        stageFailure = new Stop('recovery_deadline');
        throw stageFailure;
      }
    }
    async function waitUntil(deadline, operation) {
      checkDeadline(deadline);
      const stage = createWaitDeadline(Math.max(1, deadline - Date.now()), deadline);
      const abortStage = () => stage.close();
      budget.signal.addEventListener('abort', abortStage, { once: true });
      try { return await stage.wait(operation); }
      catch (error) {
        if (stage.isExpired()) {
          if (deadline === finalizationDeadline) budget.close();
          stageFailure = new Stop('recovery_deadline');
          throw stageFailure;
        }
        throw error;
      } finally { budget.signal.removeEventListener('abort', abortStage); stage.close(); }
    }
    async function database(operation, deadline = finalizationDeadline ?? budget.deadline,
      { readOnly = false } = {}) {
      if (databaseUncertain || terminalResult) stop('recovery_database_uncertain');
      checkDeadline(deadline);
      let started = false;
      try {
        return await waitUntil(deadline, () => {
          checkDeadline(deadline);
          started = true;
          if (!readOnly) activeDatabaseWrites += 1;
          return operation({ deadline });
        });
      } catch (error) {
        if (readOnly || !started) {
          stageFailure = error instanceof Stop ? error : new Stop('coordinator_journal_conflict');
          throw stageFailure;
        }
        databaseUncertain = true;
        stop('recovery_database_uncertain');
      } finally {
        if (started && !readOnly) activeDatabaseWrites -= 1;
      }
    }
    async function owned(deadline = finalizationDeadline ?? budget.deadline) {
      const value = await database(options => store.getCoordinatorSnapshot(lease, options), deadline,
        { readOnly: true });
      if (value?.status !== 'owned') stop('recovery_lease_lost');
      if (!boundRun(value.run, lease, claimManifest)) stop();
      if (snapshot?.phase && value.phase?.key !== snapshot.phase.key) stop('recovery_lease_lost');
      return value;
    }
    function checkWait() {
      if (!snapshot || !WAIT_STATES.has(snapshot.run.state)) return;
      const start = Date.parse(snapshot.phase?.waitStartedAt);
      const seconds = snapshot.run.state === 'waiting_review'
        ? snapshot.run.limits.reviewWaitSeconds : snapshot.run.limits.ciWaitSeconds;
      if (!Number.isFinite(start) || start > Date.now() || Date.now() - start >= seconds * 1000) {
        stop('coordinator_wait_expired');
      }
    }
    async function trustedFile(path, deadline) {
      const source = descriptors.find(item => item.path === path);
      if (!source) stop();
      const request = { revision: manifest.policyRevision, path, deadline,
        signal: budget.signal };
      return waitUntil(deadline, () => trustedFileSession
        ? trustedFileSession.readTrustedFile(request) : repository.readTrustedFile(request));
    }
    async function fresh(deadline = finalizationDeadline ?? budget.deadline) {
      budget.check();
      checkDeadline(deadline);
      if (dependencies.isEnabled !== undefined
        && (typeof dependencies.isEnabled !== 'function' || dependencies.isEnabled() !== true)) {
        stop('recovery_approval_denied');
      }
      checkWait();
      const approval = await waitUntil(deadline, () => (adapters.checkApproval ?? checkApproval)({ manifest,
        expectedManifestSha256, token: readToken,
        fetch: (url, options) => waitUntil(deadline, () => fetch(url, { ...options,
          signal: AbortSignal.any([budget.signal, options.signal]) })),
        timeoutMs: Math.max(1, Math.min(5000, deadline - Date.now())) }));
      checkDeadline(deadline);
      checkWait();
      if (!validateApprovalResult(approval, { run: publicationRun(snapshot.run, manifest), approvedManifest: manifest })) {
        if (REVOCATIONS.has(approval?.reason)) {
          const persisted = await database(options => store.finishRun(lease, 'cancelled', {}, options));
          terminalResult = persisted ? result('cancelled', 'recovery_approval_denied', true)
            : result('needs_attention', 'recovery_lease_lost');
          stop('recovery_approval_denied', 'cancelled');
        }
        stop('recovery_approval_denied');
      }
      const policy = await waitUntil(deadline, () => (adapters.loadPolicy ?? loadPolicy)(policyManifest, {
        readTrustedFile: path => trustedFile(path, deadline),
      }));
      checkDeadline(deadline);
      checkWait();
      if (policy?.status !== 'loaded' || policy.pilot?.repository !== manifest.repository.name || policy.pilot.issueNumber !== manifest.issue.number) stop();
      const issue = await waitUntil(deadline, () => repository.readIssue({ manifest, deadline, signal: budget.signal }));
      checkDeadline(deadline);
      checkWait();
      if (!exact(issue, ['title', 'body']) || hash(JSON.stringify([issue.title, issue.body])) !== manifest.issue.contentSha256) stop();
      const current = await owned(deadline);
      checkDeadline(deadline);
      checkWait();
      if (current.run.state !== snapshot.run.state || current.phase?.key !== snapshot.phase?.key) stop('recovery_lease_lost');
      return { policy, issue, approval };
    }
    function newPhase(purpose) {
      const previous = snapshot.phase;
      const phase = { ...(previous ? phaseInput(previous) : {}), version: 1, purpose,
        repairCycle: snapshot.run.repairCycleCount, headSha: snapshot.run.expectedHeadSha ?? snapshot.run.baseRevision,
        findingSha256: previous?.findingSha256 ?? null };
      phase.key = buildCoordinatorPhaseKey({ ...phase, runId: snapshot.run.runId, manifestSha256: expectedManifestSha256 });
      return phaseInput(phase);
    }
    function evidenceFor(response, reviewId = null) {
      if (!checkedHead(response, snapshot.run) || !Array.isArray(response.runs) || !Array.isArray(response.checks)) stop();
      const workflowId = response.status === 'failure'
        ? response.evidence?.assertions?.[0]?.workflowId : manifest.coordinator.regression.workflowId;
      const matching = response.runs.filter(run => run.workflowId === workflowId);
      const required = manifest.requiredChecks.filter(check => check.workflowId === workflowId);
      const position = required.findIndex(check => check.context === 'test');
      const workflow = matching[0];
      const check = workflow?.checks?.[position];
      if (matching.length !== 1 || position < 0 || workflow.headSha !== snapshot.run.expectedHeadSha
        || !Number.isSafeInteger(workflow.runId) || workflow.runId < 1
        || !Number.isSafeInteger(workflow.runAttempt) || workflow.runAttempt < 1 || workflow.runAttempt > 1000
        || !Array.isArray(workflow.checks) || workflow.checks.length !== required.length
        || !check || !Number.isSafeInteger(check.checkRunId) || check.checkRunId < 1
        || !Number.isSafeInteger(check.checkSuiteId) || check.checkSuiteId < 1
        || check.appId !== required[position].appId || check.headSha !== snapshot.run.expectedHeadSha
        || check.status !== 'completed'
        || check.conclusion !== (response.status === 'success' ? 'success' : 'failure')
        || response.checks.filter(item => item.checkRunId === check.checkRunId
          && canonical(item) === canonical(check)).length !== 1
        || reviewId !== null && (!Number.isSafeInteger(reviewId) || reviewId < 1)) stop();
      return { headSha: snapshot.run.expectedHeadSha, workflowId, workflowRunId: workflow.runId,
        checkRunId: check.checkRunId, reviewId,
        checksSha256: hash(canonical({ repositoryId: response.repositoryId, headSha: response.headSha,
          branch: response.branch, event: response.event, runs: response.runs, checks: response.checks })) };
    }
    async function checkpoint(state, phase = snapshot.phase, evidence) {
      const next = phaseInput(phase);
      if (evidence) {
        next.priorCheckRunId = evidence.checkRunId;
        if (evidence.reviewId !== null) next.priorReviewId = evidence.reviewId;
      }
      const change = { state, coordinator: next, ...(evidence ? { evidence,
        lastCheckRunId: evidence.checkRunId,
        ...(evidence.reviewId !== null ? { reviewHeadSha: evidence.headSha } : {}) } : {}) };
      const receipt = await database(options => {
        checkWait();
        return store.checkpoint(lease, change, options);
      });
      return receipt ? result(WAIT_STATES.has(state) ? 'waiting' : 'advanced', undefined, true, undefined, reviewDiagnostics)
        : result('needs_attention', 'recovery_lease_lost', false, undefined, reviewDiagnostics);
    }
    async function checks(expectedRegression, failure = false) {
      const run = snapshot.run;
      if (!run.expectedHeadSha || run.branchName !== deriveBranchName(run.runId)) stop();
      const found = await budget.wait(() => discovery.discoverWorkflowRuns({ manifest: checkManifest,
        headSha: run.expectedHeadSha, branch: run.branchName, deadline: budget.deadline, signal: budget.signal }));
      checkWait();
      if (found?.status === 'waiting') return found;
      if (found?.status !== 'discovered') stop();
      const reader = adapters.checks ?? createCheckReader({ token: readToken, repository: manifest.repository.name,
        fetch: (url, options) => budget.wait(() => fetch(url, { ...options, signal: AbortSignal.any([budget.signal, options.signal]) })),
        timeoutMs: Math.max(1, Math.min(10000, budget.deadline - Date.now())) });
      const input = { manifest: checkManifest, runs: found.runs, ...(expectedRegression ? { expectedRegression } : {}) };
      const response = await budget.wait(() => failure ? reader.readFailure(input) : reader.readChecks(input));
      checkWait();
      if (['success', 'intended_red', 'failure'].includes(response?.status) && !checkedHead(response, run)) stop();
      return response;
    }
    function recovery() {
      // Preserve the claimed deadline on every store call made by recovery, too.
      const recoveryStore = Object.fromEntries(Object.entries({ getRun: 1, getCoordinatorSnapshot: 1,
        putIntent: 2, fenceIntent: 3, confirmIntent: 3, finishRun: 3 }).map(([name, count]) => [name,
        (...args) => {
          const requestedDeadline = args[count]?.deadline;
          const deadline = Number.isSafeInteger(requestedDeadline)
            ? Math.min(claimedDeadline ?? budget.deadline, requestedDeadline)
            : claimedDeadline ?? budget.deadline;
          return database(options => store[name](...args.slice(0, count), options), deadline,
            { readOnly: name === 'getRun' || name === 'getCoordinatorSnapshot' });
        }]));
      return (adapters.createRecoveryCoordinator ?? createRecoveryCoordinator)({ store: recoveryStore, publicationDependencies: {
        ...publicationDependencies,
        fetch: (url, options) => budget.wait(() => (publicationDependencies.fetch ?? fetch)(url, { ...options, signal: AbortSignal.any([budget.signal, options.signal]) })),
        async checkApproval() { return (await fresh(publicationDeadline)).approval; },
        async checkInitialChecks() { await fresh(publicationDeadline); return checks(); },
      }, finalizationDeadline });
    }
    function publicationDiagnostics(reason, intent, effectCategory) {
      return Object.freeze({ stage: 'publication', category: reason,
        ...(typeof effectCategory === 'string' ? { effectCategory } : {}),
        ...(agentDiagnostics ? { proposalCategory: agentDiagnostics.proposalCategory } : {}),
        ...(modelOperationId ? { modelOperationId } : {}),
        ...(modelUsage ? { actualInputTokens: modelUsage.inputTokens,
          actualOutputTokens: modelUsage.outputTokens } : {}),
        ...(intent ? { candidateOperationId: intent.key,
          effectOperationId: intent.key } : {}) });
    }
    async function publish(intent, publication) {
      knownIntent = intent;
      await fresh(publicationDeadline);
      if (publicationDeadline - Date.now() < PUBLICATION_ADMISSION_MS) {
        stop('recovery_deadline');
      }
      let outcome, recoveryStarted = false;
      try {
        outcome = await waitUntil(finalizationDeadline, () => {
          recoveryStarted = true;
          return recovery().perform({ lease, deadline: publicationDeadline, intent, publication });
        });
      } catch (error) {
        if (terminalResult) return terminalResult;
        if (error instanceof Stop && error.reason === 'recovery_deadline' && !databaseUncertain
          && activeDatabaseWrites === 0
          && (!recoveryStarted || !adapters.createRecoveryCoordinator)) throw error;
        // A rejected custom recovery or an uncertain write cannot authorize finalization.
        return result('needs_attention', 'recovery_database_uncertain', false,
          publicationDiagnostics('recovery_database_uncertain', intent));
      }
      if (terminalResult) return terminalResult;
      if (databaseUncertain) return result('needs_attention', 'recovery_database_uncertain', false,
        publicationDiagnostics('recovery_database_uncertain', intent));
      if (outcome?.status !== 'confirmed' || outcome.persisted !== true) {
        const allowed = new Set(['recovery_database_uncertain', 'recovery_effect_unconfirmed', 'recovery_conflict',
          'recovery_approval_denied', 'recovery_lease_lost', 'recovery_deadline', 'recovery_unsupported_effect',
          'recovery_invalid_input', 'coordinator_journal_conflict', 'coordinator_model_uncertain']);
        const reason = allowed.has(outcome?.reason) ? outcome.reason : 'recovery_effect_unconfirmed';
        return result('needs_attention', reason, outcome?.persisted === true,
          publicationDiagnostics(reason, intent, outcome?.effectCategory));
      }
      snapshot = await owned(finalizationDeadline);
      if (snapshot.pendingOperation || !WAIT_STATES.has(snapshot.run.state)) stop();
      const released = await checkpoint(snapshot.run.state);
      return released.persisted ? result('advanced', undefined, true) : released;
    }
    async function pending() {
      const intent = intentInput(snapshot.pendingOperation);
      if (!snapshot.phase || snapshot.phase.pendingOperationId !== snapshot.pendingOperation.operationId
        || intent.coordinator?.phaseKey !== snapshot.phase.key) stop();
      const run = publicationRun(snapshot.run, manifest);
      if (intent.kind === 'pr_create') {
        const publication = snapshotDraftPrRequest({ run, intent: { id: intent.key, kind: 'pr_create' }, approvedManifest: manifest });
        if (buildDraftPrOperationHash(publication) !== intent.inputHash) stop();
        return publish(intent, publication);
      }
      if (intent.kind !== 'commit_create') stop();
      let recovered;
      try {
        recovered = await budget.wait(() => repository.reconstructCandidate({ publication: { run,
          intent: { id: intent.key }, approvedManifest: manifest }, metadata: intent.coordinator,
        deadline: budget.deadline, signal: budget.signal }));
      } catch { stop('recovery_effect_unconfirmed'); }
      if (!recovered || canonical(intentInput(recovered.intent)) !== canonical(intent)
        || recovered.operationHash !== intent.inputHash || !SHA1.test(recovered.observedHeadSha ?? '')
        || recovered.publication?.intent?.id !== intent.key) stop();
      return publish(intent, recovered.publication);
    }
    async function prepared(deadline = finalizationDeadline ?? budget.deadline) {
      return waitUntil(deadline, () => repository.readPreparedFiles({
        revision: snapshot.run.expectedHeadSha ?? snapshot.run.baseRevision,
        allowedPaths: manifest.allowedPaths, deadline, signal: budget.signal }));
    }
    function reviewBinding(value) {
      const run = snapshot.run;
      if (exact(value, ['status', 'authenticated', 'repository', 'repositoryId', 'pullNumber', 'headSha', 'draft', 'state', 'reviewId', 'findings'])) {
        return value.status === 'complete' && value.authenticated === true && value.repository === run.repositoryFullName
          && value.repositoryId === run.repositoryId && value.pullNumber === run.pullRequestNumber
          && value.headSha === run.expectedHeadSha && value.draft === true && value.state === 'open'
          && Number.isSafeInteger(value.reviewId) && value.reviewId > 0 && Array.isArray(value.findings) && value.findings.length <= 64;
      }
      return exact(value, ['status', 'authenticated', 'repository', 'repositoryId', 'pullNumber', 'headSha', 'draft', 'state', 'findings'])
        && value.status === 'findings' && value.authenticated === true && value.repository === run.repositoryFullName
        && value.repositoryId === run.repositoryId && value.pullNumber === run.pullRequestNumber
        && value.headSha === run.expectedHeadSha && typeof value.draft === 'boolean' && value.state === 'open'
        && Array.isArray(value.findings) && value.findings.length <= 64;
    }
    function qodoFindingHash(finding) {
      return hash(canonical({ version: 1, source: 'qodo', reviewId: finding.reviewId,
        commentId: finding.commentId, headSha: finding.commitSha, path: finding.path,
        line: finding.line, body: finding.body }));
    }
    async function reviewRead() {
      const value = await budget.wait(() => review.readReview({ repository: manifest.repository.name, repositoryId: manifest.repository.id,
        pullNumber: snapshot.run.pullRequestNumber, headSha: snapshot.run.expectedHeadSha,
        qodoIdentities: manifest.qodoIdentities, requireDraft: true, deadline: budget.deadline }));
      checkWait();
      return value;
    }
    function reviewPolicyEnabled() {
      return manifest.reviewPolicy?.version === 1
        && manifest.reviewPolicy.profile === 'worker-command-maintainer-fallback-v1';
    }
    async function dispatchReviewRequest() {
      if (!reviewPolicyEnabled()) return { status: 'disabled' };
      const run = { ...snapshot.run, branchName: snapshot.run.branchName,
        repositoryId: snapshot.run.repositoryId, repositoryFullName: snapshot.run.repositoryFullName,
        pullRequestNumber: snapshot.run.pullRequestNumber, expectedHeadSha: snapshot.run.expectedHeadSha };
      const dispatched = await budget.wait(() => reviewRequestPublisher.dispatch({
        reviewPolicy: manifest.reviewPolicy, run, lease, workerActor: dependencies.ownedActor,
        expectedWorkerActor: dependencies.ownedActor, deadline: budget.deadline, store,
        database: operation => database(operation),
        async checkApproval() { await fresh(); },
        async checkFence() {
          const current = await owned();
          if (current.run.state !== 'waiting_review' || current.pendingOperation
            || current.run.expectedHeadSha !== run.expectedHeadSha
            || current.run.pullRequestNumber !== run.pullRequestNumber) stop('recovery_lease_lost');
          checkWait();
        },
      }));
      reviewDiagnostics = { category: dispatched.status === 'confirmed' ? 'review_request_confirmed' : dispatched.category,
        ...(Number.isSafeInteger(dispatched.commentId) && dispatched.commentId > 0 ? { commentId: dispatched.commentId } : {}) };
      if (databaseUncertain) stop('recovery_database_uncertain');
      return dispatched;
    }
    async function recordTrustedReviewEvidence(source, reviewId, dispatched) {
      if (!reviewPolicyEnabled()) return;
      const run = snapshot.run;
      const proof = await database(options => store.recordReviewEvidence(lease, {
        headSha: run.expectedHeadSha, identitySha256: dispatched.identitySha256,
        actorId: dependencies.ownedActor.databaseId, actorLogin: dependencies.ownedActor.login,
        appId: dispatched.appId, pullRequestNumber: run.pullRequestNumber,
        source, reviewId,
      }, options));
      if (proof?.evidenceSource !== source || proof.nativeReviewId !== reviewId) {
        reviewDiagnostics = { ...reviewDiagnostics, category: 'review_evidence_unconfirmed' };
        stop('recovery_effect_unconfirmed');
      }
      reviewDiagnostics = { ...reviewDiagnostics, source };
    }
    async function maintainerFallback() {
      if (!reviewPolicyEnabled() || typeof review.readMaintainerReview !== 'function') return null;
      const value = await budget.wait(() => review.readMaintainerReview({
        repository: snapshot.run.repositoryFullName, repositoryId: snapshot.run.repositoryId,
        pullNumber: snapshot.run.pullRequestNumber, headSha: snapshot.run.expectedHeadSha,
        workerActor: dependencies.ownedActor,
        approver: { id: manifest.approver.id, login: manifest.approver.login }, deadline: budget.deadline,
      }));
      checkWait();
      if (value?.status !== 'approved' || value.headSha !== snapshot.run.expectedHeadSha
        || value.reviewerId !== manifest.approver.id || value.reviewerLogin?.toLowerCase() !== manifest.approver.login.toLowerCase()
        || !Number.isSafeInteger(value.reviewId) || value.reviewId < 1) return null;
      return value;
    }
    async function finding(source, value, checked, reviewId = null) {
      const evidence = evidenceFor(checked, reviewId);
      const files = await prepared();
      checkWait();
      await fresh();
      if (source === 'ci') assertionReferences(value.evidence?.assertions ?? value.assertions, files, manifest);
      else if (source === 'qodo' && Array.isArray(value.assertions)) {
        assertionReferences(value.assertions, files, manifest);
      } else if (source === 'qodo') {
        if (!Number.isSafeInteger(value.commentId) || value.commentId < 1
            || !Number.isSafeInteger(value.reviewId) || value.reviewId < 1
            || value.commitSha !== snapshot.run.expectedHeadSha
            || !manifest.allowedPaths.includes(value.path)
            || !Number.isSafeInteger(value.line) || value.line < 1
            || typeof value.body !== 'string' || value.body.length > 4000
            || !files.some(file => file.path === value.path
              && value.line <= file.text.split('\n').length)) stop();
      } else stop();
      if (!SHA256.test(value.findingSha256 ?? '')) stop();
      const response = await database(options => {
        checkWait();
        return store.beginRepair(lease, { key: hash(canonical({ version: 1,
          runId: snapshot.run.runId, source, headSha: snapshot.run.expectedHeadSha, findingSha256: value.findingSha256 })),
        source, headSha: snapshot.run.expectedHeadSha, findingSha256: value.findingSha256, evidence }, options);
      });
      if (response?.status === 'reserved' && response.canRepair === true) return result('advanced', undefined, true);
      if (response?.status === 'needs_attention' && response.blockerCode === 'repair_cycle_limit') return result('needs_attention', 'repair_cycle_limit', true);
      stop();
    }
    async function investigation(files) {
      const phase = snapshot.phase;
      if (phase.findingHeadSha !== snapshot.run.expectedHeadSha) stop();
      let assertions, digest, findingReport, qodoSourceReferences = false;
      if (phase.findingSource === 'ci') {
        const value = await checks(undefined, true);
        if (value?.status !== 'failure') stop();
        assertions = value.evidence?.assertions; digest = value.findingSha256;
      } else if (phase.findingSource === 'qodo') {
        const value = await reviewRead();
        if (!reviewBinding(value) || value.findings.length === 0) stop();
        const finding = value.findings.find(item => item.findingSha256 === phase.findingSha256
          || qodoFindingHash(item) === phase.findingSha256);
        if (!finding) stop();
        if (Array.isArray(finding.assertions)) {
          assertions = finding.assertions;
          digest = finding.findingSha256;
        } else {
          qodoSourceReferences = true;
          const fileIndex = files.findIndex(file => file.path === finding.path);
          const file = files[fileIndex];
          if (fileIndex < 0 || !manifest.allowedPaths.includes(finding.path)
            || !Number.isSafeInteger(finding.line) || finding.line < 1
            || typeof file.text !== 'string' || finding.line > file.text.split('\n').length
            || typeof finding.body !== 'string' || !finding.body.length
            || Buffer.byteLength(finding.body) > 4000
            || qodoFindingHash(finding) !== phase.findingSha256) stop();
          digest = phase.findingSha256;
          assertions = [{ fileIndex, blobSha: file.blobSha, testIdentitySha256: null }];
          findingReport = { version: 1, source: 'qodo', findingSha256: digest,
            headSha: snapshot.run.expectedHeadSha, reviewId: finding.reviewId,
            commentId: finding.commentId, fileIndex, line: finding.line, body: finding.body };
        }
      } else stop();
      if (digest !== phase.findingSha256) stop();
      return { investigation: { version: 1, findingSha256: digest, headSha: snapshot.run.expectedHeadSha,
        criteria: manifest.acceptanceCriteria.map((criterion, criterionIndex) => ({ criterionIndex, criterionSha256: hash(criterion) })),
        references: qodoSourceReferences ? assertions : assertionReferences(assertions, files, manifest),
        regressionFileIndex: files.findIndex(file => file.path === manifest.allowedPaths[manifest.coordinator.regression.testPathIndex]) },
      ...(findingReport ? { findingReport } : {}) };
    }
    async function generate() {
      if (snapshot.modelOperation) stop(snapshot.modelOperation.outcome === 'success' ? 'coordinator_candidate_lost' : 'coordinator_model_uncertain');
      const { policy, issue } = await fresh(finalizationDeadline);
      const files = await prepared(finalizationDeadline);
      const investigationContext = snapshot.phase.purpose === 'repair_tests' ? await investigation(files) : {};
      const trustedInvestigation = investigationContext.investigation;
      const headSha = snapshot.run.expectedHeadSha ?? snapshot.run.baseRevision;
      // Initial expected RED follows TDD; unexpected-finding repair also needs debugging guidance.
      const selectedSkills = policy.skills.filter(skill => skill.name !== 'systematic-debugging'
        || snapshot.phase.purpose.startsWith('repair_'));
      const regression = manifest.coordinator.regression;
      const criterionIndex = snapshot.phase.purpose.startsWith('initial_')
        ? regression.initial.criterionIndex : null;
      const regressionPath = manifest.allowedPaths[regression.testPathIndex];
      const phaseInstructions = freeze({ purpose: snapshot.phase.purpose,
        repairCycle: snapshot.phase.repairCycle, regressionPath,
        testName: snapshot.phase.repairCycle === 0 ? regression.initial.testName
          : regression.repairTestNames[snapshot.phase.repairCycle - 1],
        ...(criterionIndex === null ? {} : { criterionIndex, criterion: manifest.acceptanceCriteria[criterionIndex] }) });
      const context = freeze({ policy: { system: policy.systemPolicy, projectRules: `${policy.projectRules}\n\n${policy.documentationGuidance}` },
        skills: selectedSkills.map(skill => [skill.content, ...skill.references.map(reference => reference.content)].join('\n\n')),
        issue, repository: { owner: 'randoneering', name: 'mellon', baseSha: headSha, revision: headSha },
        manifest: { repository: manifest.repository.name, baseSha: headSha, hash: expectedManifestSha256,
          files: manifest.allowedPaths, acceptanceCriteria: manifest.acceptanceCriteria,
          coordinator: { regression },
          patchManifest: { allowedPaths: manifest.allowedPaths, pilotScope: manifest.pilotScope } }, files,
        phaseInstructions, ...investigationContext });
      let successfulOutcome = false;
      const modelWindowMs = modelDeadline - Date.now();
      if (modelWindowMs < MIN_MODEL_WINDOW_MS + POST_RESERVATION_AUTH_MS) stop('recovery_deadline');
      const agentTimeoutMs = Math.min(MODEL_CALL_CEILING_MS, modelWindowMs);
      const postReservationDeadline = modelDeadline - MIN_MODEL_WINDOW_MS;
      const authorization = {
        async recheck() {
          const deadline = modelOperationId ? postReservationDeadline : modelAdmissionDeadline;
          await fresh(deadline);
          if (modelDeadline - Date.now() < MIN_MODEL_WINDOW_MS) stop('recovery_deadline');
          return true;
        },
        async reserveModelCall(request) {
          await fresh(modelAdmissionDeadline);
          if (Date.now() >= modelAdmissionDeadline
            || modelDeadline - Date.now() < MIN_MODEL_WINDOW_MS + POST_RESERVATION_AUTH_MS) {
            stop('recovery_deadline');
          }
          const receipt = await database(options => store.reserveModelCall(lease,
            { ...request, key: snapshot.phase.key }, options), modelAdmissionDeadline);
          if (receipt?.status === 'reserved' && receipt.canExecute === true) modelOperationId = receipt.operationId;
          return receipt;
        },
        async recordModelCallOutcome(reservation, outcome) {
          if (!modelOperationId || reservation.operationId !== modelOperationId) stop();
          const receipt = await database(options => store.recordModelCallOutcome(lease,
            { operationId: modelOperationId, ...outcome }, options), outcomeDeadline);
          if (outcome.outcome === 'success' && Number.isSafeInteger(outcome.actualInputTokens)
            && Number.isSafeInteger(outcome.actualOutputTokens)) {
            modelUsage = { inputTokens: outcome.actualInputTokens,
              outputTokens: outcome.actualOutputTokens };
          }
          successfulOutcome = receipt?.status === 'recorded' && receipt.outcome === 'success' && receipt.blockerCode === null;
          return receipt;
        },
      };
      const agent = await waitUntil(modelAdmissionDeadline,
        () => (adapters.createAgentWorker ?? createAgentWorker)({ ...model,
        authorization, deadline: modelDeadline,
        loadContext: async () => { budget.check(); return context; },
        readFile: async request => {
          budget.check();
          const file = files.find(file => file.path === request.path);
          if (request.revision !== headSha || file?.blobSha !== request.expectedBlobSha) stop();
          return { revision: headSha, path: file.path, blobSha: file.blobSha, text: file.text };
        }, timeoutMs: agentTimeoutMs }));
      const generated = await waitUntil(outcomeDeadline, () => agent.run({}));
      agentDiagnostics = safeAgentDiagnostics(generated?.diagnostics);
      if (terminalResult) return terminalResult;
      if (databaseUncertain) stop('recovery_database_uncertain');
      if (generated?.blockerCode === 'model_outcome_uncertain') return result('needs_attention', 'model_outcome_uncertain', false, agentDiagnostics);
      if (stageFailure) throw stageFailure;
      if (generated?.blockerCode === 'investigation_human_stop' || generated?.blockerCode === 'investigation_assessment_unavailable') stop('coordinator_investigation_human_stop');
      if (generated?.status !== 'completed' || generated.proposal !== true || !successfulOutcome || !modelOperationId
        || generated.baseSha !== headSha || generated.manifestHash !== expectedManifestSha256) {
        stop(successfulOutcome ? 'coordinator_candidate_lost' : 'coordinator_model_uncertain');
      }
      const candidatePhase = phaseInput(snapshot.phase);
      // A new regression selects its own approved criterion; implementation preserves it.
      const { criterionSha256: _previousCriterion, ...newSelectionPhase } = candidatePhase;
      let candidate;
      try {
        candidate = prepareCandidate({ publicationRun: publicationRun(snapshot.run, manifest),
          phase: trustedInvestigation ? { ...newSelectionPhase, investigation: trustedInvestigation } : candidatePhase,
          approvedManifest: manifest, modelOperationId, changes: projectedChanges(generated.changes), baseFiles: files,
          ...(trustedInvestigation ? { assessment: generated.assessment } : {}) });
      } catch { stop('coordinator_candidate_lost'); }
      return publish(candidate.intent, candidate.publication);
    }
    try {
      if (!validDelivery(delivery, triggerId)) return result('needs_attention', 'recovery_invalid_input');
      const claim = await database(options => store.claimTick({ invocationId: delivery.invocationId, manifest: claimManifest }, options));
      if (claim?.status === 'busy') return result('duplicate');
      if (claim?.status === 'idle') return result('idle');
      if (claim?.status !== 'claimed') stop();
      lease = claim.lease; claimedDeadline = claim.deadline;
      budget.clamp(claimedDeadline);
      finalizationDeadline = Math.min(claimedDeadline, budget.deadline);
      publicationDeadline = finalizationDeadline - FINALIZATION_GRACE_MS;
      outcomeDeadline = publicationDeadline - PUBLICATION_WINDOW_MS - POST_MODEL_AUTH_MS;
      modelDeadline = outcomeDeadline - MODEL_OUTCOME_WINDOW_MS;
      modelAdmissionDeadline = modelDeadline - MIN_MODEL_WINDOW_MS - POST_RESERVATION_AUTH_MS;
      snapshot = await owned(finalizationDeadline);
      await fresh(finalizationDeadline);
      if (snapshot.pendingOperation) return await pending();
      const { run, phase } = snapshot;
      if (phase?.pendingOperationId) stop();
      if (!phase) {
        if (run.state !== 'claimed') stop();
        return await checkpoint('generating_tests', newPhase('initial_tests'));
      }
      phaseInput(phase);
      if (phase.purpose === 'repair_investigation') {
        if (snapshot.modelOperation) stop(snapshot.modelOperation.outcome === 'success' ? 'coordinator_candidate_lost' : 'coordinator_model_uncertain');
        return await checkpoint('generating_tests', newPhase('repair_tests'));
      }
      if (MODEL_STATES.has(run.state) && phase.purpose !== 'draft_pr') return await generate();
      if (WAIT_STATES.has(run.state)) {
        checkWait();
        if (run.state === 'waiting_review') {
          if (reviewPolicyEnabled()) {
            const initialChecks = await checks();
            if (initialChecks?.status === 'waiting') return await checkpoint(run.state);
            if (initialChecks?.status !== 'success') stop();
            const dispatched = await dispatchReviewRequest();
            if (dispatched.status !== 'confirmed') stop('recovery_effect_unconfirmed');
          }
          let value = await reviewRead();
          let maintainerProof = false;
          if (value?.status === 'waiting') {
            if (!reviewPolicyEnabled() || !['draft_review_absent', 'review_absent', 'stale_review'].includes(value.reason)) {
              return await checkpoint(run.state);
            }
            const fallbackChecks = await checks();
            if (fallbackChecks?.status === 'waiting') return await checkpoint(run.state);
            if (fallbackChecks?.status !== 'success') stop();
            value = await maintainerFallback();
            if (!value) return await checkpoint(run.state);
            maintainerProof = true;
          }
          if (!maintainerProof && !reviewBinding(value)) stop();
          if (!maintainerProof && value.findings.length) {
            if (value.findings.length !== 1) stop();
            const sourceFinding = value.findings[0];
            const currentChecks = await checks();
            if (currentChecks?.status === 'waiting') return await checkpoint(run.state);
            if (currentChecks?.status !== 'success') stop();
            if (value.status === 'findings' || !Array.isArray(sourceFinding.assertions)) {
              const findingValue = { ...sourceFinding, findingSha256: qodoFindingHash(sourceFinding) };
              return await finding('qodo', findingValue, currentChecks, sourceFinding.reviewId);
            }
            if (!exact(sourceFinding, ['findingSha256', 'assertions'])) stop();
            return await finding('qodo', sourceFinding, currentChecks, value.reviewId);
          }
          if (!maintainerProof && value.status !== 'complete') stop();
          const reviewId = value.reviewId;
          const evidenceSource = maintainerProof ? 'maintainer' : 'qodo';
          const currentChecks = await checks();
          if (currentChecks?.status === 'waiting') return await checkpoint(run.state);
          if (currentChecks?.status !== 'success') stop();
          if (reviewPolicyEnabled()) {
            // Reconcile the confirmed command and recheck owned head after proof/CI reads.
            const dispatched = await dispatchReviewRequest();
            if (dispatched.status !== 'confirmed') stop('recovery_effect_unconfirmed');
            await recordTrustedReviewEvidence(evidenceSource, reviewId, dispatched);
          }
          await fresh();
          const receipt = await database(options => {
            checkWait();
            return store.finishRun(lease, 'ready_for_human',
              { evidence: evidenceFor(currentChecks, reviewId) }, options);
          });
          return receipt ? result('ready_for_human', undefined, true, undefined, reviewDiagnostics) : result('needs_attention', 'recovery_lease_lost', false, undefined, reviewDiagnostics);
        }
        const value = await checks(run.state === 'waiting_red_ci' ? phase.expectedRegression : undefined);
        if (value?.status === 'waiting') return await checkpoint(run.state);
        if (run.state === 'waiting_red_ci') {
          if (value?.status !== 'intended_red') stop();
          return await checkpoint('implementing', newPhase(phase.purpose === 'repair_tests'
            ? 'repair_implementation' : 'initial_implementation'), evidenceFor(value));
        }
        if (value?.status !== 'success') {
          const failure = await checks(undefined, true);
          if (failure?.status !== 'failure') stop();
          return await finding('ci', failure, failure);
        }
        const next = await checkpoint(run.pullRequestNumber ? 'waiting_review' : 'opening_pr',
          newPhase('draft_pr'), evidenceFor(value));
        return next.persisted ? result('advanced', undefined, true) : next;
      }
      if (run.state === 'opening_pr' && phase.purpose === 'draft_pr' && !run.pullRequestNumber) {
        if ((await checks())?.status !== 'success') stop();
        const key = hash(canonical({ version: 1, phaseKey: phase.key, kind: 'pr_create' }));
        const publication = snapshotDraftPrRequest({ run: publicationRun(run, manifest), intent: { id: key, kind: 'pr_create' }, approvedManifest: manifest });
        const intent = validateIntent({ key, kind: 'pr_create', inputHash: buildDraftPrOperationHash(publication), expectedHeadSha: run.expectedHeadSha,
          coordinator: { version: 1, purpose: 'draft_pr', phaseKey: phase.key, repairCycle: phase.repairCycle, modelOperationId: null,
            expectedRegression: phase.expectedRegression, criterionSha256: phase.criterionSha256, candidateDescriptors: [] } });
        return await publish(intent, publication);
      }
      stop();
    } catch (error) {
      if (terminalResult) return terminalResult;
      const partialDiagnostics = reason => knownIntent
        ? publicationDiagnostics(reason, knownIntent)
        : modelOperationId ? { stage: 'model', category: reason, modelOperationId,
          ...(modelUsage ? { actualInputTokens: modelUsage.inputTokens,
            actualOutputTokens: modelUsage.outputTokens } : {}) }
          : { stage: 'finalization', category: reason };
      if (databaseUncertain) return result('needs_attention', 'recovery_database_uncertain', false,
        partialDiagnostics('recovery_database_uncertain'), reviewDiagnostics);
      if (budget.isExpired()) return result('needs_attention', 'recovery_deadline', false,
        partialDiagnostics('recovery_deadline'), reviewDiagnostics);
      const reason = error instanceof Stop ? error.reason : 'coordinator_journal_conflict';
      const status = error instanceof Stop ? error.status : 'needs_attention';
      const diagnostics = agentDiagnostics
        ? { ...partialDiagnostics(reason), ...agentDiagnostics, proposalCategory: reason === 'coordinator_candidate_lost'
          && agentDiagnostics.proposalCategory === 'valid_proposal'
          ? 'lost_valid_proposal' : agentDiagnostics.proposalCategory }
        : partialDiagnostics(reason);
      if (!lease) return result(status, reason, false, diagnostics, reviewDiagnostics);
      try {
        const persisted = await database(options => store.finishRun(lease, status,
          status === 'needs_attention' ? { blockerCode: reason } : {}, options));
        return persisted ? result(status, reason, true, diagnostics, reviewDiagnostics) : result('needs_attention', 'recovery_lease_lost', false, undefined, reviewDiagnostics);
      } catch (failure) {
        const reason = !databaseUncertain && failure instanceof Stop
          && failure.reason === 'recovery_deadline' ? 'recovery_deadline' : 'recovery_database_uncertain';
        return result('needs_attention', reason, false, partialDiagnostics(reason), reviewDiagnostics);
      }
    } finally { trustedFileSession?.close?.(); budget.close(); }
  }
  return Object.freeze({ advanceTick });
}
