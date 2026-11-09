import { validateChanges } from './patch.mjs';
import { createPublicationClient } from './publication-client.mjs';
import {
  BASE_BRANCH,
  DRAFT_PR_TEMPLATE,
  MAX_TREE_ENTRIES,
  REPOSITORY_FULL_NAME,
  PublicationValidationError,
  buildOperationHash,
  buildDraftPrOperationHash,
  draftPrContent,
  gitBlobSha,
  deriveBranchName,
  parseGitTree,
  snapshotPublicationRequest,
  snapshotDraftPrRequest,
  validatePullRequestContext,
  validateInitialChecks,
  validateDraftPr,
  validateApprovalResult,
  validateFenceResult,
  validatePublicationContext,
  validationBaseFromTree,
  verifyCommitProof,
  verifyOwnedCommitProof,
  verifyTreeMatchesChanges,
  validSha1,
} from './publication-validation.mjs';

const DEFAULT_DEADLINE_MS = 20_000;
const MAX_DEADLINE_MS = 30_000;
// Two initial commits plus two regression/implementation repair pairs.
const MAX_OWNED_COMMITS = 6;
const BRANCH_REF_PREFIX = 'refs/heads/';

class PublicationStop extends Error {
  constructor(reason, refs = {}) {
    super(reason);
    this.reason = reason;
    this.refs = refs;
  }
}

function stop(reason, refs) {
  throw new PublicationStop(reason, refs);
}

function deadlineError() {
  const error = new Error('deadline_exceeded');
  error.code = 'deadline_exceeded';
  return error;
}

function createBudget(timeoutMs) {
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  let timer;
  let rejectExpired;
  const expired = new Promise((_, reject) => {
    rejectExpired = reject;
    timer = setTimeout(() => {
      controller.abort();
      rejectExpired(deadlineError());
    }, timeoutMs);
  });
  void expired.catch(() => {});
  return {
    signal: controller.signal,
    deadline,
    wait(operation) {
      if (controller.signal.aborted || Date.now() >= deadline) throw deadlineError();
      // Attach rejection observers before a callback or transport can begin.
      const pending = Promise.resolve().then(() => {
        if (controller.signal.aborted || Date.now() >= deadline) throw deadlineError();
        return operation();
      });
      return Promise.race([pending, expired]);
    },
    isExpired() {
      return controller.signal.aborted || Date.now() >= deadline;
    },
    close() {
      clearTimeout(timer);
      controller.abort();
    },
  };
}

function safeReferences(state, values = {}) {
  const refs = {
    branch: state?.branch,
    ...(state?.operationHash ? { inputHash: state.operationHash } : {}),
    ...((values.branchHeadSha ?? state?.branchHeadSha)
      && validSha1(values.branchHeadSha ?? state.branchHeadSha)
      ? { branchHeadSha: values.branchHeadSha ?? state.branchHeadSha } : {}),
    ...((values.commitSha ?? state?.commitSha)
      && validSha1(values.commitSha ?? state.commitSha)
      ? { commitSha: values.commitSha ?? state.commitSha } : {}),
    ...((values.treeSha ?? state?.treeSha)
      && validSha1(values.treeSha ?? state.treeSha)
      ? { treeSha: values.treeSha ?? state.treeSha } : {}),
    ...((values.parentSha ?? state?.parentSha)
      && validSha1(values.parentSha ?? state.parentSha)
      ? { parentSha: values.parentSha ?? state.parentSha } : {}),
  };
  return Object.fromEntries(Object.entries(refs).filter(([, value]) => value !== undefined));
}

function attention(reason, state, refs) {
  return Object.freeze({
    status: 'needs_attention',
    reason,
    ...safeReferences(state, refs),
  });
}

function confirmed(state, proof, branchHeadSha) {
  state.commitSha = proof.commitSha;
  state.treeSha = proof.treeSha;
  state.parentSha = proof.parentSha;
  state.branchHeadSha = branchHeadSha;
  return Object.freeze({
    status: 'confirmed',
    branch: state.branch,
    inputHash: state.operationHash,
    baseSha: state.request.run.baseSha,
    parentSha: proof.parentSha,
    commitSha: proof.commitSha,
    treeSha: proof.treeSha,
    branchHeadSha,
  });
}

