import test from 'node:test';
import assert from 'node:assert/strict';
import { createCheckReader } from '../../src/automation/worker/checks.mjs';
import { createHash } from 'node:crypto';
import { DATABASE_SKIP_IDENTITIES, DATABASE_SKIP_POLICY_SHA256, buildTrustedAnnotation } from '../../automation/ci/report-annotations.mjs';

const HEAD = 'a'.repeat(40);
const WORKFLOW_BYTES = Buffer.from('name: trusted\non: push\n');
const WORKFLOW_HASH = createHash('sha256').update(WORKFLOW_BYTES).digest('hex');
const ROOT = 'https://api.github.com/repos/randoneering/mellon';
const TRUSTED_FORMATTER_REVISION = 'b'.repeat(40);
const TRUSTED_FORMATTER_BYTES = Buffer.from('trusted formatter revision\n');
const manifest = () => ({
  repository: { name: 'randoneering/mellon', id: 1234 },
  requiredChecks: [
    { context: 'test', appId: 15368, workflowId: 399609443 },
    { context: 'test-report', appId: 15368, workflowId: 399609443 },
  ],
  requiredWorkflowIdentities: [{
    id: 399609443,
    path: '.github/workflows/test.yml',
    sha256: WORKFLOW_HASH,
    appId: 15368,
    event: 'push',
    diagnostics: diagnosticDescriptor(),
  }],
});
const BRANCH = 'agent-work/00000000-0000-4000-8000-000000000001';
const DIAGNOSTIC_FILES = [
  { path: 'automation/ci/guard-command.mjs', bytes: Buffer.from('synthetic output guard\n') },
  { path: 'automation/ci/run-tests.mjs', bytes: Buffer.from('synthetic protected runner\n') },
  { path: 'automation/ci/test-reporter.mjs', bytes: Buffer.from('synthetic native reporter\n') },
  { path: 'automation/ci/report-annotations.mjs', bytes: Buffer.from('candidate formatter\n') },
  { path: 'scripts/lib/output-guard.mjs', bytes: Buffer.from('synthetic output guard helper\n') },
  { path: 'package.json', bytes: Buffer.from('{"scripts":{"test":"node automation/ci/run-tests.mjs"}}\n') },
];
const DIAGNOSTIC_SOURCES = DIAGNOSTIC_FILES.map(({ path, bytes }) => ({
  path,
  sha256: createHash('sha256').update(bytes).digest('hex'),
}));
const RED_TEST_ID = 'e'.repeat(64);
const PROPOSAL_SHA = 'f'.repeat(64);
const run = (runId = 77, runAttempt = 1) => ({ headSha: HEAD, branch: BRANCH, runId, runAttempt });

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function diagnosticDescriptor() {
  return {
    version: 2,
    skipPolicy: { version: 1, sha256: DATABASE_SKIP_POLICY_SHA256 },
    sources: structuredClone(DIAGNOSTIC_SOURCES),
    reporter: {
      context: 'test-report',
      revision: TRUSTED_FORMATTER_REVISION,
      sha256: createHash('sha256').update(TRUSTED_FORMATTER_BYTES).digest('hex'),
    },
  };
}

function diagnosticManifest() {
  return manifest();
}

function multiWorkflowManifest() {
  const value = manifest();
  value.requiredChecks.push(
    { context: 'lint', appId: 15368, workflowId: 399609444 },
    { context: 'test-report', appId: 15368, workflowId: 399609444 },
  );
  value.requiredWorkflowIdentities.push({
    id: 399609444,
    path: '.github/workflows/test.yml',
    sha256: WORKFLOW_HASH,
    appId: 15368,
    event: 'push',
    diagnostics: diagnosticDescriptor(),
  });
  return value;
}

function diagnosticOverrides(report) {
  return {
    [`${ROOT}/check-runs/103/annotations?per_page=100&page=1`]: [annotation(report)],
  };
}

function diagnosticReport(overrides = {}) {
  const sources = DIAGNOSTIC_SOURCES;
  const producerSha256 = createHash('sha256').update(canonicalJson(sources)).digest('hex');
  return {
    schemaVersion: 2,
    complete: true,
    truncated: false,
    reason: null,
    context: { repository: 'randoneering/mellon', headSha: HEAD, runId: '77', runAttempt: 1 },
    producerSha256,
    skipPolicySha256: DATABASE_SKIP_POLICY_SHA256,
    skippedTestIdentitySha256s: [],
    counts: {
      testCount: 1,
      passedTestCount: 1,
      failedTestCount: 0,
      aggregateFailureCount: 0,
      assertionFailureCount: 0,
      setupFailureCount: 0,
      syntaxFailureCount: 0,
      otherFailureCount: 0,
      skippedTestCount: 0,
      todoTestCount: 0,
      cancelledTestCount: 0,
      rootFailureCount: 0,
    },
    failures: [],
    rootFailures: [],
    processExitCode: 0,
    formatterRevision: TRUSTED_FORMATTER_REVISION,
    ...overrides,
  };
}

function annotation(report) {
  return {
    annotation_level: 'notice',
    title: 'Mellon CI evidence',
    message: `MELLON_CI_REPORT_V2:${Buffer.from(JSON.stringify(report)).toString('base64url')}`,
    path: '.github/workflows/test.yml',
    start_line: 1,
    end_line: 1,
  };
}

function expectedRegression(testIdentitySha256 = RED_TEST_ID) {
  return { workflowId: 399609443, testIdentitySha256, proposalSha256: PROPOSAL_SHA };
}

function failingRedReport(changes = {}) {
  const report = diagnosticReport({
    context: { repository: 'randoneering/mellon', headSha: HEAD, runId: '77', runAttempt: 1 },
    counts: {
      testCount: 1,
      passedTestCount: 0,
      failedTestCount: 1,
      aggregateFailureCount: 0,
      assertionFailureCount: 1,
      setupFailureCount: 0,
      syntaxFailureCount: 0,
      otherFailureCount: 0,
      skippedTestCount: 0,
      todoTestCount: 0,
      cancelledTestCount: 0,
      rootFailureCount: 0,
    },
    failures: [{ testIdentitySha256: RED_TEST_ID, category: 'assertion' }],
    processExitCode: 1,
    ...changes,
  });
  return report;
}

function response(body, status = 200) {
  const bytes = Buffer.from(JSON.stringify(body));
  return new Response(bytes, { status, headers: { 'content-type': 'application/json' } });
}

function fixtureFetch(overrides = {}) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    const parsed = new URL(String(url));
    const path = parsed.pathname;
    const localPath = path.replace('/repos/randoneering/mellon', '');
    const query = new URLSearchParams(parsed.search);
    const queryKey = [...query.entries()].map(([key, value]) => `${key}=${value}`).join('&');
    const value = overrides[`${ROOT}${localPath}?${queryKey}`]
      ?? overrides[`${localPath}?${queryKey}`] ?? overrides[path] ?? defaults(localPath, query);
    assert.notEqual(value, null, `unexpected fixed API resource: ${localPath}`);
    assert.notEqual(value, undefined, `missing API fixture: ${localPath}`);
    return typeof value === 'function' ? value(url, options) : response(value);
  };
  return { fetch, calls };
}

