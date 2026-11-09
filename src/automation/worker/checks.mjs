import { createHash, timingSafeEqual } from 'node:crypto';
import { readBytes } from '../http.mjs';

// Reviewed Node 24 DB-guard identities; provenance is in docs/agent-worker-ci.md.
const DATABASE_SKIP_IDENTITIES = Object.freeze([
  '054c8cebc9f59c0f5b3df8645b83269d4869f288e4773579ff095bfcc8711916',
  '06f53c57b7875ac7d27e507ab59de75f4601209dc58983b10f69036d4f0ad911',
  '073893e4b507150916036e54c92851b867d7d33a73fcb4a67cb9fdb4a9ec21c9',
  '09d72ef105de01bfaf403c942a714a28bc82bc304e57019e8af60c22cfb29c0e',
  '0b9361c3727b0ef8d53bbff3030fd9ba2a100e161c0c256723eccba14cf749b0',
  '0fad7c720bf4c1fafa0c38d76669ed51f38f7c664ac1b3dccdd7ed421d4f8306',
  '163fa9b39f0587f0d3af8cf3210a4268f3eee4a9aad0a7199084a52e626826f3',
  '1683107fd49d173374111c3af2778cde6c7c08736c2fe64aa5785aac69d4975f',
  '194abf4587f35bbf8c037012ed12c1eaf3dd0ef55d1cf5fada8b4263c094bbe3',
  '1f54d40a00c740e78458e9c95883bbd96937fa9fa4ff51daa380a8ff30f95adc',
  '2b0b8715261ad60afd4709a279b8d4f2d3a9a2ef201c4dea970b4f9fbf61621b',
  '2baa5705bbc72d527fc1607d0d64d8173432cae8b34a6dfb13a62fc5a4dd3eda',
  '2cbad49675c7efd17571f47dda52105b53308c984a839bce01557acb4f89223f',
  '2e23a4afccc05cfaa0de683285bfea57b2424e8f9ab9147b5c1942a8c392c012',
  '38bfb735bd76915a81a33ad9c4be6114cb8c6a69b587057ad2705d9ec85676d5',
  '392e42a4eb60f95fdb429cb23b34a549f903b1482887948d6cdb7ac318b1ede7',
  '3aa113afae75d8a35ff9e73a050439891f263604112cc7cee95c6e24ce96dd17',
  '47b077b2c0dd42055a5762137f5a7f223e6d3eb29a6dfb97798547c61f41a5f7',
  '4ec67740b10db940f9cb6b68944140680007291734e667dcba496b8b646dacc8',
  '522d920ab082dae3e5d02f096ba97b00aac86a9621bbe81dcbc333dbb9a86b4f',
  '536a7f5a95a1f09ab1ad213eeaf4ec002229b33d95511d97a48740a53b7874ec',
  '5689f6b7ce57eed41fa99126c0ba14a839d3b22b7eb11e2295cf5159bb7a933e',
  '5ca8158c655bb17c3273e0f116593a9d658d928b9d651ba12e654bd36d7e9d52',
  '6943c432a17e2dfd6b47f398926bd05bba64d3347dfe666be90fcd57ad205282',
  '7a0b5d45ba181d03eabf7b6859d6cdf0b284f5a3fd868cb99072673fcd41060b',
  '819f41c8a33f9af1bf78efc211a6caace85ca3c72ba9d528616b3cd66407c771',
  '88f5e2edb2cd224859f784fd4a7e3216619192d554fa77de163128b620c7fa8a',
  '892861a24581f413392210e5a83aa0b3358edcfeeabb984335f42621dd408400',
  '8a08bf1f3962c2a50dd0bcb885f2bc9c30c9c00db43a6b8c790fc1e96a456792',
  '8e5f94441fa70f8f8e1e8e670edd98d0fdd18225b4a6b60173fb8401ef5705a8',
  '96978d049fe6694893ed9b2fd4837fb3ccb59fac92705440a76b7c6255140f05',
  '96d460ace5da371943ba558997cf752a74ae70866aa64f3a7febe767f543a19d',
  '9b01be3a8bd040167f95b1454cf9f956a3bdcf0f32deef9b062c4d16e0d2fd84',
  '9e669c1aad933f44c2c856867d37d15e6d6f2191f678944a9bf66b11536ccb9f',
  'a92115413c22249f2459ba60a22daf84273945d96b30aa4d26b7f0102e94f40d',
  'b0aaf0ddd3b557c44782ff485a1e836430e404a1c62d5183e603ab37c591093b',
  'b3a8ae769e55b89259d4a23cc495d8cfde6900b1f75496ac3238dd4e73f60edd',
  'b99e8f48d78366cdc488e2ac8e4dfa560a846182e21664968d669b7d34b34c28',
  'bb3582afe4d546be92e5fbb14a32c64ab4d2d56ed1876e11f75ae8f120b9c577',
  'bcdda4a74dfbe9cec3c179e706840854c8e30f33759709d793f5b59339ce6b00',
  'bfbf71945ff40f5807727d3e9aa009e1ba5f8763db15e74f8b6e9d115bce89e9',
  'ca6e548eee2c834dc6406da98fe02623a7f6503bbab9058b52fd07295e236da1',
  'd1c1e205b8e1c52fecda36df90cf4bf3d8a51257f65bc647e6be13fe53c46f0b',
  'd4c2612bcd51bfcdc0a906197be9247dc6d08b5b58087d0788d25e78f0f1fa05',
  'd50be9b0b1afcdff68c30009b314428422d59ed3037e6db457c94a8bf962af97',
  'd62fca6fcda07658e44eb3ae4ac26d731deb7e6a0f02c5e1a7abda74fc9d3a17',
  'd6b6542401f6d304e187b41d8d3fda7ca2a400ff2849318087479907342b2fb1',
  'd79eb01949f75ac5d93ecd2b83bf1bc548d1ddd0763b2a528af62211cd4aae8d',
  'd8454531b1b70f0746af68a8b210ccf0a8f24c5915a9694a4c8b650c096c197d',
  'dbc78016e62839718446d0279b1f444e51bcc304dc77b65492fad6a6c863d97d',
  'de02bcac3413af36f31b898cb4b37fa479053ed0cabe5b9ce8e760fb219ffcf0',
  'dfdfcec66e375d68afaf56ac7c69c8ecae3ba1c7f3fef5026d0bae93a5bff5c2',
  'e1506f889542ae0ce4948e9fd2014ceb021e6f2fea8dfccb80903d7008988c02',
  'e2832ccade822e9d01920deae34ef633d2f7940cd63fdaf0705470b6e3d66299',
  'e9a1ad85b678bfeb22a68ba195f1c93e2e7d5cd16bde070d85bcb5724169c244',
  'eaac2a86ba645efa1788da064367a2b73c84e08312e4156756bd3e1ba7f3c90d',
  'ed5d204b0eadbb7c629110a62d52f6789497376b3a76ec80edf827211fe625dd',
  'f0b06beee82fe7361694cebdd880eb2826e3ab6833f90fc7a1d5a83aa249517c',
  'f0d17beef5057213db8a5f71bbf6e574628056be8f4a87f5b8b56ee6a7a6801a',
  'f0d3fd69420d0be6d7e9b5ada2fabb5c42ac57553fef5e2e6cc11b231f33eee6',
  'f3fa47ae507f179e29f7da1499ecc50f96bbc9eeea8e6b089359baee22a428fb',
  'f78af322925bbc9076f0ad31a27a6f59234cd20849ce349df178cfa9d7a05557',
]);
const DATABASE_SKIP_POLICY_SHA256 = 'bc69e450cbe6f7bb10dfeeaf4ba71d3393cd2047563fd7af53ad32506b212eab';

