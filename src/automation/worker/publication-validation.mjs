import { createHash } from 'node:crypto';

export const REPOSITORY_OWNER = 'randoneering';
export const REPOSITORY_NAME = 'mellon';
export const REPOSITORY_FULL_NAME = `${REPOSITORY_OWNER}/${REPOSITORY_NAME}`;
export const BASE_BRANCH = 'main';
export const MAX_TREE_ENTRIES = 100_000;
export const MAX_TREE_BYTES = 4 * 1024 * 1024;
export const MAX_INPUT_BYTES = 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TREE_MODES = new Map([
  ['040000', 'tree'],
  ['100644', 'blob'],
  ['100755', 'blob'],
  ['120000', 'blob'],
  ['160000', 'commit'],
]);

export class PublicationValidationError extends Error {
  constructor(reason = 'invalid_input') {
    super(reason);
    this.name = 'PublicationValidationError';
    this.reason = reason;
  }
}

function fail(reason = 'invalid_input') {
  throw new PublicationValidationError(reason);
}

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return isRecord(value)
    && Object.keys(value).length === expected.length
    && expected.every(key => Object.hasOwn(value, key));
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function cloneJson(value, state, depth = 0) {
  if (depth > 24 || ++state.nodes > 20_000) fail();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    state.bytes += Buffer.byteLength(value, 'utf8');
    if (state.bytes > MAX_INPUT_BYTES) fail();
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail();
    return value;
  }
  if (typeof value !== 'object') fail();
  if (state.seen.has(value)) fail();
  state.seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 20_000) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail();
      result.push(cloneJson(descriptor.value, state, depth + 1));
    }
    if (Reflect.ownKeys(descriptors).some(key => key !== 'length'
      && (typeof key !== 'string' || !/^\d+$/.test(key)
        || Number(key) >= value.length || String(Number(key)) !== key))) fail();
    state.seen.delete(value);
    return result;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== 'string') || keys.length > 256) fail();
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, 'value')) fail();
    state.bytes += Buffer.byteLength(key, 'utf8');
    if (state.bytes > MAX_INPUT_BYTES) fail();
    result[key] = cloneJson(descriptor.value, state, depth + 1);
  }
  state.seen.delete(value);
  return result;
}

function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function safeLogin(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 100
    && /^[A-Za-z0-9-]+(?:\[bot\])?$/.test(value);
}