function validateDependencies(dependencies) {
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)
    || typeof dependencies.fetch !== 'function'
    || typeof dependencies.getPublicationContext !== 'function'
    || typeof dependencies.checkApproval !== 'function'
    || typeof dependencies.checkFence !== 'function') stop('callbacks_missing');
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_DEADLINE_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_DEADLINE_MS) {
    stop('deadline_invalid');
  }
  return { ...dependencies, timeoutMs };
}

function assertContextFresh(state) {
  const now = Date.now();
  if (Date.parse(state.context.tokenExpiresAt) <= now
    || Date.parse(state.context.contextExpiresAt) <= now
    || Date.parse(state.context.signingPreflight.expiresAt) <= now) {
    stop('signing_preflight_expired', safeReferences(state));
  }
}

async function checkApproval(state, dependencies, budget, refs = {}) {
  let result;
  try {
    result = await budget.wait(() => dependencies.checkApproval({
      run: state.request.run,
      approvedManifest: state.request.approvedManifest,
      manifestSha256: state.request.run.manifestSha256,
      signal: budget.signal,
      deadline: budget.deadline,
    }));
  } catch (error) {
    if (budget.isExpired()) throw error;
    stop('approval_unavailable', safeReferences(state, refs));
  }
  if (!validateApprovalResult(result, state.request)) stop('approval_denied', safeReferences(state, refs));
}

async function checkFence(state, dependencies, budget, phase, refs = {}) {
  let result;
  try {
    result = await budget.wait(() => dependencies.checkFence({
      runId: state.request.run.id,
      generation: state.request.run.generation,
      intentId: state.request.intent.id,
      operationHash: state.operationHash,
      expectedHeadSha: state.request.run.expectedHeadSha,
      phase,
      ...(state.operationKind ? { kind: state.operationKind } : {}),
      signal: budget.signal,
      deadline: budget.deadline,
    }));
  } catch (error) {
    if (budget.isExpired()) throw error;
    stop('fence_unavailable', safeReferences(state, refs));
  }
  if (!validateFenceResult(result, state.request, state.operationHash, phase)
    || state.operationKind && result.kind !== state.operationKind) {
    stop('fence_denied', safeReferences(state, refs));
  }
  return result.decision;
}

function validateRepository(repository, request) {
  if (!repository || repository.id !== request.run.repositoryId
    || repository.full_name !== REPOSITORY_FULL_NAME
    || repository.name !== 'mellon') stop('repository_identity_mismatch');
}

function parseRef(ref, branch) {
  if (ref === null) return null;
  if (!ref || ref.ref !== `${BRANCH_REF_PREFIX}${branch}`
    || !ref.object || ref.object.type !== 'commit' || !validSha1(ref.object.sha)) {
    stop('branch_identity_mismatch');
  }
  return ref.object.sha;
}

function parseGitCommit(commit, sha) {
  if (!commit || commit.sha !== sha || !commit.tree
    || !validSha1(commit.tree.sha) || !Array.isArray(commit.parents)
    || commit.parents.length > 64
    || commit.parents.some(parent => !validSha1(parent?.sha))) stop('commit_metadata_invalid');
  return {
    treeSha: commit.tree.sha,
    parents: commit.parents.map(parent => parent.sha),
  };
}

async function getTree(client, sha) {
  const commit = await client.getCommit(sha);
  const metadata = parseGitCommit(commit, sha);
  const response = await client.getTree(metadata.treeSha);
  if (!Array.isArray(response?.tree) || response.tree.length > MAX_TREE_ENTRIES) {
    stop('tree_incomplete');
  }
  return { metadata, tree: parseGitTree(response, metadata.treeSha) };
}

async function verifyOwnedHistory(client, state, context, budget) {
  let cursor = state.request.run.expectedHeadSha;
  if (cursor === state.request.run.baseSha) return 0;
  for (let depth = 0; depth < MAX_OWNED_COMMITS; depth += 1) {
    if (budget.isExpired()) throw deadlineError();
    let proof;
    try {
      proof = await budget.wait(() => client.getCommitProof(cursor, state.branch));
    } catch (error) {
      if (budget.isExpired()) throw error;
      stop('branch_history_untrusted', safeReferences(state, { branchHeadSha: state.initialBranchHeadSha }));
    }
    const actual = verifyOwnedCommitProof(proof, {
      repositoryId: state.request.run.repositoryId,
      oid: cursor,
      actor: context.actor,
    });
    if (!actual) stop('branch_history_untrusted', safeReferences(state, { branchHeadSha: state.initialBranchHeadSha }));
    const restCommit = await client.getCommit(cursor);
    const rest = parseGitCommit(restCommit, cursor);
    if (rest.treeSha !== actual.treeSha || rest.parents.length !== 1
      || rest.parents[0] !== actual.parentSha) {
      stop('branch_history_untrusted', safeReferences(state, { branchHeadSha: state.initialBranchHeadSha }));
    }
    if (actual.parentSha === state.request.run.baseSha) return depth + 1;
    cursor = actual.parentSha;
  }
  stop('branch_history_untrusted', safeReferences(state, { branchHeadSha: state.initialBranchHeadSha }));
}