function defaults(path, query = new URLSearchParams()) {
  if (path === '/contents/automation/ci/report-annotations.mjs'
      && query.get('ref') === TRUSTED_FORMATTER_REVISION) return {
    type: 'file', size: TRUSTED_FORMATTER_BYTES.length, path: 'automation/ci/report-annotations.mjs',
    encoding: 'base64', content: `${TRUSTED_FORMATTER_BYTES.toString('base64')}\n`,
  };
  const diagnosticFile = DIAGNOSTIC_FILES.find(item => path === `/contents/${item.path}`);
  if (diagnosticFile) return {
    type: 'file', size: diagnosticFile.bytes.length, path: diagnosticFile.path, encoding: 'base64',
    content: `${diagnosticFile.bytes.toString('base64')}\n`,
  };
  if (path === '/contents/.github/workflows/test.yml') return {
    type: 'file', size: WORKFLOW_BYTES.length,
    path: '.github/workflows/test.yml', encoding: 'base64', content: WORKFLOW_BYTES.toString('base64') + '\n',
  };
  const runMatch = path.match(/^\/actions\/runs\/(77|78)$/);
  if (runMatch) {
    const runId = Number(runMatch[1]);
    const second = runId === 78;
    return {
      id: runId, run_attempt: 1, workflow_id: second ? 399609444 : 399609443,
      repository: { id: 1234 }, head_repository: { id: 1234 }, path: '.github/workflows/test.yml',
      head_sha: HEAD, head_branch: BRANCH, event: 'push', status: 'completed',
      conclusion: 'success', check_suite_id: second ? 89 : 88,
    };
  }
  const jobsMatch = path.match(/^\/actions\/runs\/(77|78)\/attempts\/(\d+)\/jobs$/);
  if (jobsMatch) {
    const runId = Number(jobsMatch[1]);
    const runAttempt = Number(jobsMatch[2]);
    const second = runId === 78;
    if (second) return { total_count: 2, jobs: [
      { id: 199, run_id: runId, run_attempt: runAttempt,
        check_run_url: `${ROOT}/check-runs/102`, head_sha: HEAD, status: 'completed',
        conclusion: 'success', steps: [{ name: 'Run tests', status: 'completed', conclusion: 'success' }] },
      { id: 299, run_id: runId, run_attempt: runAttempt, check_run_url: `${ROOT}/check-runs/104`,
        head_sha: HEAD, status: 'completed', conclusion: 'success', steps: [
          { name: 'Format bounded untrusted test report', status: 'completed', conclusion: 'success' },
        ] },
    ] };
    return { total_count: 2, jobs: [
      { id: 99, run_id: runId, run_attempt: runAttempt,
        check_run_url: `${ROOT}/check-runs/101`, head_sha: HEAD, status: 'completed',
        conclusion: 'success', steps: [{ name: 'Run JavaScript tests', status: 'completed', conclusion: 'success' }] },
      { id: 199, run_id: runId, run_attempt: runAttempt,
        check_run_url: `${ROOT}/check-runs/103`, head_sha: HEAD, status: 'completed',
        conclusion: 'success', steps: [{ name: 'Format bounded untrusted test report', status: 'completed', conclusion: 'success' }] },
    ] };
  }
  if (path === '/check-suites/88/check-runs' || path === '/check-suites/89/check-runs') {
    const second = path.includes('/89/');
    const checkRuns = second ? [
      { id: 104, name: 'test-report', app: { id: 15368 }, check_suite: { id: 89 }, head_sha: HEAD,
        status: 'completed', conclusion: 'success', output: {}, pull_requests: [] },
      { id: 102, name: 'lint', app: { id: 15368 }, check_suite: { id: 89 }, head_sha: HEAD,
        status: 'completed', conclusion: 'success', output: { title: '', summary: '', text: '' }, pull_requests: [] },
    ] : [
      { id: 101, name: 'test', app: { id: 15368 }, check_suite: { id: 88 }, head_sha: HEAD,
        status: 'completed', conclusion: 'success', output: { title: '', summary: '', text: '' }, pull_requests: [] },
      { id: 103, name: 'test-report', app: { id: 15368 }, check_suite: { id: 88 }, head_sha: HEAD,
        status: 'completed', conclusion: 'success', output: { title: '', summary: '', text: '' }, pull_requests: [] },
    ];
    return { total_count: checkRuns.length, check_runs: checkRuns };
  }
  if (path === '/check-runs/103/annotations') return [annotation(diagnosticReport())];
  if (path === '/check-runs/104/annotations') return [annotation(diagnosticReport({
    context: { repository: 'randoneering/mellon', headSha: HEAD, runId: '78', runAttempt: 1 },
  }))];
  if (path.startsWith('/check-runs/') && path.endsWith('/annotations')) return [];
  return null;
}

test('rejects a pilot workflow without diagnostics before any producer or GitHub reads', async () => {
  const value = manifest();
  delete value.requiredWorkflowIdentities[0].diagnostics;
  const { fetch, calls } = fixtureFetch();
  const result = await createCheckReader({ token: 'x', repository: 'randoneering/mellon', fetch })
    .readChecks({ run: run(), manifest: value });
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.reason, 'invalid_input');
  assert.equal(calls.length, 0);
});

test('accepts exact repository, owned branch, push run, approved workflow bytes, and required check', async () => {
  const { fetch, calls } = fixtureFetch();
  const reader = createCheckReader({ token: 'synthetic-token', repository: 'randoneering/mellon', fetch });
  const result = await reader.readChecks({ run: run(), manifest: manifest() });
  assert.equal(result.status, 'success');
  assert.deepEqual(result.checks.map(check => check.checkRunId), [101, 103]);
  assert.deepEqual(calls.map(call => call.url), [
    `${ROOT}/actions/runs/77`,
    `${ROOT}/contents/.github/workflows/test.yml?ref=${HEAD}`,
    ...DIAGNOSTIC_FILES.map(file => `${ROOT}/contents/${file.path}?ref=${HEAD}`),
    `${ROOT}/contents/automation/ci/report-annotations.mjs?ref=${TRUSTED_FORMATTER_REVISION}`,
    `${ROOT}/check-suites/88/check-runs?filter=all&per_page=100&page=1`,
    `${ROOT}/actions/runs/77/attempts/1/jobs?per_page=100&page=1`,
    `${ROOT}/check-runs/103/annotations?per_page=100&page=1`,
  ]);
  assert.ok(calls.every(call => call.url.startsWith('https://api.github.com/')));
  assert.ok(calls.every(call => call.options.redirect === 'manual'));
});

test('same-name check from another App cannot satisfy the required context', async () => {
  const { fetch } = fixtureFetch({
    [`${ROOT}/check-suites/88/check-runs?filter=all&per_page=100&page=1`]: { total_count: 1, check_runs: [
      { id: 101, name: 'test', app: { id: 999 }, check_suite: { id: 88 },
        head_sha: HEAD, status: 'completed', conclusion: 'success', pull_requests: [] },
    ] },
  });
  const result = await createCheckReader({ token: 'x', repository: 'randoneering/mellon', fetch })
    .readChecks({ run: run(), manifest: manifest() });
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.reason, 'required_check_missing');
});

test('generic failed jobs and unsupported diagnostics are never intended red evidence', async () => {
  const { fetch } = fixtureFetch({
    [`${ROOT}/actions/runs/77`]: {
      ...defaults(`${ROOT}/actions/runs/77`), status: 'completed', conclusion: 'failure',
    },
    [`${ROOT}/actions/runs/77/attempts/1/jobs?per_page=100&page=1`]: { total_count: 1, jobs: [
      { id: 99, run_id: 77, run_attempt: 1, check_run_url: `${ROOT}/check-runs/101`, head_sha: HEAD, status: 'completed',
        conclusion: 'failure', steps: [{ name: 'Install', status: 'completed', conclusion: 'failure' }] },
    ] },
    [`${ROOT}/check-suites/88/check-runs?filter=all&per_page=100&page=1`]: { total_count: 1, check_runs: [
      { id: 101, name: 'test', app: { id: 15368 }, check_suite: { id: 88 },
        head_sha: HEAD, status: 'completed', conclusion: 'failure', output: { title: 'failed', summary: 'private text' }, pull_requests: [] },
    ] },
  });
  const result = await createCheckReader({ token: 'x', repository: 'randoneering/mellon', fetch })
    .readChecks({ run: run(), manifest: manifest(), expectedRegression: expectedRegression() });
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.reason, 'check_incomplete');
  assert.equal(JSON.stringify(result).includes('private text'), false);
});