function validTimestamp(value) {
  return typeof value === 'string'
    && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function gitBlobSha(content) {
  const bytes = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

export function deriveBranchName(runId) {
  if (typeof runId !== 'string' || !UUID.test(runId)) fail();
  return `agent-work/${runId}`;
}

export function snapshotPublicationRequest(value) {
  let request;
  try {
    request = cloneJson(value, { bytes: 0, nodes: 0, seen: new WeakSet() });
  } catch {
    fail();
  }
  if (!exactKeys(request, ['run', 'intent', 'approvedManifest', 'proposedChanges'])) fail();
  const { run, intent, approvedManifest: manifest, proposedChanges } = request;
  if (!exactKeys(run, [
    'id', 'repositoryId', 'issueId', 'issueNumber', 'approverId', 'manifestSha256',
    'baseSha', 'expectedHeadSha', 'generation',
  ]) || !UUID.test(run.id) || !positiveId(run.repositoryId) || !positiveId(run.issueId)
    || !positiveId(run.issueNumber) || !positiveId(run.approverId)
    || !SHA256.test(run.manifestSha256) || !SHA1.test(run.baseSha)
    || !SHA1.test(run.expectedHeadSha) || !positiveId(run.generation)) fail();
  if (!exactKeys(intent, ['id']) || !SHA256.test(intent.id)) fail();
  if (!isRecord(manifest) || !isRecord(manifest.repository) || !isRecord(manifest.issue)
    || !isRecord(manifest.approver) || !isRecord(manifest.base)
    || manifest.repository.name !== REPOSITORY_FULL_NAME
    || manifest.repository.id !== run.repositoryId
    || manifest.issue.id !== run.issueId || manifest.issue.number !== run.issueNumber
    || manifest.approver.id !== run.approverId
    || manifest.base.branch !== BASE_BRANCH || manifest.base.revision !== run.baseSha
    || sha256(canonicalJson(manifest)) !== run.manifestSha256
    || !Array.isArray(proposedChanges)) fail();
  return freezeDeep(request);
}

export function validatePublicationContext(value, run, now = Date.now()) {
  if (!isRecord(value)) fail('publication_context_invalid');
  if (!value.signingPreflight) fail('signing_preflight_missing');
  if (!exactKeys(value, [
    'token', 'tokenExpiresAt', 'contextExpiresAt', 'repositoryId', 'repositoryName',
    'appId', 'installationId', 'actor', 'signingPreflight',
  ])) fail('publication_context_invalid');
  const tokenExpiry = Date.parse(value.tokenExpiresAt);
  const contextExpiry = Date.parse(value.contextExpiresAt);
  const preflight = value.signingPreflight;
  if (typeof value.token !== 'string' || !/^[!-~]{1,4096}$/.test(value.token)
    || !validTimestamp(value.tokenExpiresAt) || !Number.isFinite(tokenExpiry)
    || tokenExpiry <= now || tokenExpiry > now + 65 * 60_000
    || !validTimestamp(value.contextExpiresAt) || !Number.isFinite(contextExpiry) || contextExpiry <= now
    || contextExpiry > now + 5 * 60_000
    || tokenExpiry < contextExpiry || value.repositoryId !== run.repositoryId
    || value.repositoryName !== REPOSITORY_FULL_NAME || !positiveId(value.appId)
    || !positiveId(value.installationId) || !exactKeys(value.actor, ['databaseId', 'login'])
    || !positiveId(value.actor.databaseId) || !safeLogin(value.actor.login)
    || !exactKeys(preflight, [
      'repositoryId', 'repositoryName', 'appId', 'installationId', 'expiresAt', 'commit',
    ]) || preflight.repositoryId !== value.repositoryId
    || preflight.repositoryName !== value.repositoryName || preflight.appId !== value.appId
    || preflight.installationId !== value.installationId
    || !validTimestamp(preflight.expiresAt)
    || Date.parse(preflight.expiresAt) <= now
    || Date.parse(preflight.expiresAt) > contextExpiry) fail('signing_preflight_missing');
  const commit = preflight.commit;
  if (!exactKeys(commit, ['oid', 'author', 'committer', 'signature'])
    || !SHA1.test(commit.oid)
    || !actorMatches(commit.author, value.actor) || !actorMatches(commit.committer, value.actor)
    || !validSignature(commit.signature)) fail('signing_preflight_missing');
  return freezeDeep(value);
}

function actorMatches(candidate, actor) {
  return exactKeys(candidate, ['databaseId', 'login'])
    && positiveId(candidate.databaseId) && safeLogin(candidate.login)
    && candidate.databaseId === actor.databaseId
    && candidate.login.toLowerCase() === actor.login.toLowerCase();
}

function validSignature(signature) {
  return exactKeys(signature, ['isValid', 'state', 'wasSignedByGitHub'])
    && signature.isValid === true && signature.state === 'VALID'
    && signature.wasSignedByGitHub === true;
}

export function validateApprovalResult(result, request) {
  const { run, approvedManifest: manifest } = request;
  if (!isRecord(result) || result.authorized !== true || result.reason !== 'approved'
    || !isRecord(result.evidence)) return false;
  const evidence = result.evidence;
  return evidence.repositoryId === run.repositoryId
    && evidence.issueId === run.issueId && evidence.issueNumber === run.issueNumber
    && evidence.approverId === run.approverId
    && evidence.manifestSha256 === run.manifestSha256
    && evidence.baseRevision === run.baseSha
    && evidence.policyRevision === manifest.policyRevision;
}

export function validateFenceResult(result, request, operationHash, phase) {
  const { run, intent } = request;
  return isRecord(result)
    && ['execute', 'reconcile_only'].includes(result.decision)
    && result.runId === run.id && result.generation === run.generation
    && result.intentId === intent.id && result.operationHash === operationHash
    && result.expectedHeadSha === run.expectedHeadSha && result.phase === phase;
}

function safeTreePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.startsWith('/')
    || path.includes('\\') || /[\u0000-\u001f\u007f-\u009f]/u.test(path)) return false;
  const parts = path.split('/');
  return !parts.some(part => part === '' || part === '.' || part === '..');
}

export function parseGitTree(response, expectedTreeSha) {
  if (!isRecord(response) || response.sha !== expectedTreeSha
    || response.truncated !== false || !Array.isArray(response.tree)
    || response.tree.length > MAX_TREE_ENTRIES) fail('tree_incomplete');
  const tree = new Map();
  for (const entry of response.tree) {
    if (!isRecord(entry) || !safeTreePath(entry.path) || tree.has(entry.path)
      || !SHA1.test(entry.sha) || !TREE_MODES.has(entry.mode)
      || TREE_MODES.get(entry.mode) !== entry.type) fail('tree_invalid');
    tree.set(entry.path, Object.freeze({
      path: entry.path,
      mode: entry.mode,
      sha: entry.sha,
      blobSha: entry.mode === '040000' ? null : entry.sha,
    }));
  }
  for (const path of tree.keys()) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const parent = tree.get(parts.slice(0, index).join('/'));
      if (!parent || parent.mode !== '040000') fail('tree_invalid');
    }
  }
  return tree;
}

