import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { DATABASE_SKIP_POLICY_SHA256 } from '../../automation/ci/report-annotations.mjs';
const { checkApproval } = await import('../../src/automation/worker/approval.mjs')
  .catch(() => ({ checkApproval: async () => ({ authorized: false, reason: 'adapter_unavailable' }) }));

const TITLE = 'Add the bounded worker approval adapter';
const BODY = 'Implement the approved adapter only.';
const APPROVED_BASE = 'a'.repeat(40);
const APPROVED_POLICY = 'b'.repeat(40);
const HUMAN_ID = 42;
const HUMAN_LOGIN = 'maintainer';
const ISSUE_NUMBER = 21;
const ISSUE_ID = 9001;
const CONTENT_HASH = createHash('sha256')
  .update(JSON.stringify([TITLE, BODY]))
  .digest('hex');
const LIMITS = {
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

function manifest() {
  return {
    version: 1,
    approved: true,
    repository: { name: 'randoneering/mellon', id: 123456 },
    issue: { id: ISSUE_ID, number: ISSUE_NUMBER, contentSha256: CONTENT_HASH },
    approver: { id: HUMAN_ID, login: HUMAN_LOGIN },
    base: { branch: 'main', revision: APPROVED_BASE },
    policyRevision: APPROVED_POLICY,
    pilotScope: { kind: 'bounded-public-issue', maxChangedFiles: 10, maxFileBytes: 65536, maxTotalBytes: 262144 },
    allowedPaths: ['scripts/personalized-detection.mjs'],
    acceptanceCriteria: ['Check identity and present repository state.'],
    requiredChecks: [
      { context: 'ci/test', appId: 2000, workflowId: 3000 },
      { context: 'test-report', appId: 2000, workflowId: 3000 },
    ],
    requiredWorkflowIdentities: [{ id: 3000, path: '.github/workflows/test.yml', sha256: 'd'.repeat(64), appId: 2000, event: 'push', diagnostics: {
      version: 2,
      skipPolicy: { version: 1, sha256: DATABASE_SKIP_POLICY_SHA256 },
      sources: [
        'automation/ci/guard-command.mjs', 'automation/ci/run-tests.mjs',
        'automation/ci/test-reporter.mjs', 'automation/ci/report-annotations.mjs',
        'scripts/lib/output-guard.mjs', 'package.json',
      ].map((path, index) => ({ path, sha256: String(index + 1).repeat(64) })),
      reporter: { context: 'test-report', revision: 'c'.repeat(40), sha256: '7'.repeat(64) },
    } }],
    model: { id: 'approved-model' },
    qodoIdentities: [{ userId: 4000 }],
    limits: structuredClone(LIMITS),
  };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function pin(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function githubResponses(overrides = {}) {
  const responses = new Map([
    [`/repos/randoneering/mellon`, { id: 123456, full_name: 'randoneering/mellon', private: false }],
    [`/repos/randoneering/mellon/issues/${ISSUE_NUMBER}`, {
      id: ISSUE_ID,
      number: ISSUE_NUMBER,
      repository_url: 'https://api.github.com/repos/randoneering/mellon',
      state: 'open',
      title: TITLE,
      body: BODY,
      pull_request: undefined,
      user: { id: 7, login: 'contributor', type: 'User' },
    }],
    [`/repos/randoneering/mellon/issues/${ISSUE_NUMBER}/labels`, [{ name: 'AGENT: READY' }]],
    [`/users/${HUMAN_LOGIN}`, { id: HUMAN_ID, login: HUMAN_LOGIN, type: 'User' }],
    [`/repos/randoneering/mellon/collaborators/${HUMAN_LOGIN}/permission`, {
      permission: 'write',
      user: { id: HUMAN_ID, login: HUMAN_LOGIN, type: 'User' },
    }],
    [`/repos/randoneering/mellon/branches/main`, {
      name: 'main',
      commit: { sha: APPROVED_BASE },
    }],
  ]);
  for (const [path, value] of Object.entries(overrides)) responses.set(path, value);
  const calls = [];
  const fetch = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ url: parsed.href, options });
    if (parsed.origin !== 'https://api.github.com') throw new Error('unexpected host');
    const result = responses.get(parsed.pathname);
    if (result instanceof Error) throw result;
    if (result instanceof Response) return result;
    if (result === null || result === undefined) return jsonResponse({}, 404);
    return jsonResponse(result);
  };
  return { fetch, calls };
}

