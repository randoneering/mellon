import test from 'node:test';
import assert from 'node:assert/strict';
import { currentIssue, repository } from '../support/agent-intake-fixtures.mjs';

const moduleUrl = new URL('../../src/automation/github.mjs', import.meta.url);
const githubModule = await import(moduleUrl.href).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === moduleUrl.href) return {};
  throw error;
});
const sender = { id: 789, login: 'maintainer', type: 'User' };
function permission(overrides = {}) {
  return { permission: 'write', role_name: 'maintain', user: { ...sender }, ...overrides };
}
function reader(fetchImpl, overrides = {}) {
  assert.equal(typeof githubModule.createGitHubReader, 'function', 'missing bounded GitHub authorization adapter');
  return githubModule.createGitHubReader({ token: 'synthetic-github-token', repository, fetchImpl, ...overrides });
}

test('uses only fixed read endpoints, manual redirects, authenticated headers, and abort signals', async () => {
  const calls = [];
  const github = reader(async (url, options) => {
    calls.push({ url, options });
    return Response.json(url.includes('/collaborators/') ? permission() : currentIssue());
  });
  assert.equal(await github.authorizeSender(sender), true);
  assert.deepEqual(await github.readIssue(21), currentIssue());
  assert.deepEqual(calls.map(call => call.url), [
    'https://api.github.com/repos/randoneering/mellon/collaborators/maintainer/permission',
    'https://api.github.com/repos/randoneering/mellon/issues/21',
  ]);
  for (const { options } of calls) {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.authorization, 'Bearer synthetic-github-token');
    assert.equal(options.signal instanceof AbortSignal, true);
  }
});

test('accepts write, maintain, and admin permissions including maintain mapped to legacy write', async () => {
  for (const level of ['write', 'maintain', 'admin']) {
    assert.equal(await reader(async () => Response.json(permission({ permission: level }))).authorizeSender(sender), true);
  }
  for (const level of ['read', 'triage', 'none']) {
    assert.equal(await reader(async () => Response.json(permission({ permission: level, role_name: 'admin' }))).authorizeSender(sender), false);
  }
});

test('requires the permission response to identify the same human, not an author association', async () => {
  for (const data of [
    permission({ user: { ...sender, id: 790 } }),
    permission({ user: { ...sender, login: 'someone-else' } }),
    permission({ user: { ...sender, type: 'Bot' } }),
    permission({ user: undefined }),
    permission({ permission: undefined, author_association: 'OWNER' }),
    permission({ permission: 'unknown' }),
  ]) await assert.rejects(reader(async () => Response.json(data)).authorizeSender(sender), /GitHub eligibility check unavailable/);
});

test('rejects redirect, inaccessible, rate-limited, oversized, malformed, and failing reads safely', async () => {
  for (const fetchImpl of [
    async () => new Response(null, { status: 301, headers: { location: 'https://evil.example/token' } }),
    async () => new Response('private API details', { status: 404 }),
    async () => new Response('private API details', { status: 429 }),
    async () => new Response('x'.repeat(256 * 1024 + 1)),
    async () => new Response('{private malformed'),
    async () => { throw new Error('private token network details'); },
  ]) {
    await assert.rejects(reader(fetchImpl).readIssue(21), error => {
      assert.equal(error.message, 'GitHub eligibility check unavailable.');
      return true;
    });
  }
});

test('rejects missing or inconsistent current issue identity and malformed labels', async () => {
  for (const issue of [
    currentIssue({ id: 0 }), currentIssue({ number: 22 }),
    currentIssue({ repository_url: 'https://api.github.com/repos/other/repo' }),
    currentIssue({ labels: null }), currentIssue({ labels: ['agent: ready'] }),
    currentIssue({ state: 'unknown' }),
  ]) await assert.rejects(reader(async () => Response.json(issue)).readIssue(21), /GitHub eligibility check unavailable/);
});

test('supports different issue numbers without an allowlist and preserves current state for the handler', async () => {
  for (const number of [1, 21, 999999]) {
    const issue = currentIssue({ number, state: 'closed', labels: [{ name: 'AGENT: Ready' }] });
    assert.deepEqual(await reader(async () => Response.json(issue)).readIssue(number), issue);
  }
});

test('times out a request whose fetch or response body never completes', async () => {
  for (const fetchImpl of [
    async () => new Promise(() => {}),
    async () => new Response(new ReadableStream({ start() {} })),
  ]) {
    await assert.rejects(reader(fetchImpl, { timeoutMs: 15 }).readIssue(21), /GitHub eligibility check unavailable/);
  }
});

test('invalid configuration, sender, and issue numbers fail before sending credentials', async () => {
  let calls = 0;
  const github = reader(async () => { calls += 1; assert.fail('unexpected credentialed request'); });
  for (const number of [0, -1, '21', NaN]) await assert.rejects(github.readIssue(number));
  for (const actor of [{ ...sender, login: '../escape' }, { ...sender, id: 0 }, { ...sender, type: 'Bot' }]) await assert.rejects(github.authorizeSender(actor));
  assert.equal(calls, 0);
  assert.throws(() => reader(fetch, { token: '' }), /configuration/i);
  assert.throws(() => reader(fetch, { repository: { id: 123, fullName: 'other/../repo' } }), /configuration/i);
});