export function validationBaseFromTree(tree, allowedPaths) {
  const needed = new Set();
  for (const path of allowedPaths) {
    if (typeof path !== 'string') fail('patch_rejected');
    needed.add(path);
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      needed.add(parts.slice(0, index).join('/'));
    }
    for (const existingPath of tree.keys()) {
      if (existingPath.startsWith(`${path}/`)) needed.add(existingPath);
    }
  }
  for (const path of needed) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join('/');
      if (tree.has(path) && !tree.has(parent)) fail('tree_invalid');
    }
  }
  return [...needed].map(path => {
    const entry = tree.get(path);
    return entry
      ? { path, mode: entry.mode, blobSha: entry.blobSha }
      : { path, mode: null, blobSha: null };
  });
}

export function buildOperationHash(request, accepted) {
  const operation = {
    runId: request.run.id,
    repositoryId: request.run.repositoryId,
    baseSha: request.run.baseSha,
    expectedHeadSha: request.run.expectedHeadSha,
    manifestSha256: request.run.manifestSha256,
    changes: accepted.map(change => ({
      operation: change.operation,
      path: change.path,
      content: change.content,
      currentMode: change.operation === 'create' ? null : change.mode,
      currentBlobSha: change.expectedBlobSha,
      resultMode: change.mode,
      contentBlobSha: change.contentBlobSha,
      contentBytes: change.contentBytes,
    })),
  };
  return sha256(canonicalJson(operation));
}

export function verifyCommitProof(proof, expected) {
  if (!isRecord(proof) || proof.repositoryId !== expected.repositoryId
    || proof.repositoryName !== REPOSITORY_FULL_NAME || !isRecord(proof.commit)
    || proof.commit.oid !== expected.oid || !SHA1.test(proof.commit.oid)
    || !isRecord(proof.commit.tree) || !SHA1.test(proof.commit.tree.oid)
    || !Array.isArray(proof.commit.parents) || proof.commit.parents.length !== 1
    || proof.commit.parents[0] !== expected.parentSha
    || !actorMatches(proof.commit.author, expected.actor)
    || !actorMatches(proof.commit.committer, expected.actor)
    || !validSignature(proof.commit.signature)) return false;
  return true;
}

export function verifyOwnedCommitProof(proof, expected) {
  if (!isRecord(proof) || proof.repositoryId !== expected.repositoryId
    || proof.repositoryName !== REPOSITORY_FULL_NAME || !isRecord(proof.commit)
    || proof.commit.oid !== expected.oid || !SHA1.test(proof.commit.oid)
    || !isRecord(proof.commit.tree) || !SHA1.test(proof.commit.tree.oid)
    || !Array.isArray(proof.commit.parents) || proof.commit.parents.length !== 1
    || !SHA1.test(proof.commit.parents[0])
    || !actorMatches(proof.commit.author, expected.actor)
    || !actorMatches(proof.commit.committer, expected.actor)
    || !validSignature(proof.commit.signature)) return null;
  return { treeSha: proof.commit.tree.oid, parentSha: proof.commit.parents[0] };
}

export function verifyTreeMatchesChanges(parentTree, committedTree, accepted) {
  const changedFiles = new Map(accepted.map(change => [change.path, change]));
  const ancestorPaths = new Set();
  for (const change of accepted) {
    const parts = change.path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      ancestorPaths.add(parts.slice(0, index).join('/'));
    }
  }
  for (const change of accepted) {
    const actual = committedTree.get(change.path);
    if (!actual || actual.mode !== change.mode || actual.sha !== change.contentBlobSha) return false;
  }
  const allPaths = new Set([...parentTree.keys(), ...committedTree.keys()]);
  for (const path of allPaths) {
    const before = parentTree.get(path);
    const after = committedTree.get(path);
    if (before?.mode === after?.mode && before?.sha === after?.sha) continue;
    if (changedFiles.has(path)) continue;
    if (ancestorPaths.has(path)
      && (!before || before.mode === '040000')
      && (!after || after.mode === '040000')) continue;
    return false;
  }
  return true;
}