test('rejects altered approved workflow content', async () => {
  const { fetch } = fixtureFetch({
    [`${ROOT}/contents/.github/workflows/test.yml?ref=${HEAD}`]: {
      path: '.github/workflows/test.yml', encoding: 'base64', content: Buffer.from('name: altered').toString('base64'),
    },
  });
  const result = await createCheckReader({ token: 'x', repository: 'randoneering/mellon', fetch })
    .readChecks({ run: run(), manifest: manifest() });
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.reason, 'workflow_hash_mismatch');
});

test('rejects wrong run repository head branch event workflow path and attempt identities', async () => {
  for (const change of [
    { id: 78 }, { repository: { id: 999 } }, { head_repository: { id: 999 } },
    { head_sha: 'b'.repeat(40) }, { head_branch: 'main' }, { event: 'pull_request' },
    { workflow_id: 999 }, { path: '.github/workflows/other.yml' }, { run_attempt: 2 },
  ]) {
    const { fetch } = fixtureFetch({ [`${ROOT}/actions/runs/77?`]: { ...defaults('/actions/runs/77'), ...change } });
    const result = await createCheckReader({ token: 'x', repository: 'randoneering/mellon', fetch }).readChecks({ run: run(), manifest: manifest() });
    assert.deepEqual(result, { status: 'needs_attention', reason: 'run_mismatch' });
  }
});

test('queued or running workflow metadata cannot be upgraded to success using old job metadata', async () => {
  for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
    const { fetch, calls } = fixtureFetch({ [`${ROOT}/actions/runs/77?`]: { ...defaults('/actions/runs/77'), status, conclusion: null } });
    const result = await createCheckReader({ token: 'x', repository: 'randoneering/mellon', fetch }).readChecks({ run: run(), manifest: manifest() });
    assert.equal(result.status, 'waiting');
    assert.equal(calls.some(call => call.url.includes('/jobs?')), false);
  }
  const { fetch } = fixtureFetch({ [`${ROOT}/actions/runs/77?`]: { ...defaults('/actions/runs/77'), status: 'completed', conclusion: 'failure' } });
  const result = await createCheckReader({ token: 'x', repository: 'randoneering/mellon', fetch }).readChecks({ run: run(), manifest: manifest() });
  assert.equal(result.status, 'needs_attention');
});

test('requires unique complete exact-head checks rather than skipped stale or cancelled checks', async () => {
  const valid = defaults('/check-suites/88/check-runs').check_runs[0];
  const path = `${ROOT}/check-suites/88/check-runs?filter=all&per_page=100&page=1`;
  for (const check of [
    { ...valid, head_sha: 'b'.repeat(40) }, { ...valid, check_suite: { id: 99 } },
    { ...valid, status: 'in_progress' }, { ...valid, conclusion: 'skipped' },
    { ...valid, conclusion: 'cancelled' }, { ...valid, conclusion: 'failure' },
  ]) {
    const { fetch } = fixtureFetch({ [path]: { total_count: 1, check_runs: [check] } });
    const result = await createCheckReader({ token: 'x', repository: 'randoneering/mellon', fetch }).readChecks({ run: run(), manifest: manifest() });
    assert.deepEqual(result, { status: 'needs_attention', reason: 'check_incomplete' });
  }
  for (const [checks, reason] of [[[], 'required_check_missing'], [[valid, { ...valid, id: 102 }], 'check_ambiguous']]) {
    const { fetch } = fixtureFetch({ [path]: { total_count: checks.length, check_runs: checks } });
    const result = await createCheckReader({ token: 'x', repository: 'randoneering/mellon', fetch }).readChecks({ run: run(), manifest: manifest() });
    assert.deepEqual(result, { status: 'needs_attention', reason });
  }
});

test('never follows a check-run link on a foreign host or accepts a different job attempt', async () => {
  const path = `${ROOT}/actions/runs/77/attempts/1/jobs?per_page=100&page=1`;
  const job = defaults('/actions/runs/77/attempts/1/jobs').jobs[0];
  for (const value of [
    { ...job, check_run_url: 'https://elsewhere.invalid/steal' },
    { ...job, check_run_url: `${ROOT}/check-runs/101?token=untrusted` },
    { ...job, run_attempt: 2 }, { ...job, run_id: 78 }, { ...job, head_sha: 'b'.repeat(40) },
  ]) {
    const { fetch, calls } = fixtureFetch({ [path]: { total_count: 1, jobs: [value] } });
    const result = await createCheckReader({ token: 'x', repository: 'randoneering/mellon', fetch }).readChecks({ run: run(), manifest: manifest() });
    assert.equal(result.status, 'needs_attention');
    assert.ok(calls.every(call => call.url.startsWith(ROOT + '/')));
  }
});

test('incomplete pagination counts cannot be accepted as a complete required-check set', async () => {
  const valid = defaults('/check-suites/88/check-runs').check_runs[0];
  const { fetch } = fixtureFetch({ [`${ROOT}/check-suites/88/check-runs?filter=all&per_page=100&page=1`]: { total_count: 2, check_runs: [valid] } });
  const result = await createCheckReader({ token: 'x', repository: 'randoneering/mellon', fetch }).readChecks({ run: run(), manifest: manifest() });
  assert.deepEqual(result, { status: 'needs_attention', reason: 'github_read_failed' });
});

test('redirects oversized bodies malformed responses and upstream errors expose no private details', async () => {
  for (const bad of [
    () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.invalid/private-token' } }),
    () => new Response('x'.repeat(256 * 1024 + 1)),
    () => new Response('{private-token'),
    () => { throw new Error('private-token upstream error'); },
  ]) {
    let calls = 0;
    const fetch = async () => { calls += 1; return bad(); };
    const result = await createCheckReader({ token: 'private-token', repository: 'randoneering/mellon', fetch }).readChecks({ run: run(), manifest: manifest() });
    assert.deepEqual(result, { status: 'needs_attention', reason: 'github_read_failed' });
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(result), /private-token|elsewhere|upstream/);
  }
});

test('ignored abort and hanging stream cancellation cannot hold the reader indefinitely', async () => {
  for (const fetch of [
    async () => new Promise(() => {}),
    async () => new Response(new ReadableStream({ start() {}, cancel() { return new Promise(() => {}); } })),
  ]) {
    let timer;
    const reading = createCheckReader({ token: 'x', repository: 'randoneering/mellon', fetch, timeoutMs: 15 }).readChecks({ run: run(), manifest: manifest() });
    const result = await Promise.race([reading, new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'deadline_missing' }), 250); })]);
    clearTimeout(timer);
    assert.deepEqual(result, { status: 'needs_attention', reason: 'github_read_failed' });
  }
});

test('clones authority inputs before asynchronous reads', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { fetch } = fixtureFetch();
  const delayedFetch = async (...args) => { await gate; return fetch(...args); };
  const inputRun = run();
  const inputManifest = manifest();
  const pending = createCheckReader({ token: 'x', repository: 'randoneering/mellon', fetch: delayedFetch })
    .readChecks({ run: inputRun, manifest: inputManifest });
  inputRun.headSha = 'b'.repeat(40);
  inputManifest.requiredChecks[0].appId = 999;
  release();
  assert.equal((await pending).status, 'success');
});