async function loadState(input, dependencies, budget, { requireApproval }) {
  let request;
  try {
    request = snapshotPublicationRequest(input);
    deriveBranchName(request.run.id);
  } catch {
    stop('invalid_input');
  }
  const branch = deriveBranchName(request.run.id);
  const state = { request, branch };
  if (requireApproval) await checkApproval(state, dependencies, budget);

  let rawContext;
  try {
    rawContext = await budget.wait(() => dependencies.getPublicationContext({
      repositoryId: request.run.repositoryId,
      repositoryName: REPOSITORY_FULL_NAME,
      runId: request.run.id,
      branch,
      signal: budget.signal,
      deadline: budget.deadline,
    }));
  } catch (error) {
    if (budget.isExpired()) throw error;
    stop('publication_context_unavailable', safeReferences(state));
  }
  let context;
  try {
    context = validatePublicationContext(rawContext, request.run);
  } catch (error) {
    if (error instanceof PublicationValidationError) stop(error.reason, safeReferences(state));
    stop('publication_context_invalid', safeReferences(state));
  }
  state.context = context;
  const client = createPublicationClient({
    fetch: dependencies.fetch,
    token: context.token,
    budget,
  });
  state.client = client;

  let repository;
  try {
    repository = await client.getRepository();
  } catch (error) {
    if (budget.isExpired()) throw error;
    stop('repository_read_failed', safeReferences(state));
  }
  validateRepository(repository, request);

  let initialRef;
  try {
    initialRef = await client.getRef(branch);
  } catch (error) {
    if (budget.isExpired()) throw error;
    stop('branch_read_failed', safeReferences(state));
  }
  state.initialBranchHeadSha = parseRef(initialRef, branch);
  state.branchHeadSha = state.initialBranchHeadSha;
  if (state.initialBranchHeadSha === null
    && request.run.expectedHeadSha !== request.run.baseSha) {
    stop('branch_absent', safeReferences(state));
  }

  const ownedCommitCount = await verifyOwnedHistory(client, state, context, budget);
  if (ownedCommitCount >= MAX_OWNED_COMMITS) {
    stop('branch_history_limit', safeReferences(state));
  }
  const { tree: parentTree } = await getTree(client, request.run.expectedHeadSha);
  state.parentTree = parentTree;

  let accepted;
  try {
    const baseFiles = validationBaseFromTree(parentTree, request.approvedManifest.allowedPaths);
    accepted = validateChanges(baseFiles, request.proposedChanges, {
      allowedPaths: request.approvedManifest.allowedPaths,
      pilotScope: request.approvedManifest.pilotScope,
    });
  } catch {
    stop('patch_rejected', safeReferences(state));
  }
  if (accepted.some(change => change.mode !== '100644')) {
    stop('unsupported_file_mode', safeReferences(state));
  }
  state.accepted = accepted;
  state.operationHash = buildOperationHash(request, accepted);
  return state;
}

async function verifyAppliedCommit(state, commitSha, branchHeadSha) {
  const { client, request, branch, context, parentTree, accepted } = state;
  let proof;
  try {
    proof = await client.getCommitProof(commitSha, branch);
  } catch {
    return null;
  }
  if (!verifyCommitProof(proof, {
    repositoryId: request.run.repositoryId,
    oid: commitSha,
    parentSha: request.run.expectedHeadSha,
    actor: context.actor,
  }) || proof.ref.name !== `${BRANCH_REF_PREFIX}${branch}`
    || proof.ref.targetSha !== branchHeadSha) return null;
  let commit;
  try {
    commit = await client.getCommit(commitSha);
  } catch {
    return null;
  }
  let metadata;
  try {
    metadata = parseGitCommit(commit, commitSha);
  } catch {
    return null;
  }
  if (metadata.treeSha !== proof.commit.tree.oid
    || metadata.parents.length !== 1
    || metadata.parents[0] !== request.run.expectedHeadSha) return null;
  let committedTree;
  try {
    committedTree = parseGitTree(await client.getTree(metadata.treeSha), metadata.treeSha);
  } catch {
    return null;
  }
  if (!verifyTreeMatchesChanges(parentTree, committedTree, accepted)) return null;
  return {
    commitSha,
    treeSha: metadata.treeSha,
    parentSha: request.run.expectedHeadSha,
  };
}