export function validSha1(value) {
  return typeof value === 'string' && SHA1.test(value);
}

export function validSha256(value) {
  return typeof value === 'string' && SHA256.test(value);
}

export const DRAFT_PR_TEMPLATE = '## What does this PR contain?\n\n## Related issue\n\nLink the issue if there is one.\n\n## How was this tested?\n';

export function snapshotDraftPrRequest(value) {
  const request = cloneJson(value, { bytes: 0, nodes: 0, seen: new WeakSet() });
  if (!exactKeys(request, ['run', 'intent', 'approvedManifest'])
    || !exactKeys(request.intent, ['id', 'kind']) || request.intent.kind !== 'pr_create') fail();
  snapshotPublicationRequest({ ...request, intent: { id: request.intent.id }, proposedChanges: [] });
  if (request.run.expectedHeadSha === request.run.baseSha) fail();
  const { requiredChecks: checks, requiredWorkflowIdentities: workflows } = request.approvedManifest;
  if (!Array.isArray(checks) || checks.length < 1 || checks.length > 32
    || !Array.isArray(workflows) || workflows.length < 1 || workflows.length > 32
    || !checks.every(check => exactKeys(check, ['context', 'appId', 'workflowId'])
      && typeof check.context === 'string' && /^[A-Za-z0-9_. /-]{1,100}$/.test(check.context)
      && positiveId(check.appId) && positiveId(check.workflowId))
    || !workflows.every(workflow => isRecord(workflow) && positiveId(workflow.id)
      && positiveId(workflow.appId) && workflow.event === 'push'
      && workflow.path === '.github/workflows/test.yml' && validSha256(workflow.sha256)
      && Object.keys(workflow).every(key => ['id', 'appId', 'event', 'path', 'sha256', 'diagnostics'].includes(key)))
    || new Set(workflows.map(item => item.id)).size !== workflows.length
    || new Set(checks.map(item => `${item.workflowId}:${item.appId}:${item.context}`)).size !== checks.length
    || !checks.every(check => workflows.some(workflow => workflow.id === check.workflowId
      && workflow.appId === check.appId))
    || !workflows.every(workflow => checks.some(check => check.workflowId === workflow.id))) fail();
  return freezeDeep(request);
}

export function validatePullRequestContext(value, run) {
  const snapshot = cloneJson(value, { bytes: 0, nodes: 0, seen: new WeakSet() });
  if (!exactKeys(snapshot, ['publicationContext', 'installationToken'])) fail('pr_context_invalid');
  const context = validatePublicationContext(snapshot.publicationContext, run);
  const record = snapshot.installationToken;
  const supported = {
    metadata: ['read'], contents: ['read', 'write'], pull_requests: ['write'],
    actions: ['read'], checks: ['read'], issues: ['read'],
  };
  if (!exactKeys(record, ['repositoryId', 'repositoryName', 'appId', 'installationId',
    'tokenExpiresAt', 'tokenSha256', 'permissions'])
    || !['repositoryId', 'repositoryName', 'appId', 'installationId', 'tokenExpiresAt']
      .every(key => record[key] === context[key])
    || !validSha256(record.tokenSha256) || record.tokenSha256 !== sha256(context.token)
    || !isRecord(record.permissions) || record.permissions.pull_requests !== 'write'
    || Object.keys(record.permissions).some(key => !Object.hasOwn(supported, key)
      || !supported[key].includes(record.permissions[key]))) fail('pr_permissions_unconfirmed');
  return context;
}

export function buildDraftPrOperationHash(request) {
  return sha256(canonicalJson({ kind: 'pr_create', runId: request.run.id,
    repositoryId: request.run.repositoryId, issueId: request.run.issueId,
    issueNumber: request.run.issueNumber, manifestSha256: request.run.manifestSha256,
    baseSha: request.run.baseSha, expectedHeadSha: request.run.expectedHeadSha,
    branch: deriveBranchName(request.run.id), intentId: request.intent.id,
    templateSha256: sha256(DRAFT_PR_TEMPLATE) }));
}