test('accepts green native evidence only from the exact approved producer and check annotation', async () => {
  const report = diagnosticReport();
  const { fetch, calls } = fixtureFetch(diagnosticOverrides(report));
  const result = await createCheckReader({ token: 'x', repository: 'randoneering/mellon', fetch })
    .readChecks({ run: run(), manifest: diagnosticManifest() });
  assert.equal(result.status, 'success', JSON.stringify({ result, calls: calls.map(call => call.url) }));
  assert.deepEqual(result.checks.map(check => check.checkRunId), [101, 103]);
  for (const source of DIAGNOSTIC_FILES) {
    assert.ok(calls.some(call => call.url === `${ROOT}/contents/${source.path}?ref=${HEAD}`));
  }
  assert.ok(calls.some(call => call.url === `${ROOT}/check-runs/103/annotations?per_page=100&page=1`));
  assert.ok(calls.every(call => call.url.startsWith(`${ROOT}/`)));
  assert.equal(JSON.stringify(result).includes(report.producerSha256), true);
  assert.equal(JSON.stringify(result).includes('synthetic native reporter'), false);
});

test('ignores report-shaped annotations on the execution job', async () => {
  const report = failingRedReport();
  const overrides = {
    [`${ROOT}/check-runs/101/annotations?per_page=100&page=1`]: [annotation(report)],
    [`${ROOT}/check-runs/103/annotations?per_page=100&page=1`]: [],
  };
  const { fetch, calls } = fixtureFetch(overrides);
  const result = await createCheckReader({ token: 'x', repository: 'randoneering/mellon', fetch })
    .readChecks({ run: run(), manifest: diagnosticManifest(), expectedRegression: expectedRegression() });
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.reason, 'intended_red_unverified');
  assert.equal(calls.some(call => call.url.includes('/check-runs/101/annotations')), false);
  assert.equal(calls.some(call => call.url.includes('/check-runs/103/annotations')), true);
});

test('accepts one expected native assertion failure as intended red without authorizing writes', async () => {
  const report = failingRedReport();
  const baseRun = defaults('/actions/runs/77');
  const failedRun = { ...baseRun, status: 'completed', conclusion: 'failure' };
  const failedJob = {
    total_count: 2,
    jobs: [
      { id: 99, run_id: 77, run_attempt: 1, check_run_url: `${ROOT}/check-runs/101`,
        head_sha: HEAD, status: 'completed', conclusion: 'failure', steps: [
          { name: 'Check out source', status: 'completed', conclusion: 'success' },
          { name: 'Run JavaScript tests', status: 'completed', conclusion: 'failure' },
          { name: 'Verify parity', status: 'completed', conclusion: 'skipped' },
        ] },
      { id: 199, run_id: 77, run_attempt: 1, check_run_url: `${ROOT}/check-runs/103`,
        head_sha: HEAD, status: 'completed', conclusion: 'success', steps: [
          { name: 'Format bounded untrusted test report', status: 'completed', conclusion: 'success' },
        ] },
    ],
  };
  const failedCheck = {
    total_count: 2,
    check_runs: [
      { id: 101, name: 'test', app: { id: 15368 }, check_suite: { id: 88 },
        head_sha: HEAD, status: 'completed', conclusion: 'failure', output: {}, pull_requests: [] },
      { id: 103, name: 'test-report', app: { id: 15368 }, check_suite: { id: 88 },
        head_sha: HEAD, status: 'completed', conclusion: 'success', output: {}, pull_requests: [] },
    ],
  };
  const overrides = {
    ...diagnosticOverrides(report),
    [`${ROOT}/actions/runs/77?`]: failedRun,
    [`${ROOT}/actions/runs/77/attempts/1/jobs?per_page=100&page=1`]: failedJob,
    [`${ROOT}/check-suites/88/check-runs?filter=all&per_page=100&page=1`]: failedCheck,
  };
  const result = await createCheckReader({ token: 'x', repository: 'randoneering/mellon', fetch: fixtureFetch(overrides).fetch })
    .readChecks({ run: run(), manifest: diagnosticManifest(), expectedRegression: expectedRegression() });
  assert.equal(result.status, 'intended_red', JSON.stringify(result));
  assert.equal(result.evidence.testIdentitySha256, RED_TEST_ID);
  assert.equal(result.evidence.category, 'assertion');
  assert.equal(result.evidence.processExitCode, 1);
  assert.equal(Object.hasOwn(result, 'writePermission'), false);
});

test('generic, setup, syntax, unrelated, and incomplete reports cannot establish intended red', async () => {
  const invalidReports = [
    failingRedReport({ failures: [{ testIdentitySha256: RED_TEST_ID, category: 'other' }], counts: {
      ...failingRedReport().counts, assertionFailureCount: 0, otherFailureCount: 1,
    } }),
    failingRedReport({ failures: [{ testIdentitySha256: RED_TEST_ID, category: 'setup' }], counts: {
      ...failingRedReport().counts, assertionFailureCount: 0, setupFailureCount: 1,
    } }),
    failingRedReport({ failures: [{ testIdentitySha256: RED_TEST_ID, category: 'syntax' }], counts: {
      ...failingRedReport().counts, assertionFailureCount: 0, syntaxFailureCount: 1,
    } }),
    failingRedReport({ failures: [{ testIdentitySha256: '9'.repeat(64), category: 'assertion' }] }),
    failingRedReport({ complete: false, truncated: true, reason: 'event_limit' }),
  ];
  for (const report of invalidReports) {
    const failedJob = {
      total_count: 2,
      jobs: [
        { id: 99, run_id: 77, run_attempt: 1, check_run_url: `${ROOT}/check-runs/101`,
          head_sha: HEAD, status: 'completed', conclusion: 'failure', steps: [
            { name: 'Set up Node 24', status: 'completed', conclusion: 'success' },
            { name: 'Run JavaScript tests', status: 'completed', conclusion: 'failure' },
          ] },
        { id: 199, run_id: 77, run_attempt: 1, check_run_url: `${ROOT}/check-runs/103`,
          head_sha: HEAD, status: 'completed', conclusion: 'success', steps: [
            { name: 'Format bounded untrusted test report', status: 'completed', conclusion: 'success' },
          ] },
      ],
    };
    const failedCheck = {
      total_count: 2,
      check_runs: [
        { id: 101, name: 'test', app: { id: 15368 }, check_suite: { id: 88 },
          head_sha: HEAD, status: 'completed', conclusion: 'failure', output: {}, pull_requests: [] },
        { id: 103, name: 'test-report', app: { id: 15368 }, check_suite: { id: 88 },
          head_sha: HEAD, status: 'completed', conclusion: 'success', output: {}, pull_requests: [] },
      ],
    };
    const baseRun = defaults('/actions/runs/77');
    const overrides = {
      ...diagnosticOverrides(report),
      [`${ROOT}/actions/runs/77?`]: { ...baseRun, status: 'completed', conclusion: 'failure' },
      [`${ROOT}/actions/runs/77/attempts/1/jobs?per_page=100&page=1`]: failedJob,
      [`${ROOT}/check-suites/88/check-runs?filter=all&per_page=100&page=1`]: failedCheck,
    };
    const result = await createCheckReader({ token: 'x', repository: 'randoneering/mellon', fetch: fixtureFetch(overrides).fetch })
      .readChecks({ run: run(), manifest: diagnosticManifest(), expectedRegression: expectedRegression() });
    assert.equal(result.status, 'needs_attention');
    assert.equal(result.reason, 'intended_red_unverified');
  }
});