function input(overrides = {}) {
  const approved = manifest();
  const api = githubResponses();
  return {
    request: {
      manifest: approved,
      expectedManifestSha256: pin(approved),
      token: 'synthetic-test-token',
      fetch: api.fetch,
      ...overrides,
    },
    api,
  };
}

function overrideResponse(request, matches, change) {
  const original = request.fetch;
  request.fetch = async (url, options) => {
    const response = await original(url, options);
    return matches(new URL(url)) ? jsonResponse(change(await response.json())) : response;
  };
}

async function denied(t, request, reason) {
  const result = await checkApproval(request);
  assert.equal(result.authorized, false);
  assert.equal(result.reason, reason);
  assert.equal('issue' in result, false);
  assert.equal('token' in result, false);
  assert.equal('body' in result, false);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-test-token|private network details|timeout secret|internal API text/);
  return result;
}

test('authorizes only a complete externally pinned manifest against fresh GitHub state', async () => {
  const { request, api } = input();
  const result = await checkApproval(request);
  assert.deepEqual(result, {
    authorized: true,
    reason: 'approved',
    evidence: {
      repositoryId: 123456,
      issueId: ISSUE_ID,
      issueNumber: ISSUE_NUMBER,
      approverId: HUMAN_ID,
      approverLogin: HUMAN_LOGIN,
      contentSha256: CONTENT_HASH,
      baseRevision: APPROVED_BASE,
      policyRevision: APPROVED_POLICY,
      manifestSha256: request.expectedManifestSha256,
    },
  });
  assert.equal(api.calls.length, 6);
  assert.ok(api.calls.every(({ url, options }) => new URL(url).origin === 'https://api.github.com' && options.redirect === 'manual'));
});

test('caller mutation during a pending read cannot approve content outside the original manifest pin', async t => {
  const { request } = input();
  const original = request.fetch;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const changedBody = `${BODY} changed while GitHub was pending`;
  request.fetch = async (url, options) => {
    if (!new URL(url).pathname.endsWith(`/issues/${ISSUE_NUMBER}`)) return original(url, options);
    await held;
    const response = await original(url, options);
    return jsonResponse({ ...await response.json(), body: changedBody });
  };
  const pending = checkApproval(request);
  request.manifest.issue.contentSha256 = createHash('sha256').update(JSON.stringify([TITLE, changedBody])).digest('hex');
  release();
  await denied(t, request, 'manifest_pin_mismatch');
  assert.deepEqual(await pending, { authorized: false, reason: 'content_mismatch' });
});

test('authorization and evidence stay bound to the original snapshot when the caller changes nested IDs', async () => {
  const { request } = input();
  const pinnedHash = request.expectedManifestSha256;
  const original = request.fetch;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  request.fetch = async (url, options) => {
    if (new URL(url).pathname.endsWith(`/issues/${ISSUE_NUMBER}`)) await held;
    return original(url, options);
  };
  const pending = checkApproval(request);
  request.manifest.issue.number = 999;
  request.manifest.approver.id = 99;
  request.manifest.policyRevision = 'c'.repeat(40);
  release();
  const result = await pending;
  assert.equal(result.authorized, true);
  assert.equal(result.evidence.issueNumber, ISSUE_NUMBER);
  assert.equal(result.evidence.approverId, HUMAN_ID);
  assert.equal(result.evidence.manifestSha256, pinnedHash);
  assert.equal(result.evidence.policyRevision, APPROVED_POLICY);
});

test('does not treat loader status or enabled as approval', async t => {
  const { request } = input({ manifest: { status: 'loaded', enabled: true } });
  await denied(t, request, 'manifest_invalid');
});

test('rejects an incorrect external manifest hash before making API calls', async t => {
  const { request, api } = input({ expectedManifestSha256: '0'.repeat(64) });
  await denied(t, request, 'manifest_pin_mismatch');
  assert.equal(api.calls.length, 0);
});

test('rejects every missing manifest field and out-of-policy limits', async t => {
  const example = manifest();
  for (const key of Object.keys(example)) {
    const incomplete = structuredClone(example);
    delete incomplete[key];
    const { request } = input({ manifest: incomplete, expectedManifestSha256: pin(incomplete) });
    await denied(t, request, 'manifest_invalid');
  }
  const excessive = manifest();
  excessive.limits.modelCallsPerRun = 21;
  const { request } = input({ manifest: excessive, expectedManifestSha256: pin(excessive) });
  await denied(t, request, 'manifest_invalid');
});