async function readBranchHead(state, budget) {
  let ref;
  try {
    ref = await budget.wait(() => state.client.getRef(state.branch));
  } catch (error) {
    if (budget.isExpired()) throw error;
    stop('branch_read_failed', safeReferences(state));
  }
  const head = parseRef(ref, state.branch);
  if (head !== null) state.branchHeadSha = head;
  return head;
}

async function recordOrStopForMovedBranch(state, dependencies, budget, branchHeadSha) {
  if (branchHeadSha === null) stop('branch_absent', safeReferences(state));
  if (branchHeadSha === state.request.run.expectedHeadSha) return null;
  await checkFence(state, dependencies, budget, 'probe', { branchHeadSha });
  const proof = await verifyAppliedCommit(state, branchHeadSha, branchHeadSha);
  if (!proof) {
    stop('branch_moved', safeReferences(state, { branchHeadSha }));
  }
  if (budget.isExpired()) throw deadlineError();
  return proof;
}

async function runPublication(state, dependencies, budget) {
  const request = state.request;
  let branchHeadSha = state.initialBranchHeadSha;

  if (branchHeadSha !== null && branchHeadSha !== request.run.expectedHeadSha) {
    const proof = await recordOrStopForMovedBranch(state, dependencies, budget, branchHeadSha);
    if (proof) return confirmed(state, proof, branchHeadSha);
  }

  if (branchHeadSha === null) {
    await checkApproval(state, dependencies, budget);
    if (await checkFence(state, dependencies, budget, 'branch') !== 'execute') {
      stop('branch_write_not_observed', safeReferences(state));
    }
    assertContextFresh(state);
    try {
      await budget.wait(() => state.client.createRef(state.branch, request.run.baseSha));
    } catch (error) {
      if (budget.isExpired()) throw error;
    }
    branchHeadSha = await readBranchHead(state, budget);
    if (branchHeadSha !== request.run.baseSha) {
      stop(branchHeadSha === null ? 'branch_write_unconfirmed' : 'branch_moved',
        safeReferences(state, { branchHeadSha }));
    }
  }

  if (branchHeadSha !== request.run.expectedHeadSha) {
    stop('branch_head_mismatch', safeReferences(state, { branchHeadSha }));
  }
  state.branchHeadSha = branchHeadSha;

  const currentHead = await readBranchHead(state, budget);
  if (currentHead !== request.run.expectedHeadSha) {
    const proof = await recordOrStopForMovedBranch(state, dependencies, budget, currentHead);
    if (proof) return confirmed(state, proof, currentHead);
  }

  const beforeCommitHead = await readBranchHead(state, budget);
  if (beforeCommitHead !== request.run.expectedHeadSha) {
    const proof = await recordOrStopForMovedBranch(state, dependencies, budget, beforeCommitHead);
    if (proof) return confirmed(state, proof, beforeCommitHead);
  }

  await checkApproval(state, dependencies, budget, { branchHeadSha: beforeCommitHead });
  if (await checkFence(state, dependencies, budget, 'commit', {
    branchHeadSha: beforeCommitHead,
  }) !== 'execute') {
    stop('commit_write_not_observed', safeReferences(state, { branchHeadSha: beforeCommitHead }));
  }
  assertContextFresh(state);

  let mutationResult;
  try {
    mutationResult = await budget.wait(() => state.client.createCommit(
      state.branch,
      request.run.expectedHeadSha,
      request.intent.id,
      state.accepted,
    ));
  } catch (error) {
    if (budget.isExpired()) throw error;
  }

  const afterCommitHead = await readBranchHead(state, budget);
  await checkFence(state, dependencies, budget, 'probe', {
    ...(afterCommitHead ? { branchHeadSha: afterCommitHead } : {}),
  });
  if (afterCommitHead === null) {
    stop('commit_write_unconfirmed', safeReferences(state));
  }
  if (afterCommitHead === request.run.expectedHeadSha) {
    stop('commit_write_unconfirmed', safeReferences(state, {
      branchHeadSha: afterCommitHead,
    }));
  }
  const proof = await verifyAppliedCommit(state, afterCommitHead, afterCommitHead);
  if (!proof) {
    const partial = mutationResult?.commitSha
      ? await verifyAppliedCommit(state, mutationResult.commitSha, afterCommitHead)
      : null;
    stop('branch_moved', safeReferences(state, {
      branchHeadSha: afterCommitHead,
      ...(partial ? { commitSha: partial.commitSha, treeSha: partial.treeSha } : {}),
    }));
  }
  return confirmed(state, proof, afterCommitHead);
}