test('rejects a formatter revision mismatch and altered trusted formatter bytes', async () => {
  const mismatchedReport = diagnosticReport({ formatterRevision: 'c'.repeat(40) });
  const mismatch = await createCheckReader({ token: 'x', repository: 'randoneering/mellon',
    fetch: fixtureFetch(diagnosticOverrides(mismatchedReport)).fetch })
    .readChecks({ run: run(), manifest: diagnosticManifest() });
  assert.notEqual(mismatch.status, 'success');

  const altered = Buffer.from('different trusted reporter source\\n');
  const sourcePath = 'automation/ci/report-annotations.mjs';
  const alteredTrustedSource = await createCheckReader({ token: 'x', repository: 'randoneering/mellon',
    fetch: fixtureFetch({
      ...diagnosticOverrides(diagnosticReport()),
      [`${ROOT}/contents/${sourcePath}?ref=${TRUSTED_FORMATTER_REVISION}`]: {
        type: 'file', size: altered.length, path: sourcePath, encoding: 'base64',
        content: `${altered.toString('base64')}\\n`,
      },
    }).fetch }).readChecks({ run: run(), manifest: diagnosticManifest() });
  assert.notEqual(alteredTrustedSource.status, 'success');
});

test('rejects diagnostics bound to another head run attempt repository or producer digest', async () => {
  const valid = diagnosticReport();
  const invalidReports = [
    diagnosticReport({ context: { ...valid.context, headSha: 'b'.repeat(40) } }),
    diagnosticReport({ context: { ...valid.context, runId: '78' } }),
    diagnosticReport({ context: { ...valid.context, runAttempt: 2 } }),
    diagnosticReport({ context: { ...valid.context, repository: 'elsewhere/repo' } }),
    diagnosticReport({ producerSha256: '0'.repeat(64) }),
    diagnosticReport({ unexpected: true }),
    diagnosticReport({ counts: { ...valid.counts, testCount: Number.MAX_SAFE_INTEGER } }),
  ];
  for (const report of invalidReports) {
    const result = await createCheckReader({ token: 'x', repository: 'randoneering/mellon',
      fetch: fixtureFetch(diagnosticOverrides(report)).fetch })
      .readChecks({ run: run(), manifest: diagnosticManifest() });
    assert.notEqual(result.status, 'success');
  }
});

test('requires a closed diagnostics pin for intended red and verifies producer bytes before annotations', async () => {
  const { fetch, calls } = fixtureFetch();
  const value = manifest();
  delete value.requiredWorkflowIdentities[0].diagnostics;
  const missingPin = await createCheckReader({ token: 'x', repository: 'randoneering/mellon', fetch })
    .readChecks({ run: run(), manifest: value, expectedRegression: expectedRegression() });
  assert.equal(missingPin.status, 'needs_attention');
  assert.equal(missingPin.reason, 'invalid_input');
  const altered = Buffer.from('unreviewed runner');
  const result = await createCheckReader({ token: 'x', repository: 'randoneering/mellon', fetch: fixtureFetch({
    ...diagnosticOverrides(diagnosticReport()),
    [`${ROOT}/contents/automation/ci/run-tests.mjs?ref=${HEAD}`]: {
      type: 'file', path: 'automation/ci/run-tests.mjs', encoding: 'base64', size: altered.length,
      content: altered.toString('base64'),
    },
  }).fetch }).readChecks({ run: run(), manifest: diagnosticManifest() });
  assert.notEqual(result.status, 'success');
  assert.equal(calls.some(call => call.url.includes('/contents/automation/ci/')), false);
});

test('reads numeric annotation pages to completion and rejects duplicate or truncated reports', async () => {
  const report = diagnosticReport();
  const pageOne = Array.from({ length: 100 }, () => ({
    annotation_level: 'notice', title: 'Unrelated', message: 'ignored', path: '.github/workflows/test.yml',
    start_line: 1, end_line: 1,
  }));
  const paged = fixtureFetch({
    [`${ROOT}/check-runs/103/annotations?per_page=100&page=1`]: pageOne,
    [`${ROOT}/check-runs/103/annotations?per_page=100&page=2`]: [annotation(report)],
  });
  const complete = await createCheckReader({ token: 'x', repository: 'randoneering/mellon', fetch: paged.fetch })
    .readChecks({ run: run(), manifest: diagnosticManifest() });
  assert.equal(complete.status, 'success');
  assert.deepEqual(paged.calls.filter(call => call.url.includes('/annotations')).map(call => call.url), [
    `${ROOT}/check-runs/103/annotations?per_page=100&page=1`,
    `${ROOT}/check-runs/103/annotations?per_page=100&page=2`,
  ]);

  const duplicate = fixtureFetch({
    [`${ROOT}/check-runs/103/annotations?per_page=100&page=1`]: [annotation(report), annotation(report)],
  });
  assert.notEqual((await createCheckReader({ token: 'x', repository: 'randoneering/mellon', fetch: duplicate.fetch })
    .readChecks({ run: run(), manifest: diagnosticManifest() })).status, 'success');

  const incomplete = fixtureFetch({
    [`${ROOT}/check-runs/103/annotations?per_page=100&page=1`]: pageOne,
    [`${ROOT}/check-runs/103/annotations?per_page=100&page=2`]: pageOne,
  });
  assert.notEqual((await createCheckReader({ token: 'x', repository: 'randoneering/mellon', fetch: incomplete.fetch, pageLimit: 2 })
    .readChecks({ run: run(), manifest: diagnosticManifest() })).status, 'success');
});

test('maps each approved workflow to its own exact Actions run instead of reusing one run', async () => {
  const ambiguous = fixtureFetch();
  const oneRun = await createCheckReader({ token: 'x', repository: 'randoneering/mellon', fetch: ambiguous.fetch })
    .readChecks({ run: run(), manifest: multiWorkflowManifest() });
  assert.equal(oneRun.status, 'needs_attention');
  assert.equal(oneRun.reason, 'invalid_input');
  assert.equal(ambiguous.calls.length, 0);

  const duplicateMapping = fixtureFetch();
  const duplicate = await createCheckReader({ token: 'x', repository: 'randoneering/mellon', fetch: duplicateMapping.fetch })
    .readChecks({ runs: [
      { ...run(77), workflowId: 399609443 },
      { ...run(78), workflowId: 399609443 },
    ], manifest: multiWorkflowManifest() });
  assert.equal(duplicate.reason, 'invalid_input');
  assert.equal(duplicateMapping.calls.length, 0);

  const mapped = fixtureFetch();
  const result = await createCheckReader({ token: 'x', repository: 'randoneering/mellon', fetch: mapped.fetch })
    .readChecks({ runs: [
      { ...run(77), workflowId: 399609443 },
      { ...run(78), workflowId: 399609444 },
    ], manifest: multiWorkflowManifest() });
  assert.equal(result.status, 'success');
  assert.ok(mapped.calls.some(call => call.url === `${ROOT}/actions/runs/77`));
  assert.ok(mapped.calls.some(call => call.url === `${ROOT}/actions/runs/78`));
  assert.ok(mapped.calls.some(call => call.url.includes('/check-suites/88/check-runs')));
  assert.ok(mapped.calls.some(call => call.url.includes('/check-suites/89/check-runs')));
  assert.ok(mapped.calls.some(call => call.url.includes('/actions/runs/77/attempts/1/jobs')));
  assert.ok(mapped.calls.some(call => call.url.includes('/actions/runs/78/attempts/1/jobs')));
});