const API_ROOT = 'https://api.github.com';
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_PAGES = 10;
const MAX_ANNOTATION_PAGES = 3;
const PAGE_SIZE = 100;
const MAX_ANNOTATIONS = MAX_ANNOTATION_PAGES * PAGE_SIZE;
const MAX_ANNOTATION_MESSAGE_BYTES = 32 * 1024;
const REPORT_PREFIX = 'MELLON_CI_REPORT_V2:';
const CHUNK_PREFIX = 'MELLON_CI_REPORT_V2_CHUNK:';
const CHUNK_DATA_LENGTH = 3500;
const MAX_REPORT_CHUNKS = 10;
const MAX_REPORT_BYTES = 24 * 1024;
const MAX_FAILURES = 64;
const MAX_TEST_EVENTS = 20000;
const RUN_ATTEMPT_LIMIT = 1000;
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RUN_ID = /^[1-9][0-9]{0,15}$/;
const DIAGNOSTIC_PATHS = [
  'automation/ci/guard-command.mjs',
  'automation/ci/run-tests.mjs',
  'automation/ci/test-reporter.mjs',
  'automation/ci/report-annotations.mjs',
  'scripts/lib/output-guard.mjs',
  'package.json',
];
const FAILURE_CATEGORIES = new Set(['assertion', 'other', 'setup', 'syntax']);
const COUNT_KEYS = [
  'testCount', 'passedTestCount', 'failedTestCount', 'aggregateFailureCount',
  'assertionFailureCount', 'setupFailureCount', 'syntaxFailureCount', 'otherFailureCount',
  'skippedTestCount', 'todoTestCount', 'cancelledTestCount', 'rootFailureCount',
];
const REPORT_KEYS = [
  'schemaVersion', 'complete', 'truncated', 'reason', 'context', 'producerSha256',
  'counts', 'failures', 'rootFailures', 'processExitCode', 'formatterRevision',
  'skipPolicySha256', 'skippedTestIdentitySha256s',
];
const REASONS = new Set([
  'invalid_input', 'github_read_failed', 'run_mismatch', 'workflow_hash_mismatch',
  'required_check_missing', 'check_ambiguous', 'check_incomplete', 'intended_red_unverified',
  'workflow_not_successful', 'diagnostic_unverified', 'diagnostic_ambiguous',
]);
const INCOMPLETE_REPORT_REASONS = new Set([
  'event_limit', 'failure_limit', 'identity_ambiguous', 'invalid_context',
  'malformed_event', 'no_tests', 'report_limit', 'unsupported_event', 'test_limit',
]);

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

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function equalHash(actual, expected) {
  return typeof actual === 'string' && typeof expected === 'string'
    && SHA256.test(actual) && SHA256.test(expected)
    && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validDiagnostics(diagnostics) {
  return sameKeys(diagnostics, ['version', 'sources', 'reporter', 'skipPolicy'])
    && diagnostics.version === 2
    && sameKeys(diagnostics.skipPolicy, ['version', 'sha256'])
    && diagnostics.skipPolicy.version === 1
    && diagnostics.skipPolicy.sha256 === DATABASE_SKIP_POLICY_SHA256
    && sha256(Buffer.from(canonicalJson({ version: 1, testIdentitySha256s: DATABASE_SKIP_IDENTITIES }), 'utf8'))
      === DATABASE_SKIP_POLICY_SHA256
    && Array.isArray(diagnostics.sources)
    && diagnostics.sources.length === DIAGNOSTIC_PATHS.length
    && diagnostics.sources.every((source, index) => sameKeys(source, ['path', 'sha256'])
      && source.path === DIAGNOSTIC_PATHS[index]
      && typeof source.sha256 === 'string' && SHA256.test(source.sha256))
    && new Set(diagnostics.sources.map(source => source.path)).size === DIAGNOSTIC_PATHS.length
    && new Set(diagnostics.sources.map(source => source.sha256)).size === DIAGNOSTIC_PATHS.length
    && sameKeys(diagnostics.reporter, ['context', 'revision', 'sha256'])
    && diagnostics.reporter.context === 'test-report'
    && typeof diagnostics.reporter.revision === 'string' && SHA.test(diagnostics.reporter.revision)
    && typeof diagnostics.reporter.sha256 === 'string' && SHA256.test(diagnostics.reporter.sha256);
}

function validWorkflowIdentity(workflow) {
  const keys = Object.keys(workflow ?? {});
  return isRecord(workflow) && keys.length === 6
    && positiveId(workflow.id) && positiveId(workflow.appId)
    && workflow.path === '.github/workflows/test.yml'
    && typeof workflow.sha256 === 'string' && SHA256.test(workflow.sha256)
    && workflow.event === 'push'
    && validDiagnostics(workflow.diagnostics);
}

function validManifest(manifest, repository) {
  if (!isRecord(manifest) || Object.keys(manifest).length !== 3
      || !sameKeys(manifest.repository, ['name', 'id'])
      || manifest.repository.name !== repository || !positiveId(manifest.repository.id)
      || !Array.isArray(manifest.requiredChecks) || manifest.requiredChecks.length < 1
      || manifest.requiredChecks.length > 32
      || !manifest.requiredChecks.every(check => sameKeys(check, ['context', 'appId', 'workflowId'])
        && typeof check.context === 'string' && /^[A-Za-z0-9_. /-]{1,100}$/.test(check.context)
        && positiveId(check.appId) && positiveId(check.workflowId))
      || new Set(manifest.requiredChecks.map(check => `${check.workflowId}:${check.appId}:${check.context}`)).size
        !== manifest.requiredChecks.length
      || !Array.isArray(manifest.requiredWorkflowIdentities)
      || manifest.requiredWorkflowIdentities.length < 1
      || manifest.requiredWorkflowIdentities.length > 32
      || !manifest.requiredWorkflowIdentities.every(validWorkflowIdentity)
      || new Set(manifest.requiredWorkflowIdentities.map(item => item.id)).size
        !== manifest.requiredWorkflowIdentities.length) return false;
  return manifest.requiredWorkflowIdentities.every(workflow =>
    manifest.requiredChecks.some(check => check.workflowId === workflow.id && check.appId === workflow.appId)
      && (manifest.requiredChecks.filter(check =>
        check.workflowId === workflow.id && check.appId === workflow.appId
          && check.context === workflow.diagnostics.reporter.context).length === 1))
    && manifest.requiredChecks.every(check => manifest.requiredWorkflowIdentities.some(workflow =>
      workflow.id === check.workflowId && workflow.appId === check.appId));
}

function validRunBase(run) {
  return isRecord(run) && Object.keys(run).length === 4
    && typeof run.headSha === 'string' && SHA.test(run.headSha)
    && typeof run.branch === 'string'
    && /^agent-work\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(run.branch)
    && positiveId(run.runId) && positiveId(run.runAttempt) && run.runAttempt <= RUN_ATTEMPT_LIMIT;
}

function normalizeRuns(input, manifest) {
  const identities = manifest.requiredWorkflowIdentities;
  if (Object.hasOwn(input, 'run')) {
    if (Object.hasOwn(input, 'runs') || identities.length !== 1 || !validRunBase(input.run)) return null;
    return [{ ...input.run, workflowId: identities[0].id }];
  }
  if (!Array.isArray(input.runs) || input.runs.length !== identities.length) return null;
  const runs = [];
  for (const run of input.runs) {
    if (!sameKeys(run, ['workflowId', 'headSha', 'branch', 'runId', 'runAttempt'])
        || !positiveId(run.workflowId)
        || typeof run.headSha !== 'string' || !SHA.test(run.headSha)
        || typeof run.branch !== 'string'
        || !/^agent-work\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(run.branch)
        || !positiveId(run.runId) || !positiveId(run.runAttempt) || run.runAttempt > RUN_ATTEMPT_LIMIT) return null;
    runs.push(run);
  }
  const workflowIds = new Set(runs.map(run => run.workflowId));
  const runIds = new Set(runs.map(run => run.runId));
  if (workflowIds.size !== identities.length || runIds.size !== runs.length
      || identities.some(identity => !workflowIds.has(identity.id))) return null;
  const first = runs[0];
  if (!runs.every(run => run.headSha === first.headSha && run.branch === first.branch)) return null;
  return runs;
}

function validExpectedRegression(expected, manifest) {
  if (expected === undefined) return true;
  if (!sameKeys(expected, ['workflowId', 'testIdentitySha256', 'proposalSha256'])
      || !positiveId(expected.workflowId)
      || typeof expected.testIdentitySha256 !== 'string' || !SHA256.test(expected.testIdentitySha256)
      || typeof expected.proposalSha256 !== 'string' || !SHA256.test(expected.proposalSha256)) return false;
  const identity = manifest.requiredWorkflowIdentities.find(item => item.id === expected.workflowId);
  return Boolean(identity)
    && manifest.requiredChecks.filter(check => check.workflowId === expected.workflowId
      && check.appId === identity.appId && check.context === 'test').length === 1;
}

function validConfig({ token, repository, fetch, timeoutMs, pageLimit, responseLimit }) {
  return typeof token === 'string' && token.length > 0 && token.length <= 4096
    && typeof repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    && typeof fetch === 'function'
    && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000
    && Number.isSafeInteger(pageLimit) && pageLimit > 0 && pageLimit <= MAX_PAGES
    && Number.isSafeInteger(responseLimit) && responseLimit >= 1024
    && responseLimit <= MAX_RESPONSE_BYTES;
}

function blocked(reason) {
  return { status: 'needs_attention', reason: REASONS.has(reason) ? reason : 'github_read_failed' };
}

function repoPath(repository, suffix) {
  const [owner, name] = repository.split('/');
  return `/repos/${owner}/${name}${suffix}`;
}

async function jsonRequest(fetch, token, path, budget, responseLimit) {
  if (!path.startsWith('/repos/')) throw new Error('read_failed');
  const response = await Promise.race([
    fetch(`${API_ROOT}${path}`, {
      method: 'GET',
      redirect: 'manual',
      signal: budget.controller.signal,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
    }),
    budget.expired,
  ]);
  if (!response || response.status !== 200 || response.redirected === true || !response.body) {
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    throw new Error('read_failed');
  }
  const contentLength = response.headers?.get?.('content-length');
  if (contentLength !== null && contentLength !== undefined
      && (!/^\d+$/.test(contentLength) || Number(contentLength) > responseLimit)) {
    void response.body.cancel().catch(() => {});
    throw new Error('read_failed');
  }
  const bytes = await Promise.race([
    readBytes(response.body, responseLimit, Math.max(1, budget.deadline - Date.now())),
    budget.expired,
  ]);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

async function listPages(fetch, token, path, property, budget, config) {
  const entries = [];
  const ids = new Set();
  let total;
  for (let page = 1; page <= config.pageLimit; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const result = await jsonRequest(fetch, token,
      `${path}${separator}per_page=${PAGE_SIZE}&page=${page}`, budget, config.responseLimit);
    if (!isRecord(result) || !Array.isArray(result[property]) || result[property].length > PAGE_SIZE
        || !Number.isSafeInteger(result.total_count) || result.total_count < result[property].length
        || result.total_count > PAGE_SIZE * config.pageLimit
        || total !== undefined && total !== result.total_count) throw new Error('read_failed');
    total = result.total_count;
    for (const item of result[property]) {
      if (!isRecord(item) || !positiveId(item.id) || ids.has(item.id)) throw new Error('read_failed');
      ids.add(item.id);
    }
    entries.push(...result[property]);
    if (entries.length > total) throw new Error('read_failed');
    if (entries.length === total) return entries;
    if (result[property].length < PAGE_SIZE) throw new Error('read_failed');
  }
  throw new Error('read_failed');
}

async function listAnnotations(fetch, token, root, checkRunId, budget, config) {
  const annotations = [];
  const pageLimit = Math.min(config.pageLimit, MAX_ANNOTATION_PAGES);
  for (let page = 1; page <= pageLimit; page += 1) {
    const batch = await jsonRequest(fetch, token,
      `${root}/check-runs/${checkRunId}/annotations?per_page=${PAGE_SIZE}&page=${page}`,
      budget, config.responseLimit);
    if (!Array.isArray(batch) || batch.length > PAGE_SIZE
        || !batch.every(isRecord)) throw new Error('read_failed');
    annotations.push(...batch);
    if (annotations.length > MAX_ANNOTATIONS) throw new Error('read_failed');
    if (batch.length < PAGE_SIZE) return annotations;
  }
  throw new Error('read_failed');
}

function fileBytesMatch(result, path, expectedSha256) {
  if (!isRecord(result) || result.type !== 'file' || result.path !== path || result.encoding !== 'base64'
      || typeof result.content !== 'string' || result.content.length > MAX_RESPONSE_BYTES * 2
      || !Number.isSafeInteger(result.size) || result.size < 0 || result.size > MAX_RESPONSE_BYTES) return false;
  const encoded = result.content.replace(/[\r\n]/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return false;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== result.size || bytes.length > MAX_RESPONSE_BYTES || bytes.toString('base64') !== encoded) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  return equalHash(sha256(bytes), expectedSha256);
}

function sourceGraphSha256(sources) {
  return sha256(Buffer.from(canonicalJson(sources), 'utf8'));
}

function runMatches(result, run, repositoryId, identity) {
  return isRecord(result) && result.id === run.runId && result.run_attempt === run.runAttempt
    && result.workflow_id === identity.id && isRecord(result.repository)
    && result.repository.id === repositoryId && isRecord(result.head_repository)
    && result.head_repository.id === repositoryId
    && result.path === identity.path && result.head_sha === run.headSha
    && result.head_branch === run.branch && result.event === identity.event
    && positiveId(result.check_suite_id);
}

function checkMatches(check, run, identity, runData, expectedConclusion) {
  return isRecord(check) && positiveId(check.id) && check.name === identity.context
    && isRecord(check.app) && check.app.id === identity.appId
    && isRecord(check.check_suite) && check.check_suite.id === runData.check_suite_id
    && check.head_sha === run.headSha
    && check.status === 'completed' && check.conclusion === expectedConclusion;
}

function successfulSteps(steps) {
  return Array.isArray(steps) && steps.length > 0 && steps.length <= 100
    && steps.every(step => isRecord(step) && step.status === 'completed' && step.conclusion === 'success');
}

function expectedFailureSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 100) return false;
  let failedIndex = -1;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (!isRecord(step) || step.status !== 'completed') return false;
    if (step.conclusion === 'failure') {
      if (failedIndex !== -1 || step.name !== 'Run JavaScript tests') return false;
      failedIndex = index;
    } else if (!['success', 'skipped'].includes(step.conclusion)) return false;
  }
  return failedIndex > 0
    && steps.slice(0, failedIndex).every(step => step.conclusion === 'success')
    && steps.slice(failedIndex + 1).every(step => ['success', 'skipped'].includes(step.conclusion));
}