async function runProbe(state, dependencies, budget) {
  const decision = await checkFence(state, dependencies, budget, 'probe');
  if (!['execute', 'reconcile_only'].includes(decision)) stop('fence_denied', safeReferences(state));
  const branchHeadSha = await readBranchHead(state, budget);
  if (branchHeadSha === null) return attention('branch_absent', state);
  if (branchHeadSha === state.request.run.expectedHeadSha) {
    return attention('effect_not_observed', state, { branchHeadSha });
  }
  const proof = await verifyAppliedCommit(state, branchHeadSha, branchHeadSha);
  if (!proof) return attention('branch_moved', state, { branchHeadSha });
  return confirmed(state, proof, branchHeadSha);
}

async function perform(input, dependencies, operation) {
  let budget;
  let state;
  try {
    const checkedDependencies = validateDependencies(dependencies);
    budget = createBudget(checkedDependencies.timeoutMs);
    state = await loadState(input, checkedDependencies, budget, {
      requireApproval: operation === 'publish',
    });
    return operation === 'publish'
      ? await runPublication(state, checkedDependencies, budget)
      : await runProbe(state, checkedDependencies, budget);
  } catch (error) {
    if (error?.code === 'deadline_exceeded' || budget?.isExpired()) {
      return attention('deadline_exceeded', state);
    }
    if (error instanceof PublicationStop) return attention(error.reason, state, error.refs);
    if (error instanceof PublicationValidationError) return attention(error.reason, state);
    return attention('publication_failed', state);
  } finally {
    budget?.close();
  }
}

export function publish(input, dependencies) {
  return perform(input, dependencies, 'publish');
}

export function probePublication(input, dependencies) {
  return perform(input, dependencies, 'probe');
}

async function loadDraftPrState(input, dependencies, budget) {
  const request = snapshotDraftPrRequest(input);
  const state = { request, branch: deriveBranchName(request.run.id), operationKind: 'pr_create',
    operationHash: buildDraftPrOperationHash(request) };
  await checkApproval(state, dependencies, budget);
  let raw;
  try {
    raw = await budget.wait(() => dependencies.getPullRequestContext({
      repositoryId: request.run.repositoryId, repositoryName: REPOSITORY_FULL_NAME,
      runId: request.run.id, branch: state.branch, signal: budget.signal, deadline: budget.deadline,
    }));
  } catch (error) {
    if (budget.isExpired()) throw error;
    stop('pr_context_unavailable', safeReferences(state));
  }
  state.context = validatePullRequestContext(raw, request.run);
  state.client = createPublicationClient({ fetch: dependencies.fetch,
    token: state.context.token, budget });
  validateRepository(await state.client.getRepository(), request);
  const head = await readBranchHead(state, budget);
  if (head !== request.run.expectedHeadSha) stop('branch_head_mismatch', safeReferences(state));
  state.initialBranchHeadSha = head;
  await verifyOwnedHistory(state.client, state, state.context, budget);
  const template = await state.client.getPullRequestTemplate(request.run.baseSha);
  const bytes = Buffer.from(DRAFT_PR_TEMPLATE, 'utf8');
  if (!template || template.type !== 'file' || template.path !== '.github/PULL_REQUEST_TEMPLATE.md'
    || template.encoding !== 'base64' || template.size !== bytes.length
    || template.sha !== gitBlobSha(DRAFT_PR_TEMPLATE) || typeof template.content !== 'string'
    || template.content.length > 8192
    || template.content.replace(/\n/g, '') !== bytes.toString('base64')) {
    stop('pr_template_unverified', safeReferences(state));
  }
  state.content = draftPrContent(request, state.operationHash);
  return state;
}