test('snapshots diagnostic source pins before the first asynchronous GitHub read', async () => {
  const report = diagnosticReport();
  const baseFetch = fixtureFetch(diagnosticOverrides(report)).fetch;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let started = false;
  const delayedFetch = async (...args) => {
    started = true;
    await gate;
    return baseFetch(...args);
  };
  const inputManifest = diagnosticManifest();
  const pending = createCheckReader({ token: 'x', repository: 'randoneering/mellon', fetch: delayedFetch })
    .readChecks({ run: run(), manifest: inputManifest });
  inputManifest.requiredWorkflowIdentities[0].diagnostics.sources[0].sha256 = '9'.repeat(64);
  release();
  assert.equal(started, true);
  assert.equal((await pending).status, 'success');
});

function withDatabaseSkips(report) {
  return {
    ...report,
    skippedTestIdentitySha256s: [...DATABASE_SKIP_IDENTITIES],
    counts: { ...report.counts, testCount: report.counts.testCount + 62, skippedTestCount: 62 },
  };
}

function redOverrides(report) {
  const jobs = defaults('/actions/runs/77/attempts/1/jobs');
  jobs.jobs[0].conclusion = 'failure';
  jobs.jobs[0].steps[0].conclusion = 'failure';
  jobs.jobs[0].steps.unshift({ name: 'Set up Node 24', status: 'completed', conclusion: 'success' });
  const checks = defaults('/check-suites/88/check-runs');
  checks.check_runs[0].conclusion = 'failure';
  return {
    ...diagnosticOverrides(report),
    [`${ROOT}/actions/runs/77?`]: { ...defaults('/actions/runs/77'), conclusion: 'failure' },
    [`${ROOT}/actions/runs/77/attempts/1/jobs?per_page=100&page=1`]: jobs,
    [`${ROOT}/check-suites/88/check-runs?filter=all&per_page=100&page=1`]: checks,
  };
}

async function readReport(report, red = false, regression = expectedRegression()) {
  return createCheckReader({ token: 'x', repository: 'randoneering/mellon',
    fetch: fixtureFetch(red ? redOverrides(report) : diagnosticOverrides(report)).fetch,
  }).readChecks({ run: run(), manifest: diagnosticManifest(), ...(red ? { expectedRegression: regression } : {}) });
}

function chunkedAnnotations(report) {
  const encoded = Buffer.from(JSON.stringify(report)).toString('base64url');
  const digest = createHash('sha256').update(encoded).digest('hex');
  const total = Math.ceil(encoded.length / 3500);
  return Array.from({ length: total }, (_, index) => ({ ...annotation(report),
    message: `MELLON_CI_REPORT_V2_CHUNK:${digest}:${index + 1}:${total}:${encoded.slice(index * 3500, (index + 1) * 3500)}`,
  }));
}

async function readAnnotations(report, annotations, red = false) {
  const overrides = red ? redOverrides(report) : diagnosticOverrides(report);
  overrides[`${ROOT}/check-runs/103/annotations?per_page=100&page=1`] = annotations;
  return createCheckReader({ token: 'synthetic', repository: 'randoneering/mellon',
    fetch: fixtureFetch(overrides).fetch }).readChecks({ run: run(), manifest: manifest(),
    ...(red ? { expectedRegression: expectedRegression() } : {}) });
}

test('reconstructs complete bounded chunks from one verified reporter check in any API order', async () => {
  const report = withDatabaseSkips(diagnosticReport());
  const chunks = chunkedAnnotations(report);
  assert.ok(chunks.length >= 2 && chunks.every(item => Buffer.byteLength(item.message) < 4096));
  assert.equal((await readAnnotations(report, chunks)).status, 'success');
  assert.equal((await readAnnotations(report, [...chunks].reverse())).status, 'success');
});

test('trusted formatter chunk notices preserve green and intended RED through the observed API cap', async () => {
  for (const red of [false, true]) {
    const report = withDatabaseSkips(red ? failingRedReport() : diagnosticReport());
    const { processExitCode, formatterRevision, ...raw } = report;
    const output = buildTrustedAnnotation({ GITHUB_REPOSITORY: 'randoneering/mellon',
      GITHUB_SHA: HEAD, GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '1',
      MELLON_CI_REPORTER_REVISION: formatterRevision,
      MELLON_CI_ENCODED_REPORT: Buffer.from(JSON.stringify(raw)).toString('base64url'),
      MELLON_CI_TEST_EXIT_CODE: String(processExitCode) });
    assert.equal(typeof output, 'string');
    const annotations = output.split('\n').map(command => {
      assert.ok(command.startsWith('::notice::'));
      const message = command.slice('::notice::'.length);
      assert.ok(Buffer.byteLength(message) < 4096);
      return { ...annotation(report), message: message.slice(0, 4096) };
    });
    assert.ok(annotations.length >= 2);
    const result = await readAnnotations(report, annotations, red);
    assert.equal(result.status, red ? 'intended_red' : 'success');
  }
});

test('the observed truncated legacy annotation cannot supply worker evidence', async () => {
  const report = withDatabaseSkips(diagnosticReport());
  const original = annotation(report);
  assert.ok(original.message.length > 4096);
  const result = await readAnnotations(report, [{ ...original, message: original.message.slice(0, 4096) }]);
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.reason, 'diagnostic_unverified');
});

for (const [name, mutate] of [
  ['missing chunk', values => values.pop()],
  ['duplicate chunk', values => values.push({ ...values[0] })],
  ['mixed legacy and chunks', (values, report) => values.push(annotation(report))],
  ['different bundles', values => { values[1].message = values[1].message.replace(/CHUNK:[a-f0-9]{64}:/, 'CHUNK:' + '0'.repeat(64) + ':'); }],
  ['bad digest', values => { for (const item of values) item.message = item.message.replace(/CHUNK:[a-f0-9]{64}:/, 'CHUNK:' + '0'.repeat(64) + ':'); }],
  ['zero index', values => { values[0].message = values[0].message.replace(':1:', ':0:'); }],
  ['leading-zero index', values => { values[0].message = values[0].message.replace(':1:', ':01:'); }],
  ['one-part bundle', values => { values[0].message = values[0].message.replace(':1:2:', ':1:1:'); }],
  ['excessive count', values => { for (const item of values) item.message = item.message.replace(':2:', ':11:'); }],
  ['index beyond count', values => { values[0].message = values[0].message.replace(':1:2:', ':3:2:'); }],
  ['empty payload', values => { values[0].message = values[0].message.replace(/:[A-Za-z0-9_-]+$/, ':'); }],
  ['truncated chunk', values => { values[0].message = values[0].message.slice(0, -1); }],
  ['changed payload', values => { const item = values.at(-1); item.message = item.message.slice(0, -1) + (item.message.endsWith('A') ? 'B' : 'A'); }],
  ['oversized chunk', values => { values[0].message += 'A'.repeat(4096); }],
  ['embedded marker', values => { values[0].message = 'untrusted ' + values[0].message; }],
  ['wrong annotation level', values => { values[0].annotation_level = 'warning'; }],
  ['wrong annotation title', values => { values[0].title = 'unreviewed'; }],
]) test(`chunked evidence fails closed for ${name}`, async () => {
  const report = withDatabaseSkips(diagnosticReport());
  const values = chunkedAnnotations(report); mutate(values, report);
  assert.equal((await readAnnotations(report, values)).status, 'needs_attention');
});