test('binds returned repository and issue identities to the pinned manifest', async t => {
  for (const [path, value, reason] of [
    ['/repos/randoneering/mellon', { id: 999, full_name: 'randoneering/mellon' }, 'repository_identity_mismatch'],
    [`/repos/randoneering/mellon/issues/${ISSUE_NUMBER}`, {
      id: ISSUE_ID + 1, number: ISSUE_NUMBER, repository_url: 'https://api.github.com/repos/randoneering/mellon', state: 'open', title: TITLE, body: BODY,
      user: { id: 7, login: 'contributor', type: 'User' },
    }, 'issue_identity_mismatch'],
    [`/repos/randoneering/mellon/issues/${ISSUE_NUMBER}`, {
      id: ISSUE_ID, number: ISSUE_NUMBER + 1, repository_url: 'https://api.github.com/repos/randoneering/mellon', state: 'open', title: TITLE, body: BODY,
      user: { id: 7, login: 'contributor', type: 'User' },
    }, 'issue_identity_mismatch'],
  ]) {
    const { request } = input();
    const base = request.fetch;
    request.fetch = async (url, options) => new URL(url).pathname === path
      ? jsonResponse(value)
      : base(url, options);
    await denied(t, request, reason);
  }
});

test('rejects changed title/body content', async t => {
  const { request, api } = input();
  request.fetch = githubResponses({
    [`/repos/randoneering/mellon/issues/${ISSUE_NUMBER}`]: {
      id: ISSUE_ID, number: ISSUE_NUMBER, repository_url: 'https://api.github.com/repos/randoneering/mellon', state: 'open', title: TITLE, body: `${BODY} changed`,
      user: { id: 7, login: 'contributor', type: 'User' },
    },
  }).fetch;
  await denied(t, request, 'content_mismatch');
});

test('requires a still-open non-pull-request issue', async t => {
  for (const [item, reason] of [
    [{ state: 'closed' }, 'issue_not_open'],
    [{ pull_request: { url: 'https://api.github.com/repos/x/y/pulls/21' } }, 'issue_is_pull_request'],
  ]) {
    const { request, api } = input();
    const original = githubResponses();
    api.fetch = original.fetch;
    const values = githubResponses();
    const base = values.fetch;
    api.fetch = async (url, options) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith(`/issues/${ISSUE_NUMBER}`)) {
        return jsonResponse({
          id: ISSUE_ID, number: ISSUE_NUMBER, repository_url: 'https://api.github.com/repos/randoneering/mellon', state: 'open', title: TITLE, body: BODY,
          user: { id: 7, login: 'contributor', type: 'User' }, ...item,
        });
      }
      return base(url, options);
    };
    request.fetch = api.fetch;
    await denied(t, request, reason);
  }
});

test('requires the readiness label case-insensitively', async t => {
  const { request } = input();
  const base = request.fetch;
  request.fetch = async (url, options) => new URL(url).pathname.endsWith('/labels')
    ? jsonResponse([{ name: 'needs-review' }])
    : base(url, options);
  await denied(t, request, 'readiness_label_missing');
});

test('verifies the exact live human approver identity and rejects bots or ghosts', async t => {
  for (const actor of [
    { id: HUMAN_ID + 1, login: HUMAN_LOGIN, type: 'User' },
    { id: HUMAN_ID, login: 'someone-else', type: 'User' },
    { id: HUMAN_ID, login: HUMAN_LOGIN, type: 'Bot' },
    null,
  ]) {
    const { request } = input();
    const base = request.fetch;
    request.fetch = async (url, options) => new URL(url).pathname === `/users/${HUMAN_LOGIN}`
      ? jsonResponse(actor ?? {})
      : base(url, options);
    await denied(t, request, 'approver_identity_mismatch');
  }
});

test('requires current write, maintain, or admin permission', async t => {
  for (const permission of ['read', 'triage', 'none', null]) {
    const { request } = input();
    const base = request.fetch;
    request.fetch = async (url, options) => new URL(url).pathname.endsWith('/permission')
      ? jsonResponse(permission ? { permission } : {})
      : base(url, options);
    await denied(t, request, 'approver_permission_missing');
  }
});