function jobMatches(job, run, checkRunId, root, expectedFailure) {
  const baseMatches = isRecord(job) && positiveId(job.id) && job.run_id === run.runId
    && job.run_attempt === run.runAttempt
    && job.check_run_url === `${API_ROOT}${root}/check-runs/${checkRunId}`
    && job.head_sha === run.headSha && job.status === 'completed';
  if (!baseMatches) return false;
  if (expectedFailure) return job.conclusion === 'failure' && expectedFailureSteps(job.steps);
  return job.conclusion === 'success' && successfulSteps(job.steps);
}

function validReportContext(context, repository, run) {
  return sameKeys(context, ['repository', 'headSha', 'runId', 'runAttempt'])
    && typeof context.repository === 'string' && context.repository.toLowerCase() === repository.toLowerCase()
    && context.headSha === run.headSha && context.runId === String(run.runId)
    && context.runAttempt === run.runAttempt;
}

function validReportCounts(counts) {
  return sameKeys(counts, COUNT_KEYS)
    && COUNT_KEYS.every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0 && counts[key] <= MAX_TEST_EVENTS);
}

function validFailureRecords(value, rootFailure = false) {
  const max = MAX_FAILURES;
  return Array.isArray(value) && value.length <= max
    && value.every(item => rootFailure
      ? sameKeys(item, ['category']) && FAILURE_CATEGORIES.has(item.category)
      : sameKeys(item, ['testIdentitySha256', 'category'])
        && typeof item.testIdentitySha256 === 'string' && SHA256.test(item.testIdentitySha256)
        && FAILURE_CATEGORIES.has(item.category))
    && (rootFailure || new Set(value.map(item => item.testIdentitySha256)).size === value.length);
}