test('chunk reconstruction retains exact workflow head and attempt binding', async () => {
  for (const change of [{ headSha: 'f'.repeat(40) }, { runAttempt: 2 }, { runId: '78' }]) {
    const report = withDatabaseSkips(diagnosticReport());
    const other = { ...report, context: { ...report.context, ...change } };
    assert.equal((await readAnnotations(report, chunkedAnnotations(other))).status, 'needs_attention');
  }
});

test('chunked transport cannot bypass policy, counts, producer or formatter verification', async () => {
  const base = withDatabaseSkips(diagnosticReport());
  for (const report of [
    { ...base, skipPolicySha256: '0'.repeat(64) },
    { ...base, skippedTestIdentitySha256s: ['0'.repeat(64), ...base.skippedTestIdentitySha256s.slice(1)] },
    { ...base, counts: { ...base.counts, skippedTestCount: 61 } },
    { ...base, producerSha256: '0'.repeat(64) },
    { ...base, formatterRevision: 'c'.repeat(40) },
  ]) assert.equal((await readAnnotations(base, chunkedAnnotations(report))).status, 'needs_attention');
});

test('allows only reviewed DB identities in green and intended RED with full counts', async () => {
  const green = await readReport(withDatabaseSkips(diagnosticReport()));
  assert.equal(green.status, 'success');
  assert.equal(green.runs[0].diagnostic.skippedTestCount, 62);
  assert.equal(green.runs[0].diagnostic.passedTestCount, 1);
  assert.equal(green.runs[0].diagnostic.skipPolicySha256, DATABASE_SKIP_POLICY_SHA256);
  const red = await readReport(withDatabaseSkips(failingRedReport()), true);
  assert.equal(red.status, 'intended_red');
  assert.equal(red.evidence.testIdentitySha256, RED_TEST_ID);
});

test('rejects unexpected skips, todos, duplicate identities, mismatched counts and policy at reader boundary', async () => {
  for (const red of [false, true]) {
    const base = withDatabaseSkips(red ? failingRedReport() : diagnosticReport());
    const variants = [
      { ...base, skipPolicySha256: '0'.repeat(64) },
      { ...base, skipPolicySha256: undefined },
      { ...base, skippedTestIdentitySha256s: undefined },
      { ...base, skippedTestIdentitySha256s: [...base.skippedTestIdentitySha256s, '0'.repeat(64)], counts: { ...base.counts, testCount: base.counts.testCount + 1, skippedTestCount: 63 } },
      { ...base, skippedTestIdentitySha256s: base.skippedTestIdentitySha256s.map(() => DATABASE_SKIP_IDENTITIES[0]) },
      { ...base, skippedTestIdentitySha256s: base.skippedTestIdentitySha256s.slice(1) },
      { ...base, skippedTestIdentitySha256s: ['::notice::forged'] },
      { ...base, skippedTestIdentitySha256s: ['\u001bforged'] },
      { ...base, skippedTestIdentitySha256s: [new String(DATABASE_SKIP_IDENTITIES[0])] },
      { ...base, counts: { ...base.counts, testCount: base.counts.testCount + 1, todoTestCount: 1 } },
      { ...base, counts: { ...base.counts, testCount: base.counts.testCount + 1, cancelledTestCount: 1 } },
      { ...base, counts: { ...base.counts, passedTestCount: base.counts.passedTestCount + 1 } },
      { ...base, schemaVersion: 1 },
    ];
    for (const report of variants) {
      assert.equal((await readReport(report, red)).status, 'needs_attention');
    }
  }
});

test('an intended regression cannot skip even when its identity is in the approved DB policy', async () => {
  const report = withDatabaseSkips(failingRedReport());
  assert.equal((await readReport(report, true, expectedRegression(DATABASE_SKIP_IDENTITIES[0]))).status, 'needs_attention');
  report.failures[0].testIdentitySha256 = DATABASE_SKIP_IDENTITIES[0];
  assert.equal((await readReport(report, true, expectedRegression(DATABASE_SKIP_IDENTITIES[0]))).status, 'needs_attention');
});

test('requires exact reporter check and known closed skip policy before any reader API calls', async () => {
  for (const mutation of [
    value => { value.requiredChecks = value.requiredChecks.filter(check => check.context !== 'test-report'); },
    value => { delete value.requiredWorkflowIdentities[0].diagnostics.skipPolicy; },
    value => { value.requiredWorkflowIdentities[0].diagnostics.skipPolicy.sha256 = '0'.repeat(64); },
    value => { value.requiredWorkflowIdentities[0].diagnostics.skipPolicy.version = 2; },
    value => { value.requiredWorkflowIdentities[0].diagnostics.skipPolicy.extra = true; },
    value => { value.requiredWorkflowIdentities[0].diagnostics.version = 1; },
  ]) {
    const value = manifest();
    mutation(value);
    const { fetch, calls } = fixtureFetch();
    const result = await createCheckReader({ token: 'x', repository: 'randoneering/mellon', fetch })
      .readChecks({ run: run(), manifest: value });
    assert.equal(result.reason, 'invalid_input');
    assert.equal(calls.length, 0);
  }
});

function assertionFailureOverrides(report = failingRedReport()) {
  const checks = defaults('/check-suites/88/check-runs');
  checks.check_runs[0].conclusion = 'failure';
  const jobs = defaults('/actions/runs/77/attempts/1/jobs');
  jobs.jobs[0].conclusion = 'failure';
  jobs.jobs[0].steps = [
    { name: 'Check out source', status: 'completed', conclusion: 'success' },
    { name: 'Run JavaScript tests', status: 'completed', conclusion: 'failure' },
  ];
  return {
    ...diagnosticOverrides(report),
    [`${ROOT}/actions/runs/77?`]: { ...defaults('/actions/runs/77'), conclusion: 'failure' },
    [`${ROOT}/actions/runs/77/attempts/1/jobs?per_page=100&page=1`]: jobs,
    [`${ROOT}/check-suites/88/check-runs?filter=all&per_page=100&page=1`]: checks,
  };
}

test('failure reader authenticates bounded assertion facts without granting repair authority', async () => {
  const { fetch, calls } = fixtureFetch(assertionFailureOverrides());
  const reader = createCheckReader({ token: 'synthetic-failure-secret', repository: 'randoneering/mellon', fetch });
  const result = await reader.readFailure({ runs: [{ ...run(), workflowId: 399609443 }], manifest: manifest() });
  assert.equal(result.status, 'failure'); assert.equal(result.headSha, HEAD);
  assert.equal(result.repositoryId, 1234); assert.equal(result.branch, BRANCH);
  assert.deepEqual(result.evidence.assertions.map(item => ({ workflowId: item.workflowId,
    runId: item.runId, runAttempt: item.runAttempt, category: item.category,
    testIdentitySha256: item.testIdentitySha256 })), [{ workflowId: 399609443,
    runId: 77, runAttempt: 1, category: 'assertion', testIdentitySha256: RED_TEST_ID }]);
  assert.match(result.findingSha256, /^[a-f0-9]{64}$/);
  assert.match(result.evidence.assertions[0].reportSha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(result, 'writePermission'), false);
  assert.equal(Object.hasOwn(result, 'criterionIndex'), false);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-failure-secret|synthetic native reporter|MELLON_CI_REPORT/);
  assert.equal(calls.length, 12);
  assert.ok(calls.every(call => call.options.headers.authorization === 'Bearer synthetic-failure-secret'));
  assert.equal((await reader.readChecks({ run: run(), manifest: manifest() })).status, 'needs_attention');
  const same = await reader.readFailure({ run: run(), manifest: manifest() });
  assert.equal(same.findingSha256, result.findingSha256);
});