async function probeDraftPrState(state, dependencies, budget) {
  const decision = await checkFence(state, dependencies, budget, 'probe');
  const candidates = [];
  let complete = false;
  for (let page = 1; page <= 3; page += 1) {
    const result = await state.client.listPullRequests(state.branch, page);
    if (!Array.isArray(result.pulls) || result.pulls.length > 100) {
      stop('pr_evidence_invalid', safeReferences(state));
    }
    candidates.push(...result.pulls);
    if (result.pulls.length < 100 && !result.hasNext) {
      complete = true;
      break;
    }
  }
  if (!complete) stop('pr_evidence_incomplete', safeReferences(state));
  if (candidates.length > 1) stop('pr_identity_ambiguous', safeReferences(state));
  if (candidates.length === 0) return { decision, pr: null };
  const pr = candidates[0];
  if (!validateDraftPr(pr, state.request, state.branch, state.context, state.content)) {
    stop('pr_identity_mismatch', safeReferences(state));
  }
  return { decision, pr: { prId: pr.id, prNumber: pr.number } };
}

async function confirmDraftPr(state, dependencies, budget, pr) {
  if (await readBranchHead(state, budget) !== state.request.run.expectedHeadSha) {
    stop('branch_head_mismatch', safeReferences(state));
  }
  await checkFence(state, dependencies, budget, 'probe');
  return Object.freeze({ status: 'confirmed', ...safeReferences(state), ...pr,
    prCount: 1, headSha: state.request.run.expectedHeadSha,
    baseSha: state.request.run.baseSha, draft: true });
}

/** Reconcile one run-owned draft PR; only a fresh durable fence can authorize creation. */
export async function ensureDraftPr(input, dependencies) {
  let state;
  let budget;
  try {
    // PR token issuance is a separate trusted dependency, not the commit callback.
    const checked = validateDependencies({ ...dependencies,
      getPublicationContext: dependencies?.getPullRequestContext });
    if (typeof checked.getPullRequestContext !== 'function'
      || typeof checked.checkInitialChecks !== 'function') stop('callbacks_missing');
    budget = createBudget(checked.timeoutMs);
    state = await loadDraftPrState(input, checked, budget);
    const initial = await probeDraftPrState(state, checked, budget);
    if (initial.pr) return await confirmDraftPr(state, checked, budget, initial.pr);
    if (initial.decision !== 'execute') stop('pr_write_not_observed', safeReferences(state));
    let checks;
    try {
      checks = await budget.wait(() => checked.checkInitialChecks({ run: state.request.run,
        approvedManifest: state.request.approvedManifest, repositoryId: state.request.run.repositoryId,
        headSha: state.request.run.expectedHeadSha, branch: state.branch,
        signal: budget.signal, deadline: budget.deadline }));
    } catch (error) {
      if (budget.isExpired()) throw error;
      stop('initial_checks_unavailable', safeReferences(state));
    }
    if (!validateInitialChecks(checks, state.request, state.branch)) {
      stop('initial_checks_unverified', safeReferences(state));
    }
    if (await readBranchHead(state, budget) !== state.request.run.expectedHeadSha) {
      stop('branch_head_mismatch', safeReferences(state));
    }
    await checkApproval(state, checked, budget);
    if (await checkFence(state, checked, budget, 'pr') !== 'execute') {
      stop('pr_write_not_observed', safeReferences(state));
    }
    assertContextFresh(state);
    try {
      await budget.wait(() => state.client.createDraftPullRequest(state.branch, state.content));
    } catch (error) {
      if (budget.isExpired()) throw error;
      // Any transport or validation failure leaves an uncertain write, never permission to retry.
    }
    const observed = await probeDraftPrState(state, checked, budget);
    if (!observed.pr) stop('pr_write_unconfirmed', safeReferences(state));
    return await confirmDraftPr(state, checked, budget, observed.pr);
  } catch (error) {
    if (error?.code === 'deadline_exceeded' || budget?.isExpired()) {
      return attention('deadline_exceeded', state);
    }
    if (error instanceof PublicationStop) return attention(error.reason, state, error.refs);
    if (error instanceof PublicationValidationError) return attention(error.reason, state);
    return attention('pr_publication_failed', state);
  } finally {
    budget?.close();
  }
}
