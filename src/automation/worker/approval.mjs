import { createHash, timingSafeEqual } from 'node:crypto';
import { readBytes } from '../http.mjs';
import { validateChanges } from './patch.mjs';
import { validManifestModel } from './model-profile.mjs';
import { validQodoIdentity } from './review-contract.mjs';
import { CONSERVATIVE_INPUT_MODE, MAX_INPUT_RESERVATION } from './input-budget.mjs';

const DATABASE_SKIP_POLICY_SHA256 = 'bc69e450cbe6f7bb10dfeeaf4ba71d3393cd2047563fd7af53ad32506b212eab';

const API_ROOT = 'https://api.github.com';
const REPOSITORY = 'randoneering/mellon';
const BASE_BRANCH = 'main';
const READINESS_LABEL = 'agent: ready';
const RESPONSE_LIMIT = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5000;
const SHA256 = /^[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const DIAGNOSTIC_SOURCE_PATHS = [
  'automation/ci/guard-command.mjs',
  'automation/ci/run-tests.mjs',
  'automation/ci/test-reporter.mjs',
  'automation/ci/report-annotations.mjs',
  'scripts/lib/output-guard.mjs',
  'package.json',
];
const ALLOWED_LIMITS = {
  nonterminalPilotRuns: 1,
  modelCallsPerTick: 1,
  modelCallsPerRun: 20,
  inputTokensPerCall: 8000,
  outputTokensPerCall: 2000,
  inputTokensPerRun: 100000,
  outputTokensPerRun: 20000,
  tickDeadlineSeconds: 90,
  modelCallDeadlineSeconds: 45,
  leaseSeconds: 180,
  expiredLeaseRecoveries: 2,
  ciWaitSeconds: 1800,
  reviewWaitSeconds: 1800,
  runLifetimeSeconds: 7200,
  repairCycles: 2,
};
const REQUIRED_MANIFEST_KEYS = [
  'version', 'approved', 'repository', 'issue', 'approver', 'base',
  'policyRevision', 'pilotScope', 'allowedPaths', 'acceptanceCriteria', 'requiredChecks',
  'requiredWorkflowIdentities', 'model', 'qodoIdentities', 'limits',
];

function denied(reason) {
  return { authorized: false, reason };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameKeys(value, expected) {
  return isRecord(value)
    && Object.keys(value).length === expected.length
    && expected.every(key => Object.hasOwn(value, key));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashMatches(value, expected) {
  if (!SHA256.test(value) || !SHA256.test(expected)) return false;
  return timingSafeEqual(Buffer.from(value, 'hex'), Buffer.from(expected, 'hex'));
}

function validStringList(value, { maxItems = 64, maxLength = 500 } = {}) {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= maxItems
    && new Set(value).size === value.length
    && value.every(item => typeof item === 'string'
      && item.length > 0
      && item.length <= maxLength
      && item.trim() === item);
}

function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validPilotScope(scope) {
  return sameKeys(scope, ['kind', 'maxChangedFiles', 'maxFileBytes', 'maxTotalBytes'])
    && scope.kind === 'bounded-public-issue'
    && positiveId(scope.maxChangedFiles) && scope.maxChangedFiles <= 10
    && positiveId(scope.maxFileBytes) && scope.maxFileBytes <= 65536
    && positiveId(scope.maxTotalBytes) && scope.maxTotalBytes <= 262144
    && scope.maxFileBytes <= scope.maxTotalBytes;
}

function validDiagnostics(diagnostics) {
  return sameKeys(diagnostics, ['version', 'sources', 'reporter', 'skipPolicy'])
    && diagnostics.version === 2
    && sameKeys(diagnostics.skipPolicy, ['version', 'sha256'])
    && diagnostics.skipPolicy.version === 1
    && diagnostics.skipPolicy.sha256 === DATABASE_SKIP_POLICY_SHA256
    && Array.isArray(diagnostics.sources)
    && diagnostics.sources.length === DIAGNOSTIC_SOURCE_PATHS.length
    && diagnostics.sources.every((source, index) => sameKeys(source, ['path', 'sha256'])
      && source.path === DIAGNOSTIC_SOURCE_PATHS[index]
      && typeof source.sha256 === 'string' && SHA256.test(source.sha256))
    && new Set(diagnostics.sources.map(source => source.path)).size === DIAGNOSTIC_SOURCE_PATHS.length
    && new Set(diagnostics.sources.map(source => source.sha256)).size === DIAGNOSTIC_SOURCE_PATHS.length
    && sameKeys(diagnostics.reporter, ['context', 'revision', 'sha256'])
    && diagnostics.reporter.context === 'test-report'
    && typeof diagnostics.reporter.revision === 'string' && REVISION.test(diagnostics.reporter.revision)
    && typeof diagnostics.reporter.sha256 === 'string' && SHA256.test(diagnostics.reporter.sha256);
}

function validWorkflowIdentity(workflow) {
  return sameKeys(workflow, ['id', 'path', 'sha256', 'appId', 'event', 'diagnostics'])
    && positiveId(workflow.id) && positiveId(workflow.appId)
    && workflow.path === '.github/workflows/test.yml'
    && typeof workflow.sha256 === 'string' && SHA256.test(workflow.sha256)
    && workflow.event === 'push'
    && validDiagnostics(workflow.diagnostics);
}

function validIdentities(manifest) {
  const workflows = manifest.requiredWorkflowIdentities;
  const qodo = manifest.qodoIdentities;
  if (!Array.isArray(workflows) || workflows.length === 0 || workflows.length > 32 ||
      !workflows.every(validWorkflowIdentity) ||
      new Set(workflows.map(workflow => workflow.id)).size !== workflows.length ||
      !Array.isArray(qodo) || qodo.length === 0 || qodo.length > 16 ||
      !qodo.every(validQodoIdentity) ||
      new Set(qodo.map(identity => identity.userId)).size !== qodo.length) return false;
  return manifest.requiredChecks.every(check => workflows.some(workflow =>
    workflow.id === check.workflowId && workflow.appId === check.appId))
    && workflows.every(workflow => manifest.requiredChecks.filter(check =>
      check.workflowId === workflow.id && check.appId === workflow.appId
        && check.context === workflow.diagnostics.reporter.context).length === 1)
    && new Set(manifest.requiredChecks.map(check => `${check.workflowId}:${check.appId}:${check.context}`)).size === manifest.requiredChecks.length;
}

/** Validate the optional pinned coordinator block without admitting a pilot. */
export function validateCoordinatorConfig(manifest) {
  if (!Object.hasOwn(manifest, 'coordinator')) return true;
  const config = manifest.coordinator;
  const regression = config?.regression;
  if (!sameKeys(config, ['version', 'regression']) || config.version !== 1
    || !sameKeys(regression, ['workflowId', 'testPathIndex', 'initial', 'repairTestNames'])
    || !sameKeys(regression.initial, ['criterionIndex', 'testName'])
    || !Number.isSafeInteger(regression.testPathIndex) || regression.testPathIndex < 0
    || regression.testPathIndex >= manifest.allowedPaths?.length
    || !Number.isSafeInteger(regression.initial.criterionIndex) || regression.initial.criterionIndex < 0
    || regression.initial.criterionIndex >= manifest.acceptanceCriteria?.length
    || !Array.isArray(regression.repairTestNames) || regression.repairTestNames.length !== 2) return false;
  const names = [regression.initial.testName, ...regression.repairTestNames];
  if (new Set(names).size !== 3 || names.some(name => typeof name !== 'string'
    || !name.length || name.length > 500 || /[\u0000-\u001f\u007f-\u009f]|::|##\[/u.test(name))) return false;
  const workflow = manifest.requiredWorkflowIdentities?.find(item => item.id === regression.workflowId);
  if (!workflow || !validWorkflowIdentity(workflow) || !manifest.requiredChecks
    || manifest.requiredChecks.filter(check => check.workflowId === workflow.id
      && check.appId === workflow.appId && check.context === 'test').length !== 1
    || manifest.requiredChecks.filter(check => check.workflowId === workflow.id
      && check.appId === workflow.appId && check.context === workflow.diagnostics.reporter.context).length !== 1) return false;
  const path = manifest.allowedPaths[regression.testPathIndex];
  if (typeof path !== 'string' || !path.endsWith('.test.mjs')) return false;
  try {
    const parts = path.split('/');
    const baseFiles = parts.map((_, index) => ({ path: parts.slice(0, index + 1).join('/'), mode: null, blobSha: null }));
    validateChanges(baseFiles, [{ operation: 'create', path, content: '' }], {
      allowedPaths: [path], pilotScope: { kind: 'bounded-public-issue', maxChangedFiles: 1, maxFileBytes: 65536, maxTotalBytes: 65536 },
    });
  } catch { return false; }
  return true;
}

function validReviewPolicy(manifest) {
  if (!Object.hasOwn(manifest, 'reviewPolicy')) return true;
  const policy = manifest.reviewPolicy;
  return Object.hasOwn(manifest, 'coordinator')
    && sameKeys(policy, ['version', 'profile'])
    && policy.version === 1
    && policy.profile === 'worker-command-maintainer-fallback-v1'
    && Array.isArray(manifest.qodoIdentities)
    && manifest.qodoIdentities.length > 0
    && manifest.qodoIdentities.every(identity => validQodoIdentity(identity)
      && identity.appId > 0 && identity.appSlug === 'qodo-code-review'
      && identity.completion === 'github-submitted-review-v1');
}

function validManifest(manifest) {
  const optionalKeys = [];
  if (isRecord(manifest) && Object.hasOwn(manifest, 'coordinator')) optionalKeys.push('coordinator');
  if (isRecord(manifest) && Object.hasOwn(manifest, 'reviewPolicy')) optionalKeys.push('reviewPolicy');
  const keys = [...REQUIRED_MANIFEST_KEYS, ...optionalKeys];
  if (!sameKeys(manifest, keys)
      || manifest.version !== 1
      || manifest.approved !== true
      || !sameKeys(manifest.repository, ['name', 'id'])
      || manifest.repository.name !== REPOSITORY
      || !Number.isSafeInteger(manifest.repository.id)
      || manifest.repository.id <= 0
      || !sameKeys(manifest.issue, ['id', 'number', 'contentSha256'])
      || !Number.isSafeInteger(manifest.issue.id)
      || manifest.issue.id <= 0
      || !Number.isSafeInteger(manifest.issue.number)
      || manifest.issue.number <= 0
      || typeof manifest.issue.contentSha256 !== 'string'
      || !SHA256.test(manifest.issue.contentSha256)
      || !sameKeys(manifest.approver, ['id', 'login'])
      || !Number.isSafeInteger(manifest.approver.id)
      || manifest.approver.id <= 0
      || typeof manifest.approver.login !== 'string'
      || !LOGIN.test(manifest.approver.login)
      || manifest.approver.login.toLowerCase() === 'ghost'
      || !sameKeys(manifest.base, ['branch', 'revision'])
      || manifest.base.branch !== BASE_BRANCH
      || typeof manifest.base.revision !== 'string' || !REVISION.test(manifest.base.revision)
      || typeof manifest.policyRevision !== 'string' || !REVISION.test(manifest.policyRevision)
      || !validPilotScope(manifest.pilotScope)
      || !validStringList(manifest.allowedPaths, { maxItems: 32, maxLength: 200 })
      || manifest.allowedPaths.some(path => path.startsWith('/') || path.split('/').includes('..'))
      || new Set(manifest.allowedPaths).size !== manifest.allowedPaths.length
      || !validStringList(manifest.acceptanceCriteria, { maxItems: 32 })
      || !Array.isArray(manifest.requiredChecks)
      || manifest.requiredChecks.length === 0
      || manifest.requiredChecks.length > 32
      || !manifest.requiredChecks.every(check => sameKeys(check, ['context', 'appId', 'workflowId'])
        && typeof check.context === 'string'
        && /^[A-Za-z0-9_. /-]{1,100}$/.test(check.context)
        && Number.isSafeInteger(check.appId)
        && check.appId > 0
        && positiveId(check.workflowId))
      || !validIdentities(manifest)
      || !validateCoordinatorConfig(manifest)
      || !validReviewPolicy(manifest)
      || !validManifestModel(manifest.model)
      || !sameKeys(manifest.limits, Object.keys(ALLOWED_LIMITS))) return false;

  const limits = manifest.limits;
  return Object.entries(ALLOWED_LIMITS).every(([key, maximum]) =>
    Number.isSafeInteger(limits[key])
      && limits[key] >= (['expiredLeaseRecoveries', 'repairCycles'].includes(key) ? 0 : 1)
      && limits[key] <= (key === 'inputTokensPerCall'
        && manifest.model.inputAdmission === CONSERVATIVE_INPUT_MODE
        ? MAX_INPUT_RESERVATION : maximum))
    && limits.modelCallsPerTick <= limits.modelCallsPerRun
    && limits.inputTokensPerCall <= limits.inputTokensPerRun
    && limits.outputTokensPerCall <= limits.outputTokensPerRun
    && limits.modelCallDeadlineSeconds <= limits.tickDeadlineSeconds
    && limits.tickDeadlineSeconds < limits.leaseSeconds
    && limits.leaseSeconds <= limits.runLifetimeSeconds
    && limits.ciWaitSeconds <= limits.runLifetimeSeconds
    && limits.reviewWaitSeconds <= limits.runLifetimeSeconds;
}

async function readJson(fetch, token, path, budget) {
  const response = await Promise.race([
    fetch(`${API_ROOT}${path}`, {
      method: 'GET', redirect: 'manual', signal: budget.signal,
      headers: {
        accept: 'application/vnd.github+json', authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
    }),
    budget.expired,
  ]);
  if (!response || response.status !== 200 || response.redirected === true || !response.body) {
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    throw new Error('github_read_failed');
  }
  const declaredLength = response.headers?.get?.('content-length');
  if (declaredLength !== null && declaredLength !== undefined
      && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > RESPONSE_LIMIT)) {
    void response.body.cancel().catch(() => {});
    throw new Error('github_read_failed');
  }
  const bytes = await Promise.race([
    readBytes(response.body, RESPONSE_LIMIT, Math.max(1, budget.deadline - Date.now())),
    budget.expired,
  ]);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

async function readLabels(fetch, token, path, budget) {
  const labels = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await readJson(fetch, token, `${path}?per_page=100&page=${page}`, budget);
    if (!Array.isArray(batch) || batch.length > 100 ||
        !batch.every(label => isRecord(label) && typeof label.name === 'string')) throw new Error('github_read_failed');
    labels.push(...batch);
    if (batch.length < 100 || batch.some(label => label.name.toLowerCase() === READINESS_LABEL)) return labels;
  }
  throw new Error('github_read_failed');
}

function contentHash(issue) {
  if (typeof issue.title !== 'string' || issue.body !== null && typeof issue.body !== 'string') return null;
  return sha256(JSON.stringify([issue.title, issue.body]));
}

export async function checkApproval({ manifest, expectedManifestSha256, token, fetch, timeoutMs = REQUEST_TIMEOUT_MS }) {
  // Keep validation, remote checks, and evidence bound to one caller-independent value.
  try { manifest = structuredClone(manifest); }
  catch { return denied('manifest_invalid'); }
  if (!validManifest(manifest)) return denied('manifest_invalid');
  if (typeof expectedManifestSha256 !== 'string'
      || !SHA256.test(expectedManifestSha256)
      || !hashMatches(sha256(canonicalJson(manifest)), expectedManifestSha256)) {
    return denied('manifest_pin_mismatch');
  }
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096
      || typeof fetch !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      timeoutMs > REQUEST_TIMEOUT_MS) return denied('approval_input_invalid');

  const root = `/repos/${REPOSITORY}`;
  const controller = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('github_read_failed')); }, timeoutMs);
  });
  const budget = { signal: controller.signal, expired, deadline: Date.now() + timeoutMs };
  try {
    const [repository, issue, labels, actor, permission, branch] = await Promise.all([
      readJson(fetch, token, root, budget),
      readJson(fetch, token, `${root}/issues/${manifest.issue.number}`, budget),
      readLabels(fetch, token, `${root}/issues/${manifest.issue.number}/labels`, budget),
      readJson(fetch, token, `/users/${manifest.approver.login}`, budget),
      readJson(fetch, token, `${root}/collaborators/${manifest.approver.login}/permission`, budget),
      readJson(fetch, token, `${root}/branches/${BASE_BRANCH}`, budget),
    ]);

    if (!isRecord(repository) || repository.id !== manifest.repository.id
        || repository.full_name?.toLowerCase() !== REPOSITORY) {
      return denied('repository_identity_mismatch');
    }
    if (repository.private !== false) return denied('repository_not_public');
    if (!isRecord(issue) || issue.id !== manifest.issue.id || issue.number !== manifest.issue.number ||
        typeof issue.repository_url !== 'string' || issue.repository_url.toLowerCase() !== `${API_ROOT}${root}`) {
      return denied('issue_identity_mismatch');
    }
    if (issue.state !== 'open') return denied('issue_not_open');
    if (Object.hasOwn(issue, 'pull_request')) return denied('issue_is_pull_request');
    if (contentHash(issue) !== manifest.issue.contentSha256) return denied('content_mismatch');
    if (!Array.isArray(labels) || !labels.every(label => isRecord(label) && typeof label.name === 'string')) {
      return denied('github_read_failed');
    }
    if (!labels.some(label => label.name.toLowerCase() === READINESS_LABEL)) {
      return denied('readiness_label_missing');
    }
    if (!isRecord(actor) || actor.id !== manifest.approver.id
        || typeof actor.login !== 'string'
        || actor.login.toLowerCase() !== manifest.approver.login.toLowerCase()
        || actor.type !== 'User') return denied('approver_identity_mismatch');
    if (!isRecord(permission) || !['write', 'maintain', 'admin'].includes(permission.permission)) {
      return denied('approver_permission_missing');
    }
    if (!isRecord(permission.user) || permission.user.id !== manifest.approver.id ||
        typeof permission.user.login !== 'string' || permission.user.login.toLowerCase() !== manifest.approver.login.toLowerCase() ||
        permission.user.type !== 'User') return denied('permission_identity_mismatch');
    if (!isRecord(branch) || branch.name !== BASE_BRANCH
        || !isRecord(branch.commit) || branch.commit.sha !== manifest.base.revision) {
      return denied('base_revision_mismatch');
    }

    return {
      authorized: true,
      reason: 'approved',
      evidence: {
        repositoryId: manifest.repository.id,
        issueId: manifest.issue.id,
        issueNumber: manifest.issue.number,
        approverId: manifest.approver.id,
        approverLogin: manifest.approver.login,
        contentSha256: manifest.issue.contentSha256,
        baseRevision: manifest.base.revision,
        policyRevision: manifest.policyRevision,
        manifestSha256: expectedManifestSha256,
      },
    };
  } catch {
    return denied('github_read_failed');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