function validReportSchema(report) {
  if (!sameKeys(report, REPORT_KEYS) || report.schemaVersion !== 2
      || typeof report.complete !== 'boolean' || typeof report.truncated !== 'boolean'
      || typeof report.producerSha256 !== 'string' || !SHA256.test(report.producerSha256)
      || !validReportCounts(report.counts)
      || !validFailureRecords(report.failures) || !validFailureRecords(report.rootFailures, true)
      || report.skipPolicySha256 !== DATABASE_SKIP_POLICY_SHA256
      || !Array.isArray(report.skippedTestIdentitySha256s)
      || report.skippedTestIdentitySha256s.length > DATABASE_SKIP_IDENTITIES.length
      || !report.skippedTestIdentitySha256s.every(id => typeof id === 'string'
        && SHA256.test(id) && DATABASE_SKIP_IDENTITIES.includes(id))
      || new Set(report.skippedTestIdentitySha256s).size !== report.skippedTestIdentitySha256s.length
      || report.failures.some(item => report.skippedTestIdentitySha256s.includes(item.testIdentitySha256))
      || !Number.isSafeInteger(report.processExitCode) || report.processExitCode < 0 || report.processExitCode > 255) return false;
  if (report.complete) return report.truncated === false && report.reason === null;
  return typeof report.reason === 'string' && INCOMPLETE_REPORT_REASONS.has(report.reason);
}