const failureMutations = [
  ['stale head', report => { report.context.headSha = 'b'.repeat(40); }],
  ['stale attempt', report => { report.context.runAttempt = 2; }],
  ['wrong repository', report => { report.context.repository = 'fork/repo'; }],
  ['partial report', report => { report.complete = false; report.reason = 'event_limit'; }],
  ['unexpected skip', report => { report.counts.testCount += 1; report.counts.skippedTestCount = 1; report.skippedTestIdentitySha256s = ['f'.repeat(64)]; }],
  ['failed and skipped assertion', report => { report.counts.testCount += 1; report.counts.skippedTestCount = 1; report.skippedTestIdentitySha256s = [RED_TEST_ID]; }],
  ['todo', report => { report.counts.testCount += 1; report.counts.todoTestCount = 1; }],
  ['cancelled', report => { report.counts.testCount += 1; report.counts.cancelledTestCount = 1; }],
  ['syntax', report => { report.failures[0].category = 'syntax'; report.counts.assertionFailureCount = 0; report.counts.syntaxFailureCount = 1; }],
  ['setup', report => { report.failures[0].category = 'setup'; report.counts.assertionFailureCount = 0; report.counts.setupFailureCount = 1; }],
  ['generic failure', report => { report.failures[0].category = 'other'; report.counts.assertionFailureCount = 0; report.counts.otherFailureCount = 1; }],
  ['root failure', report => { report.rootFailures = [{ category: 'assertion' }]; report.counts.rootFailureCount = 1; report.counts.assertionFailureCount = 2; }],
];
for (const [label, mutate] of failureMutations) {
  test(`failure reader rejects ${label} instead of creating a repair finding`, async () => {
    const report = failingRedReport(); mutate(report);
    const { fetch } = fixtureFetch(assertionFailureOverrides(report));
    const value = await createCheckReader({ token: 'x', repository: 'randoneering/mellon', fetch })
      .readFailure({ run: run(), manifest: manifest() });
    assert.equal(value.status, 'needs_attention'); assert.equal(value.evidence, undefined);
  });
}

for (const [label, alter] of [
  ['missing diagnostics', value => { delete value.manifest.requiredWorkflowIdentities[0].diagnostics; }],
  ['unexpected expected regression', value => { value.expectedRegression = expectedRegression(); }],
  ['caller supplied finding', value => { value.findingSha256 = RED_TEST_ID; }],
]) {
  test(`failure reader rejects ${label} before network`, async () => {
    const input = { run: run(), manifest: manifest() }; alter(input);
    const { fetch, calls } = fixtureFetch();
    const result = await createCheckReader({ token: 'x', repository: 'randoneering/mellon', fetch }).readFailure(input);
    assert.deepEqual(result, { status: 'needs_attention', reason: 'invalid_input' });
    assert.equal(calls.length, 0);
  });
}

test('failure reader rejects missing native evidence even for an authenticated failed job', async () => {
  const overrides = assertionFailureOverrides();
  overrides[`${ROOT}/check-runs/103/annotations?per_page=100&page=1`] = [];
  const reader = createCheckReader({ token: 'x', repository: 'randoneering/mellon', fetch: fixtureFetch(overrides).fetch });
  assert.equal((await reader.readFailure({ run: run(), manifest: manifest() })).status, 'needs_attention');
});

test('failure reader green is not an assertion finding', async () => {
  const reader = createCheckReader({ token: 'x', repository: 'randoneering/mellon', fetch: fixtureFetch().fetch });
  assert.equal((await reader.readFailure({ run: run(), manifest: manifest() })).status, 'success');
});

test('failure reader keeps successful companion workflows bound to their own runs', async () => {
  const { fetch } = fixtureFetch(assertionFailureOverrides());
  const reader = createCheckReader({ token: 'x', repository: 'randoneering/mellon', fetch });
  const value = await reader.readFailure({ manifest: multiWorkflowManifest(), runs: [
    { ...run(77), workflowId: 399609443 }, { ...run(78), workflowId: 399609444 },
  ] });
  assert.equal(value.status, 'failure'); assert.equal(value.checks.length, 4);
  assert.deepEqual(value.runs.map(item => item.runId), [77, 78]);
  assert.equal(value.evidence.assertions.length, 1);
  assert.equal(value.evidence.assertions[0].workflowId, 399609443);
});

test('failure reader allows only the reviewed skip identities alongside native assertions', async () => {
  const report = failingRedReport();
  report.counts.testCount = 2; report.counts.skippedTestCount = 1;
  report.skippedTestIdentitySha256s = [DATABASE_SKIP_IDENTITIES[0]];
  const reader = createCheckReader({ token: 'x', repository: 'randoneering/mellon',
    fetch: fixtureFetch(assertionFailureOverrides(report)).fetch });
  const result = await reader.readFailure({ run: run(), manifest: manifest() });
  assert.equal(result.status, 'failure'); assert.equal(result.evidence.assertions.length, 1);
});

for (const [label, overrides] of [
  ['changed diagnostic bytes', () => ({ [`${ROOT}/contents/automation/ci/test-reporter.mjs?ref=${HEAD}`]: {
    type: 'file', path: 'automation/ci/test-reporter.mjs', encoding: 'base64',
    content: Buffer.from('altered').toString('base64'), size: 7,
  } })],
  ['changed immutable formatter', () => ({ [`${ROOT}/contents/automation/ci/report-annotations.mjs?ref=${TRUSTED_FORMATTER_REVISION}`]: {
    type: 'file', path: 'automation/ci/report-annotations.mjs', encoding: 'base64',
    content: Buffer.from('altered').toString('base64'), size: 7,
  } })],
  ['stale workflow run', () => ({ [`${ROOT}/actions/runs/77?`]: {
    ...defaults('/actions/runs/77'), conclusion: 'failure', head_sha: 'b'.repeat(40),
  } })],
  ['foreign linked job', () => {
    const jobs = defaults('/actions/runs/77/attempts/1/jobs'); jobs.jobs[0].check_run_url = `${ROOT}/check-runs/999`;
    return { [`${ROOT}/actions/runs/77/attempts/1/jobs?per_page=100&page=1`]: jobs };
  }],
  ['foreign App', () => {
    const checks = defaults('/check-suites/88/check-runs'); checks.check_runs[0].app.id = 999;
    return { [`${ROOT}/check-suites/88/check-runs?filter=all&per_page=100&page=1`]: checks };
  }],
  ['ambiguous annotation', () => ({ [`${ROOT}/check-runs/103/annotations?per_page=100&page=1`]: [
    annotation(failingRedReport()), annotation(failingRedReport()),
  ] })],
]) {
  test(`failure reader rejects ${label} before returning assertion facts`, async () => {
    const reader = createCheckReader({ token: 'x', repository: 'randoneering/mellon',
      fetch: fixtureFetch({ ...assertionFailureOverrides(), ...overrides() }).fetch });
    const result = await reader.readFailure({ run: run(), manifest: manifest() });
    assert.equal(result.status, 'needs_attention'); assert.equal(result.findingSha256, undefined);
  });
}

test('failure reader clones head and approved source bindings before asynchronous reads', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fixture = fixtureFetch(assertionFailureOverrides());
  const reader = createCheckReader({ token: 'x', repository: 'randoneering/mellon',
    fetch: async (...args) => { await gate; return fixture.fetch(...args); } });
  const input = { run: run(), manifest: manifest() };
  const pending = reader.readFailure(input);
  input.run.headSha = 'b'.repeat(40);
  input.manifest.requiredWorkflowIdentities[0].diagnostics.sources[0].sha256 = 'f'.repeat(64);
  release();
  const result = await pending;
  assert.equal(result.status, 'failure'); assert.equal(result.headSha, HEAD);
});