test('requires the approved main head revision', async t => {
  const { request } = input();
  const base = request.fetch;
  request.fetch = async (url, options) => new URL(url).pathname.endsWith('/branches/main')
    ? jsonResponse({ name: 'main', commit: { sha: 'c'.repeat(40) } })
    : base(url, options);
  await denied(t, request, 'base_revision_mismatch');
});

test('fails closed for redirects, timeouts, network errors, bad status, and malformed or oversized responses', async t => {
  const failures = [
    { response: new Response('', { status: 302, headers: { location: 'https://elsewhere.invalid/' } }), reason: 'github_read_failed' },
    { error: Object.assign(new Error('timeout secret'), { name: 'TimeoutError' }), reason: 'github_read_failed' },
    { error: new Error('private network details'), reason: 'github_read_failed' },
    { response: new Response('not-json', { status: 200 }), reason: 'github_read_failed' },
    { response: new Response('x'.repeat(1024 * 1024), { status: 200 }), reason: 'github_read_failed' },
    { response: new Response(null, { status: 200 }), reason: 'github_read_failed' },
    { response: new Response('internal API text', { status: 500 }), reason: 'github_read_failed' },
    { response: new Response('{"partial":', { status: 200 }), reason: 'github_read_failed' },
  ];
  for (const failure of failures) {
    const { request } = input();
    request.fetch = async () => {
      if (failure.error) throw failure.error;
      return failure.response;
    };
    await denied(t, request, failure.reason);
  }
});

test('does not accept the unapproved agent-ready substitute label', async t => {
  const { request } = input();
  overrideResponse(request, url => url.pathname.endsWith('/labels'), () => [{ name: 'agent-ready' }]);
  await denied(t, request, 'readiness_label_missing');
});

test('human approval permits a bot-authored issue and a hash-approved null body', async () => {
  const bot = input().request;
  overrideResponse(bot, url => url.pathname.endsWith(`/issues/${ISSUE_NUMBER}`), issue => ({ ...issue, user: { id: 7, login: 'automation[bot]', type: 'Bot' } }));
  assert.equal((await checkApproval(bot)).authorized, true);
  const empty = input().request;
  empty.manifest.issue.contentSha256 = createHash('sha256').update(JSON.stringify([TITLE, null])).digest('hex');
  empty.expectedManifestSha256 = pin(empty.manifest);
  overrideResponse(empty, url => url.pathname.endsWith(`/issues/${ISSUE_NUMBER}`), issue => ({ ...issue, body: null }));
  assert.equal((await checkApproval(empty)).authorized, true);
});

test('rejects a current issue with a foreign or missing repository URL', async t => {
  for (const repository_url of ['https://api.github.com/repos/elsewhere/repo', undefined]) {
    const { request } = input();
    overrideResponse(request, url => url.pathname.endsWith(`/issues/${ISSUE_NUMBER}`), issue => ({ ...issue, repository_url }));
    await denied(t, request, 'issue_identity_mismatch');
  }
});

test('binds effective permission to the same human and denies ghost approval', async t => {
  for (const user of [undefined, {}, { id: 99, login: HUMAN_LOGIN, type: 'User' }, { id: HUMAN_ID, login: 'someone-else', type: 'User' }, { id: HUMAN_ID, login: HUMAN_LOGIN, type: 'Bot' }]) {
    const { request } = input();
    overrideResponse(request, url => url.pathname.endsWith('/permission'), permission => ({ ...permission, user }));
    await denied(t, request, 'permission_identity_mismatch');
  }
  const ghost = input();
  ghost.request.manifest.approver = { id: 10137, login: 'ghost' };
  ghost.request.expectedManifestSha256 = pin(ghost.request.manifest);
  await denied(t, ghost.request, 'manifest_invalid');
  assert.equal(ghost.api.calls.length, 0);
});

test('accepts current write maintain and admin rights with matching response identities', async () => {
  for (const permission of ['write', 'maintain', 'admin']) {
    const { request } = input();
    overrideResponse(request, url => url.pathname.endsWith('/permission'), current => ({ ...current, permission }));
    assert.equal((await checkApproval(request)).authorized, true);
  }
});