function reportCountsAgree(report) {
  const counts = report.counts;
  const categoryTotal = counts.assertionFailureCount + counts.setupFailureCount
    + counts.syntaxFailureCount + counts.otherFailureCount;
  const testTotal = counts.passedTestCount + counts.failedTestCount
    + counts.aggregateFailureCount + counts.skippedTestCount + counts.todoTestCount
    + counts.cancelledTestCount;
  const categoryCounts = report.failures.reduce((total, failure) => {
    total[failure.category] += 1;
    return total;
  }, { assertion: 0, other: 0, setup: 0, syntax: 0 });
  const rootCounts = report.rootFailures.reduce((total, failure) => {
    total[failure.category] += 1;
    return total;
  }, { assertion: 0, other: 0, setup: 0, syntax: 0 });
  return counts.testCount === testTotal
    && counts.failedTestCount === report.failures.length
    && counts.rootFailureCount === report.rootFailures.length
    && counts.skippedTestCount === report.skippedTestIdentitySha256s.length
    && categoryTotal === counts.failedTestCount + counts.rootFailureCount
    && counts.assertionFailureCount === categoryCounts.assertion + rootCounts.assertion
    && counts.otherFailureCount === categoryCounts.other + rootCounts.other
    && counts.setupFailureCount === categoryCounts.setup + rootCounts.setup
    && counts.syntaxFailureCount === categoryCounts.syntax + rootCounts.syntax;
}

function decodeReportMessage(message) {
  if (typeof message !== 'string'
      || Buffer.byteLength(message, 'utf8') > MAX_ANNOTATION_MESSAGE_BYTES) return null;
  const prefix = 'MELLON_CI_REPORT_V2:';
  if (!message.startsWith(prefix)) return null;
  const encoded = message.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.length > MAX_REPORT_BYTES || bytes.toString('base64url') !== encoded) return null;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const report = JSON.parse(text);
    return validReportSchema(report) ? report : null;
  } catch {
    return null;
  }
}