export function draftPrContent(request, operationHash) {
  const { run, approvedManifest: manifest } = request;
  const summary = `Approved bounded changes for issue ${run.issueNumber}.\n`
    + `Run: ${run.id}\nManifest: ${run.manifestSha256}\n`
    + `Acceptance: maintainer-approved manifest; human review required.\n`
    + `<!-- mellon-agent-run:${run.id} operation:${operationHash} -->`;
  const checks = `${manifest.requiredChecks.length} required checks across `
    + `${manifest.requiredWorkflowIdentities.length} approved push workflows passed before creation.\n`
    + `Evidence: https://github.com/${REPOSITORY_FULL_NAME}/commit/${run.expectedHeadSha}/checks\n`
    + `This PR remains a draft for maintainer review.`;
  return Object.freeze({ title: `Agent work for issue ${run.issueNumber}`,
    body: DRAFT_PR_TEMPLATE.replace('## What does this PR contain?\n',
      `## What does this PR contain?\n\n${summary}\n`)
      .replace('Link the issue if there is one.',
        `https://github.com/${REPOSITORY_FULL_NAME}/issues/${run.issueNumber}`)
      .replace('## How was this tested?\n', `## How was this tested?\n\n${checks}\n`) });
}

export function validateInitialChecks(value, request, branch) {
  let result;
  try {
    result = cloneJson(value, { bytes: 0, nodes: 0, seen: new WeakSet() });
  } catch {
    return false;
  }
  const { run, approvedManifest: manifest } = request;
  if (!isRecord(result) || Object.keys(result).some(key => !['status', 'repositoryId',
    'headSha', 'branch', 'event', 'runs', 'checks', 'runId', 'runAttempt'].includes(key))
    || result.status !== 'success' || result.repositoryId !== run.repositoryId
    || result.headSha !== run.expectedHeadSha || result.branch !== branch || result.event !== 'push'
    || !Array.isArray(result.runs) || result.runs.length !== manifest.requiredWorkflowIdentities.length
    || !Array.isArray(result.checks) || result.checks.length !== manifest.requiredChecks.length) return false;
  const seenWorkflows = new Set();
  const seenRuns = new Set();
  const seenChecks = new Set();
  const flattened = [];
  for (const evidence of result.runs) {
    if (!isRecord(evidence) || Object.keys(evidence).some(key => !['workflowId', 'runId',
      'runAttempt', 'headSha', 'checks', 'diagnostic'].includes(key))) return false;
    const workflow = manifest.requiredWorkflowIdentities.find(item => item.id === evidence.workflowId);
    const required = manifest.requiredChecks.filter(item => item.workflowId === evidence.workflowId);
    if (!workflow || seenWorkflows.has(evidence.workflowId) || seenRuns.has(evidence.runId)
      || !positiveId(evidence.runId) || !positiveId(evidence.runAttempt) || evidence.runAttempt > 1000
      || evidence.headSha !== run.expectedHeadSha || !Array.isArray(evidence.checks)
      || evidence.checks.length !== required.length) return false;
    seenWorkflows.add(evidence.workflowId);
    seenRuns.add(evidence.runId);
    for (const check of evidence.checks) {
      if (!exactKeys(check, ['checkRunId', 'checkSuiteId', 'appId', 'status', 'conclusion', 'headSha'])
        || !positiveId(check.checkRunId) || !positiveId(check.checkSuiteId)
        || seenChecks.has(check.checkRunId) || check.appId !== workflow.appId
        || check.status !== 'completed' || check.conclusion !== 'success'
        || check.headSha !== run.expectedHeadSha) return false;
      seenChecks.add(check.checkRunId);
      flattened.push(check);
    }
  }
  if (Object.hasOwn(result, 'runId') || Object.hasOwn(result, 'runAttempt')) {
    if (result.runs.length !== 1 || result.runId !== result.runs[0].runId
      || result.runAttempt !== result.runs[0].runAttempt) return false;
  }
  // Context names are verified by the trusted check reader, which returns IDs only.
  return canonicalJson(flattened) === canonicalJson(result.checks);
}

export function validateDraftPr(pr, request, branch, context, content) {
  const repoMatches = repo => isRecord(repo) && repo.id === request.run.repositoryId
    && repo.full_name === REPOSITORY_FULL_NAME && repo.owner?.login === REPOSITORY_OWNER;
  return isRecord(pr) && positiveId(pr.id) && positiveId(pr.number)
    && pr.state === 'open' && pr.draft === true && pr.merged_at === null
    && pr.title === content.title && pr.body === content.body
    && pr.user?.id === context.actor.databaseId && pr.user?.type === 'Bot'
    && typeof pr.user.login === 'string'
    && pr.user.login.toLowerCase() === context.actor.login.toLowerCase()
    && pr.head?.ref === branch && pr.head.sha === request.run.expectedHeadSha
    && pr.head.label === `${REPOSITORY_OWNER}:${branch}` && repoMatches(pr.head.repo)
    && pr.base?.ref === BASE_BRANCH && pr.base.sha === request.run.baseSha && repoMatches(pr.base.repo);
}