test('requires a public repository and explicit bounded pilot qualification', async t => {
  for (const value of [true, undefined]) {
    const { request } = input();
    overrideResponse(request, url => url.pathname === '/repos/randoneering/mellon', repo => ({ ...repo, private: value }));
    await denied(t, request, 'repository_not_public');
  }
  const invalid = input();
  invalid.request.manifest.pilotScope.kind = 'full-feature';
  invalid.request.expectedManifestSha256 = pin(invalid.request.manifest);
  await denied(t, invalid.request, 'manifest_invalid');
  assert.equal(invalid.api.calls.length, 0);
});

test('requires immutable workflow hashes and Qodo user IDs instead of login-only identities', async t => {
  for (const change of [
    value => { value.requiredWorkflowIdentities = ['github-actions[bot]']; },
    value => { delete value.requiredWorkflowIdentities[0].sha256; },
    value => { value.requiredWorkflowIdentities[0].id += 1; },
    value => { value.requiredWorkflowIdentities[0].path = 'untrusted.yml'; },
    value => { value.qodoIdentities = ['qodo-merge[bot]']; },
    value => { value.qodoIdentities = [{ userId: 0 }]; },
  ]) {
    const { request, api } = input();
    change(request.manifest);
  request.expectedManifestSha256 = pin(request.manifest);
    await denied(t, request, 'manifest_invalid');
    assert.equal(api.calls.length, 0);
  }
});

test('rejects nonstring pinned hash and revision values before any GitHub read', async t => {
  for (const change of [
    value => { value.issue.contentSha256 = [CONTENT_HASH]; },
    value => { value.base.revision = [APPROVED_BASE]; },
    value => { value.policyRevision = [APPROVED_POLICY]; },
    value => { value.requiredWorkflowIdentities[0].sha256 = ['d'.repeat(64)]; },
  ]) {
    const { request, api } = input();
    change(request.manifest);
  request.expectedManifestSha256 = pin(request.manifest);
    await denied(t, request, 'manifest_invalid');
    assert.equal(api.calls.length, 0);
  }
});

test('rejects contradictory limit envelopes and preserves zero repair or recovery allowances', async t => {
  for (const change of [
    { runLifetimeSeconds: 1 }, { tickDeadlineSeconds: 20 },
    { leaseSeconds: 30 }, { runLifetimeSeconds: 1000 },
    { inputTokensPerRun: 100 }, { outputTokensPerRun: 100 },
  ]) {
    const { request, api } = input();
    Object.assign(request.manifest.limits, change);
    request.expectedManifestSha256 = pin(request.manifest);
    await denied(t, request, 'manifest_invalid');
    assert.equal(api.calls.length, 0);
  }
  const { request } = input();
  Object.assign(request.manifest.limits, { repairCycles: 0, expiredLeaseRecoveries: 0 });
  request.expectedManifestSha256 = pin(request.manifest);
  assert.equal((await checkApproval(request)).authorized, true);
});

test('checks bounded fixed-host label pages when readiness appears after the first page', async () => {
  const { request, api } = input();
  const base = request.fetch;
  request.fetch = async (url, options) => {
    const target = new URL(url);
    if (!target.pathname.endsWith('/labels')) return base(url, options);
    api.calls.push({ url, options });
    assert.equal(target.searchParams.get('per_page'), '100');
    if (target.searchParams.get('page') === '1') return jsonResponse(Array.from({ length: 100 }, (_, index) => ({ name: `label-${index}` })));
    assert.equal(target.searchParams.get('page'), '2');
    return jsonResponse([{ name: 'agent: ready' }]);
  };
  assert.equal((await checkApproval(request)).authorized, true);
  assert.equal(api.calls.filter(call => new URL(call.url).pathname.endsWith('/labels')).length, 2);
});

test('fails closed at the fixed label-page limit rather than treating an incomplete read as absence', async t => {
  const { request, api } = input();
  const base = request.fetch;
  request.fetch = async (url, options) => {
    const target = new URL(url);
    if (!target.pathname.endsWith('/labels')) return base(url, options);
    api.calls.push({ url, options });
    return jsonResponse(Array.from({ length: 100 }, (_, index) => ({ name: `other-${index}` })));
  };
  await denied(t, request, 'github_read_failed');
  assert.equal(api.calls.filter(call => new URL(call.url).pathname.endsWith('/labels')).length, 10);
});