function validateDiagnosticReport(report, { repository, run, producerSha256, expectedRegression, reporterRevision, failureInvestigation = false }) {
  if (!report || !report.complete || report.truncated || report.reason !== null
      || !validReportContext(report.context, repository, run)
      || !equalHash(report.producerSha256, producerSha256)
      || report.formatterRevision !== reporterRevision
      || !reportCountsAgree(report)) return null;
  const counts = report.counts;
  if (counts.testCount < 1) return null;
  if (failureInvestigation) {
    if (report.processExitCode !== 1 || counts.failedTestCount < 1
      || counts.assertionFailureCount !== counts.failedTestCount
      || counts.setupFailureCount !== 0 || counts.syntaxFailureCount !== 0
      || counts.otherFailureCount !== 0 || counts.rootFailureCount !== 0
      || counts.todoTestCount !== 0 || counts.cancelledTestCount !== 0
      || report.failures.some(item => item.category !== 'assertion')) return null;
    return { status: 'failure', assertions: report.failures.map(item => ({
      workflowId: run.workflowId, runId: run.runId, runAttempt: run.runAttempt,
      testIdentitySha256: item.testIdentitySha256, category: 'assertion',
      producerSha256, formatterRevision: reporterRevision,
      reportSha256: sha256(Buffer.from(canonicalJson(report), 'utf8')),
    })) };
  }
  if (expectedRegression) {
    if (report.processExitCode !== 1 || counts.failedTestCount !== 1
        || counts.assertionFailureCount !== 1 || counts.setupFailureCount !== 0
        || counts.syntaxFailureCount !== 0 || counts.otherFailureCount !== 0
        || counts.rootFailureCount !== 0
        || report.skippedTestIdentitySha256s.includes(expectedRegression.testIdentitySha256)
        || counts.todoTestCount !== 0 || counts.cancelledTestCount !== 0
        || report.failures.length !== 1
        || report.failures[0].testIdentitySha256 !== expectedRegression.testIdentitySha256
        || report.failures[0].category !== 'assertion') return null;
    return {
      status: 'intended_red',
      evidence: {
        testIdentitySha256: expectedRegression.testIdentitySha256,
        category: 'assertion',
        processExitCode: report.processExitCode,
        testCount: counts.testCount,
        passedTestCount: counts.passedTestCount,
        skippedTestCount: counts.skippedTestCount,
        skipPolicySha256: report.skipPolicySha256,
        skippedTestIdentitySha256s: [...report.skippedTestIdentitySha256s],
        aggregateFailureCount: counts.aggregateFailureCount,
      },
    };
  }
  if (report.processExitCode !== 0 || counts.failedTestCount !== 0
      || counts.aggregateFailureCount !== 0 || counts.rootFailureCount !== 0
      || counts.assertionFailureCount !== 0 || counts.setupFailureCount !== 0
      || counts.syntaxFailureCount !== 0 || counts.otherFailureCount !== 0
      || counts.todoTestCount !== 0 || counts.cancelledTestCount !== 0
      || counts.passedTestCount + counts.skippedTestCount !== counts.testCount) return null;
  return {
    status: 'success',
    summary: {
      schemaVersion: report.schemaVersion,
      complete: true,
      producerSha256: report.producerSha256,
      testCount: counts.testCount,
      passedTestCount: counts.passedTestCount,
      skippedTestCount: counts.skippedTestCount,
      skipPolicySha256: report.skipPolicySha256,
      skippedTestIdentitySha256s: [...report.skippedTestIdentitySha256s],
      processExitCode: report.processExitCode,
    },
  };
}

function annotationReport(annotations) {
  let legacy;
  let bundle;
  const parts = new Map();
  for (const item of annotations) {
    if (!isRecord(item) || typeof item.message !== 'string') throw new Error('read_failed');
    const message = item.message;
    const single = message.startsWith(REPORT_PREFIX);
    const chunked = message.startsWith(CHUNK_PREFIX);
    if (!single && !chunked) {
      if (message.includes('MELLON_CI_REPORT_V2')) throw new Error('read_failed');
      continue;
    }
    if (item.annotation_level !== 'notice'
      || (item.title !== undefined && item.title !== null && item.title !== ''
        && item.title !== 'Mellon CI evidence')) throw new Error('ambiguous_report');
    if (single) {
      if (legacy || parts.size) throw new Error('ambiguous_report');
      legacy = decodeReportMessage(message);
      if (!legacy) throw new Error('read_failed');
      continue;
    }
    if (legacy) throw new Error('ambiguous_report');
    if (Buffer.byteLength(message) >= 4096) throw new Error('read_failed');
    const match = message.slice(CHUNK_PREFIX.length)
      .match(/^([a-f0-9]{64}):([1-9]|10):([1-9]|10):([A-Za-z0-9_-]{1,3500})$/);
    if (!match) throw new Error('read_failed');
    const [, digest, indexText, countText, data] = match;
    const index = Number(indexText);
    const count = Number(countText);
    if (count < 2 || count > MAX_REPORT_CHUNKS || index > count
      || (index < count && data.length !== CHUNK_DATA_LENGTH)) throw new Error('read_failed');
    if (parts.has(index) || (bundle && (bundle.digest !== digest || bundle.count !== count))) {
      throw new Error('ambiguous_report');
    }
    bundle ??= { digest, count };
    parts.set(index, data);
  }
  if (legacy) return legacy;
  if (!bundle) return undefined;
  if (parts.size !== bundle.count) throw new Error('read_failed');
  const encoded = Array.from({ length: bundle.count }, (_, index) => parts.get(index + 1)).join('');
  if (Buffer.byteLength(REPORT_PREFIX + encoded) > MAX_ANNOTATION_MESSAGE_BYTES
    || !equalHash(sha256(Buffer.from(encoded, 'utf8')), bundle.digest)) throw new Error('read_failed');
  const report = decodeReportMessage(REPORT_PREFIX + encoded);
  if (!report) throw new Error('read_failed');
  return report;
}

async function readDiagnosticSources({ fetch, token, repository, run, identity, budget, config }) {
  const verified = [];
  for (const source of identity.diagnostics.sources) {
    const sourcePath = source.path.split('/').map(encodeURIComponent).join('/');
    const file = await jsonRequest(fetch, token,
      `${repoPath(repository, '')}/contents/${sourcePath}?ref=${encodeURIComponent(run.headSha)}`,
      budget, config.responseLimit);
    if (!fileBytesMatch(file, source.path, source.sha256)) return null;
    verified.push({ path: source.path, sha256: source.sha256 });
  }
  const reporterPath = 'automation/ci/report-annotations.mjs';
  const trustedFormatter = await jsonRequest(fetch, token,
    `${repoPath(repository, '')}/contents/${reporterPath}?ref=${encodeURIComponent(identity.diagnostics.reporter.revision)}`,
    budget, config.responseLimit);
  if (!fileBytesMatch(trustedFormatter, reporterPath, identity.diagnostics.reporter.sha256)) return null;
  return sourceGraphSha256(verified);
}

async function readWorkflowEvidence({ fetch, token, repository, run, manifest, identity,
  expectedRegression, failureInvestigation = false, budget, config }) {
  const root = repoPath(repository, '');
  const runData = await jsonRequest(fetch, token,
    `${root}/actions/runs/${run.runId}`, budget, config.responseLimit);
  if (!runMatches(runData, run, manifest.repository.id, identity)) return blocked('run_mismatch');

  const workflowPath = identity.path.split('/').map(encodeURIComponent).join('/');
  const workflowFile = await jsonRequest(fetch, token,
    `${root}/contents/${workflowPath}?ref=${encodeURIComponent(run.headSha)}`, budget, config.responseLimit);
  if (!fileBytesMatch(workflowFile, identity.path, identity.sha256)) return blocked('workflow_hash_mismatch');
  if (['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(runData.status)) {
    return { status: 'waiting', reason: 'checks_pending' };
  }
  if (runData.status !== 'completed'
      || !['success', 'failure'].includes(runData.conclusion)) return blocked('workflow_not_successful');

  const isSelectedWorkflow = expectedRegression?.workflowId === identity.id;
  const failedRun = runData.conclusion === 'failure';
  if (failedRun && !failureInvestigation && !isSelectedWorkflow) return blocked('workflow_not_successful');
  if (failedRun && !failureInvestigation && !expectedRegression) return blocked('workflow_not_successful');

  const producerSha256 = await readDiagnosticSources({ fetch, token, repository, run, identity, budget, config });
  if (!producerSha256) return blocked('diagnostic_unverified');

  const checks = await listPages(fetch, token,
    `${root}/check-suites/${runData.check_suite_id}/check-runs?filter=all`, 'check_runs', budget, config);
  const jobs = await listPages(fetch, token,
    `${root}/actions/runs/${run.runId}/attempts/${run.runAttempt}/jobs`, 'jobs', budget, config);
  const required = manifest.requiredChecks.filter(item => item.workflowId === identity.id);
  const evidence = [];
  if (failureInvestigation && failedRun && required.filter(check => check.context === 'test').length !== 1) {
    return blocked('diagnostic_unverified');
  }
  let failureDiagnostic;
  let selectedDiagnostic;
  let greenDiagnostic;
  for (const expected of required) {
    const reporterCheck = expected.context === identity.diagnostics.reporter.context;
    const selectedCheck = Boolean(isSelectedWorkflow && reporterCheck);
    const expectedFailure = (isSelectedWorkflow || failureInvestigation) && failedRun && expected.context === 'test';
    const expectedConclusion = expectedFailure ? 'failure' : 'success';
    const candidates = checks.filter(check => isRecord(check) && check.name === expected.context
      && isRecord(check.app) && check.app.id === expected.appId);
    if (candidates.length === 0) return blocked('required_check_missing');
    if (candidates.length > 1) return blocked('check_ambiguous');
    if (!checkMatches(candidates[0], run, expected, runData, expectedConclusion)) {
      return blocked('check_incomplete');
    }
    const checkRunId = candidates[0].id;
    const linkedJobs = jobs.filter(job => isRecord(job)
      && job.check_run_url === `${API_ROOT}${root}/check-runs/${checkRunId}`);
    if (linkedJobs.length === 0 || linkedJobs.some(job =>
      !jobMatches(job, run, checkRunId, root, expectedFailure))) return blocked('check_incomplete');
    if (linkedJobs.length > 1) return blocked('check_ambiguous');

    if (reporterCheck) {
      let annotations;
      try {
        annotations = await listAnnotations(fetch, token, root, checkRunId, budget, config);
      } catch {
        return blocked(isSelectedWorkflow ? 'intended_red_unverified' : 'diagnostic_unverified');
      }
      let report;
      try {
        report = annotationReport(annotations);
      } catch (error) {
        return blocked(error?.message === 'ambiguous_report' ? 'diagnostic_ambiguous' : 'diagnostic_unverified');
      }
      if (!report) return blocked(isSelectedWorkflow ? 'intended_red_unverified' : 'diagnostic_unverified');
      const validation = validateDiagnosticReport(report, {
        repository, run, producerSha256, expectedRegression: selectedCheck ? expectedRegression : undefined,
        reporterRevision: identity.diagnostics.reporter.revision,
        failureInvestigation: failureInvestigation && failedRun,
      });
      if (!validation) return blocked(isSelectedWorkflow ? 'intended_red_unverified' : 'diagnostic_unverified');
      if (failureInvestigation && failedRun) failureDiagnostic = validation;
      else if (selectedCheck) selectedDiagnostic = validation;
      else greenDiagnostic = validation.summary;
    }
    evidence.push({ checkRunId, checkSuiteId: runData.check_suite_id,
      appId: expected.appId, status: 'completed', conclusion: expectedConclusion, headSha: run.headSha });
  }

  if (failureInvestigation && failedRun) {
    if (!failureDiagnostic || failureDiagnostic.status !== 'failure') return blocked('diagnostic_unverified');
    return { ...failureDiagnostic, checks: evidence };
  }
  if (isSelectedWorkflow) {
    if (!selectedDiagnostic) return blocked('intended_red_unverified');
    if (selectedDiagnostic.status === 'intended_red' && failedRun) {
      return { status: 'intended_red', evidence: selectedDiagnostic.evidence, checks: evidence };
    }
    return blocked('intended_red_unverified');
  }
  return { status: 'success', checks: evidence, diagnostic: greenDiagnostic };
}

export function createCheckReader({ token, repository, fetch = globalThis.fetch,
  timeoutMs = 10000, pageLimit = 3, responseLimit = MAX_RESPONSE_BYTES } = {}) {
  const config = { token, repository, fetch, timeoutMs, pageLimit, responseLimit };
  async function read(input, failureInvestigation) {
      let snapshot;
      try {
        snapshot = structuredClone(input);
      } catch {
        return blocked('invalid_input');
      }
      if (!isRecord(snapshot) || Object.keys(snapshot).some(key =>
        !(failureInvestigation ? ['run', 'runs', 'manifest'] : ['run', 'runs', 'manifest', 'expectedRegression']).includes(key))
          || !validManifest(snapshot.manifest, repository) || !validConfig(config)) return blocked('invalid_input');
      const runs = normalizeRuns(snapshot, snapshot.manifest);
      if (!runs || !validExpectedRegression(snapshot.expectedRegression, snapshot.manifest)) {
        return blocked('invalid_input');
      }

      const manifest = snapshot.manifest;
      const expectedRegression = snapshot.expectedRegression;
      const budget = { controller: new AbortController(), deadline: Date.now() + timeoutMs };
      let timer;
      budget.expired = new Promise((_, reject) => {
        timer = setTimeout(() => {
          budget.controller.abort();
          reject(new Error('read_failed'));
        }, timeoutMs);
      });
      try {
        const checks = [];
        const runEvidence = [];
        const assertions = [];
        let intendedRedEvidence;
        for (const identity of manifest.requiredWorkflowIdentities) {
          const run = runs.find(item => item.workflowId === identity.id);
          if (!run) return blocked('invalid_input');
          const result = await readWorkflowEvidence({ fetch, token, repository, run, manifest,
            identity, expectedRegression, failureInvestigation, budget, config });
          if (result.status === 'waiting' || result.status === 'needs_attention') return result;
          if (result.status === 'failure' && failureInvestigation) {
            assertions.push(...result.assertions);
            if (assertions.length > MAX_FAILURES) return blocked('diagnostic_unverified');
          } else if (result.status === 'intended_red') intendedRedEvidence = result;
          else if (result.status !== 'success') return blocked('diagnostic_unverified');
          checks.push(...result.checks);
          runEvidence.push({ workflowId: identity.id, runId: run.runId,
            runAttempt: run.runAttempt, headSha: run.headSha, checks: result.checks,
            ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}) });
        }
        if (checks.length !== manifest.requiredChecks.length) return blocked('required_check_missing');
        if (failureInvestigation && assertions.length > 0) {
          const facts = { status: 'failure', repositoryId: manifest.repository.id,
            headSha: runs[0].headSha, branch: runs[0].branch, event: 'push',
            runs: runEvidence, checks, evidence: { assertions } };
          return { ...facts, findingSha256: sha256(Buffer.from(canonicalJson(facts), 'utf8')) };
        }
        if (expectedRegression) {
          if (!intendedRedEvidence) return blocked('intended_red_unverified');
          return { status: 'intended_red', reason: 'intended_regression_failed',
            repositoryId: manifest.repository.id, headSha: runs[0].headSha, branch: runs[0].branch,
            event: 'push', runs: runEvidence, checks, evidence: intendedRedEvidence.evidence };
        }
        const result = { status: 'success', repositoryId: manifest.repository.id,
          headSha: runs[0].headSha, branch: runs[0].branch, event: 'push', runs: runEvidence, checks };
        if (runs.length === 1) {
          result.runId = runs[0].runId;
          result.runAttempt = runs[0].runAttempt;
        }
        return result;
      } catch {
        return blocked('github_read_failed');
      } finally {
        clearTimeout(timer);
        budget.controller.abort();
      }
  }
  return Object.freeze({
    readChecks: input => read(input, false),
    readFailure: input => read(input, true),
  });
}