test('bounds nonsettling fetch and body reads even when abort signals or cancellation are ignored', async t => {
  for (const stalled of ['fetch', 'body']) {
    const { request } = input();
    request.timeoutMs = 15;
    request.fetch = stalled === 'fetch' ? async () => new Promise(() => {}) : async () => new Response(new ReadableStream({ start() {}, cancel() { return new Promise(() => {}); } }));
    let timer;
    const result = await Promise.race([
      checkApproval(request),
      new Promise(resolve => { timer = setTimeout(() => resolve({ authorized: true, reason: 'deadline_not_enforced' }), 250); }),
    ]);
    clearTimeout(timer);
    assert.deepEqual(result, { authorized: false, reason: 'github_read_failed' }, stalled);
  }
});

test('uses a bounded deadline, fixed host, and no model or publication capabilities', async () => {
  const { request, api } = input();
  const result = await checkApproval(request);
  assert.equal(result.authorized, true);
  assert.ok(api.calls.every(({ url, options }) => {
    const parsed = new URL(url);
    return parsed.origin === 'https://api.github.com'
      && options.redirect === 'manual'
      && options.signal instanceof AbortSignal
      && options.headers.authorization === 'Bearer synthetic-test-token';
  }));
  assert.deepEqual(Object.keys(request).sort(), [
    'expectedManifestSha256', 'fetch', 'manifest', 'token',
  ]);
});

test('rejects omitted pilot diagnostics and reporter check before GitHub reads', async () => {
  for (const omission of ['diagnostics', 'reporter-check']) {
    const { request, api } = input();
    if (omission === 'diagnostics') delete request.manifest.requiredWorkflowIdentities[0].diagnostics;
    else request.manifest.requiredChecks = request.manifest.requiredChecks.filter(check => check.context !== 'test-report');
    request.expectedManifestSha256 = pin(request.manifest);
    const result = await checkApproval(request);
    assert.equal(result.authorized, false, omission);
    assert.equal(result.reason, 'manifest_invalid', omission);
    assert.equal(api.calls.length, 0);
  }
});

test('accepts pinned diagnostic sources and trusted reporter identity', async () => {
  const { request, api } = input();
  request.manifest.requiredWorkflowIdentities[0].diagnostics = {
    version: 2,
    skipPolicy: { version: 1, sha256: DATABASE_SKIP_POLICY_SHA256 },
    sources: [
      { path: 'automation/ci/guard-command.mjs', sha256: '1'.repeat(64) },
      { path: 'automation/ci/run-tests.mjs', sha256: '2'.repeat(64) },
      { path: 'automation/ci/test-reporter.mjs', sha256: '3'.repeat(64) },
      { path: 'automation/ci/report-annotations.mjs', sha256: '4'.repeat(64) },
      { path: 'scripts/lib/output-guard.mjs', sha256: '5'.repeat(64) },
      { path: 'package.json', sha256: '6'.repeat(64) },
    ],
    reporter: { context: 'test-report', revision: 'a'.repeat(40), sha256: '7'.repeat(64) },
  };
  request.expectedManifestSha256 = pin(request.manifest);
  const result = await checkApproval(request);
  assert.equal(result.authorized, true);
  assert.equal(api.calls.length, 6);
});

test('rejects malformed or coercible diagnostics descriptors before GitHub reads', async t => {
  const valid = {
    version: 2,
    skipPolicy: { version: 1, sha256: DATABASE_SKIP_POLICY_SHA256 },
    sources: [
      { path: 'automation/ci/guard-command.mjs', sha256: '1'.repeat(64) },
      { path: 'automation/ci/run-tests.mjs', sha256: '2'.repeat(64) },
      { path: 'automation/ci/test-reporter.mjs', sha256: '3'.repeat(64) },
      { path: 'automation/ci/report-annotations.mjs', sha256: '4'.repeat(64) },
      { path: 'scripts/lib/output-guard.mjs', sha256: '5'.repeat(64) },
      { path: 'package.json', sha256: '6'.repeat(64) },
    ],
    reporter: { context: 'test-report', revision: 'a'.repeat(40), sha256: '7'.repeat(64) },
  };
  const invalid = [
    null,
    { ...valid, version: '1' },
    { ...valid, version: 1 },
    { ...valid, extra: false },
    { ...valid, reporter: undefined },
    { ...valid, reporter: { ...valid.reporter, context: 'test' } },
    { ...valid, reporter: { ...valid.reporter, revision: 'A'.repeat(40) } },
    { ...valid, reporter: { ...valid.reporter, sha256: 'x'.repeat(64) } },
    { version: 1, sources: valid.sources[0] },
    { version: 1, sources: [valid.sources[0]] },
    { version: 1, sources: [...valid.sources, valid.sources[1]] },
    { version: 1, sources: [...valid.sources].reverse() },
    { version: 1, sources: [valid.sources[0], { ...valid.sources[1], path: valid.sources[0].path }, ...valid.sources.slice(2)] },
    { version: 1, sources: [valid.sources[0], { ...valid.sources[1], sha256: valid.sources[0].sha256 }, ...valid.sources.slice(2)] },
    { version: 1, sources: [{ ...valid.sources[0], sha256: [valid.sources[0].sha256] }, ...valid.sources.slice(1)] },
    { version: 1, sources: [{ ...valid.sources[0], sha256: new String(valid.sources[0].sha256) }, ...valid.sources.slice(1)] },
    { version: 1, sources: [{ ...valid.sources[0], extra: true }, ...valid.sources.slice(1)] },
    { version: 1, sources: [{ ...valid.sources[0], path: '../run-tests.mjs' }, ...valid.sources.slice(1)] },
    { version: 1, sources: [{ ...valid.sources[0], path: 'automation/ci/other.mjs' }, ...valid.sources.slice(1)] },
  ];
  for (const diagnostics of invalid) {
    const { request, api } = input();
    request.manifest.requiredWorkflowIdentities[0].diagnostics = diagnostics;
    request.expectedManifestSha256 = pin(request.manifest);
    await denied(t, request, 'manifest_invalid');
    assert.equal(api.calls.length, 0);
  }

  const unknownIdentityKey = input();
  unknownIdentityKey.request.manifest.requiredWorkflowIdentities[0].unexpected = true;
  unknownIdentityKey.request.expectedManifestSha256 = pin(unknownIdentityKey.request.manifest);
  await denied(t, unknownIdentityKey.request, 'manifest_invalid');
  assert.equal(unknownIdentityKey.api.calls.length, 0);
});

test('snapshots diagnostic source pins before asynchronous approval reads', async () => {
  const { request } = input();
  request.manifest.requiredWorkflowIdentities[0].diagnostics = {
    version: 2,
    skipPolicy: { version: 1, sha256: DATABASE_SKIP_POLICY_SHA256 },
    sources: [
      { path: 'automation/ci/guard-command.mjs', sha256: '1'.repeat(64) },
      { path: 'automation/ci/run-tests.mjs', sha256: '2'.repeat(64) },
      { path: 'automation/ci/test-reporter.mjs', sha256: '3'.repeat(64) },
      { path: 'automation/ci/report-annotations.mjs', sha256: '4'.repeat(64) },
      { path: 'scripts/lib/output-guard.mjs', sha256: '5'.repeat(64) },
      { path: 'package.json', sha256: '6'.repeat(64) },
    ],
    reporter: { context: 'test-report', revision: 'a'.repeat(40), sha256: '7'.repeat(64) },
  };
  request.expectedManifestSha256 = pin(request.manifest);
  const originalFetch = request.fetch;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let fetchStarted = false;
  request.fetch = async (...args) => {
    fetchStarted = true;
    await gate;
    return originalFetch(...args);
  };
  const pending = checkApproval(request);
  request.manifest.requiredWorkflowIdentities[0].diagnostics.sources[0].sha256 = '9'.repeat(64);
  release();
  const result = await pending;
  assert.equal(fetchStarted, true);
  assert.equal(result.authorized, true);
});

test('rejects missing, unknown and changed DB skip policy before approval reads', async () => {
  for (const policy of [undefined, null, { version: 1, sha256: '0'.repeat(64) },
    { version: 2, sha256: DATABASE_SKIP_POLICY_SHA256 },
    { version: 1, sha256: DATABASE_SKIP_POLICY_SHA256, identities: [] }]) {
    const { request, api } = input();
    request.manifest.requiredWorkflowIdentities[0].diagnostics.skipPolicy = policy;
    request.expectedManifestSha256 = pin(request.manifest);
    const result = await checkApproval(request);
    assert.equal(result.authorized, false);
    assert.equal(result.reason, 'manifest_invalid');
    assert.equal(api.calls.length, 0);
  }
});
