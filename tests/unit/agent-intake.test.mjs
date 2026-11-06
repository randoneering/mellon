import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { currentIssue, dependencies, deliveryId, issueEvent, signedRequest, webhookSecret } from '../support/agent-intake-fixtures.mjs';

const moduleUrl = new URL('../../src/automation/intake.mjs', import.meta.url);
const intake = await import(moduleUrl.href).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === moduleUrl.href) return {};
  throw error;
});
function handler(deps) {
  assert.equal(typeof intake.createIntake, 'function', 'missing authenticated intake implementation');
  return intake.createIntake(deps);
}

test('accepts a correctly signed issue and stores no submitted text', async () => {
  const deps = dependencies();
  const response = await handler(deps)(signedRequest(issueEvent({ issue: { id: 456, number: 21, title: 'Unicode café 日本語', body: 'private-token; $(command)' } })));
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { status: 'queued' });
  assert.equal(deps.jobs.length, 1);
  assert.equal(deps.jobs[0].issueId, 456);
  assert.equal(deps.jobs[0].actorId, 789);
  assert.doesNotMatch(JSON.stringify(deps.jobs), /private-token|Unicode|title|body"|command|secret|signature/);
});

test('rejects absent, malformed, nonhex, and changed-body signatures before external work', async () => {
  for (const signature of ['', 'sha1=abc', 'sha256=abc', `sha256=${'z'.repeat(64)}`, `sha256=${'0'.repeat(64)}`]) {
    const deps = dependencies();
    const response = await handler(deps)(signedRequest(issueEvent(), { headers: { 'x-hub-signature-256': signature } }));
    assert.equal(response.status, 401);
    assert.deepEqual(deps.calls, []);
    assert.deepEqual(deps.jobs, []);
    assert.doesNotMatch(await response.text(), /Private|secret|sha256/);
  }
  const original = signedRequest();
  const changed = new Request(original.url, { method: 'POST', headers: original.headers, body: `${JSON.stringify(issueEvent())} ` });
  assert.equal((await handler(dependencies())(changed)).status, 401);
});

test('rejects signed malformed supported events and delivery identities without external work', async () => {
  for (const payload of ['{', 'null', '[]', issueEvent({ issue: { id: 456, number: 0 } }), issueEvent({ sender: { id: -1, login: 'maintainer', type: 'User' } }), issueEvent({ repository: { id: '123', full_name: 'randoneering/mellon' } })]) {
    const deps = dependencies();
    assert.equal((await handler(deps)(signedRequest(payload))).status, 400);
    assert.deepEqual(deps.calls, []);
  }
  for (const id of ['', 'not-a-uuid']) {
    const deps = dependencies();
    assert.equal((await handler(deps)(signedRequest(issueEvent(), { headers: { 'x-github-delivery': id } }))).status, 400);
    assert.deepEqual(deps.calls, []);
  }
});

test('ignores signed unrelated events, actions, labels, and ping without external work', async () => {
  for (const [payload, headers] of [
    [{ zen: 'A signed ping' }, { 'x-github-event': 'ping' }],
    [issueEvent(), { 'x-github-event': 'pull_request' }],
    [issueEvent({ action: 'opened' }), {}],
    [issueEvent({ label: { name: 'bug' } }), {}],
  ]) {
    const deps = dependencies();
    const response = await handler(deps)(signedRequest(payload, { headers }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ignored' });
    assert.deepEqual(deps.calls, []);
  }
});

test('rejects unsupported paths, methods, content types, and content encodings', async () => {
  for (const [options, status] of [
    [{ url: 'https://intake.example/other' }, 404],
    [{ method: 'GET' }, 405],
    [{ headers: { 'content-type': 'text/plain' } }, 415],
    [{ headers: { 'content-encoding': 'gzip' } }, 415],
  ]) {
    const deps = dependencies();
    assert.equal((await handler(deps)(signedRequest(issueEvent(), options))).status, status);
    assert.deepEqual(deps.calls, []);
  }
});

test('bounds streamed bodies without trusting a length header and cancels the stream', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(16384)); },
    cancel() { cancelled = true; },
  });
  const request = new Request('https://intake.example/github', { method: 'POST', body: stream, duplex: 'half', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${'0'.repeat(64)}`, 'content-length': '1' } });
  const deps = dependencies();
  assert.equal((await handler(deps)(request)).status, 413);
  assert.equal(cancelled, true);
  assert.deepEqual(deps.calls, []);
});

test('accepts case-insensitive readiness label and ignores a different repository or bot', async () => {
  const matching = dependencies();
  assert.equal((await handler(matching)(signedRequest(issueEvent({ label: { name: 'AGENT: Ready' } })))).status, 202);
  for (const payload of [
    issueEvent({ repository: { id: 124, full_name: 'randoneering/mellon' } }),
    issueEvent({ repository: { id: 123, full_name: 'someone/else' } }),
    issueEvent({ sender: { id: 789, login: 'robot[bot]', type: 'Bot' } }),
    issueEvent({ sender: { id: 10137, login: 'ghost', type: 'User' } }),
  ]) {
    const deps = dependencies();
    assert.equal((await handler(deps)(signedRequest(payload))).status, 200);
    assert.deepEqual(deps.calls, []);
    assert.equal(deps.jobs.length, 0);
  }
});

test('acknowledges the original delivery without reauthorizing or enqueueing', async () => {
  const bodyHash = createHash('sha256').update(JSON.stringify(issueEvent())).digest('hex');
  const deps = dependencies({ store: { async getDelivery(id) { assert.equal(id, deliveryId); return { bodyHash }; }, async enqueue() { assert.fail('duplicate was enqueued'); } } });
  const response = await handler(deps)(signedRequest());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'duplicate' });
  assert.deepEqual(deps.calls, []);
});

test('rejects a reused delivery ID with changed authenticated bytes', async () => {
  const deps = dependencies({ store: { async getDelivery() { return { bodyHash: '0'.repeat(64) }; }, async enqueue() { assert.fail('conflict was enqueued'); } } });
  assert.equal((await handler(deps)(signedRequest())).status, 400);
  assert.deepEqual(deps.calls, []);
});

test('fails safely on store or GitHub uncertainty without exposing raw errors', async () => {
  for (const overrides of [
    { store: { async getDelivery() { throw new Error('private DATABASE_URL token'); } } },
    { github: { async authorizeSender() { throw new Error('private GitHub token'); } } },
    { store: { async getDelivery() { return null; }, async enqueue() { throw new Error('private database response'); } } },
  ]) {
    const response = await handler(dependencies(overrides))(signedRequest());
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: 'unavailable' });
  }
});

test('ignores known ineligible senders and closed, unready, or PR issues without writing', async () => {
  const denied = dependencies({ github: { async authorizeSender() { return false; }, async readIssue() { assert.fail('unauthorized issue lookup'); } } });
  assert.equal((await handler(denied)(signedRequest())).status, 200);
  assert.equal(denied.jobs.length, 0);
  for (const issue of [currentIssue({ state: 'closed' }), currentIssue({ labels: [] }), currentIssue({ pull_request: {} })]) {
    const deps = dependencies({ github: { async authorizeSender() { return true; }, async readIssue() { return issue; } } });
    const response = await handler(deps)(signedRequest());
    assert.deepEqual(await response.json(), { status: 'ignored' });
    assert.equal(deps.jobs.length, 0);
  }
});

test('refuses mismatched API issue identities rather than enqueueing a different item', async () => {
  for (const issue of [currentIssue({ id: 999 }), currentIssue({ number: 22 }), currentIssue({ repository_url: 'https://api.github.com/repos/other/repo' })]) {
    const deps = dependencies({ github: { async authorizeSender() { return true; }, async readIssue() { return issue; } } });
    assert.equal((await handler(deps)(signedRequest())).status, 503);
    assert.equal(deps.jobs.length, 0);
  }
});

test('logs one fixed category and stage for unavailable operations without error details or issue text', async () => {
  for (const [overrides, category, stage] of [
    [{ store: { async getDelivery() { throw new Error('private DATABASE_URL password'); } } }, 'persistence_unavailable', 'receipt_read'],
    [{ github: { async authorizeSender() { throw new Error('private GitHub token'); } } }, 'github_unavailable', 'permission_read'],
    [{ github: { async authorizeSender() { return true; }, async readIssue() { throw new Error('private issue body'); } } }, 'github_unavailable', 'issue_read'],
    [{ store: { async getDelivery() { return null; }, async enqueue() { throw new Error('private database details'); } } }, 'persistence_unavailable', 'enqueue'],
  ]) {
    const deps = dependencies(overrides);
    const response = await handler(deps)(signedRequest());
    assert.deepEqual(await response.json(), { status: 'unavailable' });
    assert.equal(deps.logs.length, 1);
    assert.deepEqual(JSON.parse(deps.logs[0]), { category, stage, deliveryId });
    assert.doesNotMatch(deps.logs[0], /private|token|password|DATABASE_URL|https?:|Private title|Private body|sha256|secret/);
  }
});

test('a timed-out unauthenticated body emits only a safe timeout stage without trusting the delivery header', async () => {
  const stream = new ReadableStream({ start() {}, cancel() {} });
  const deps = dependencies({ requestTimeoutMs: 10 });
  const request = new Request('https://intake.example/github', { method: 'POST', body: stream, duplex: 'half', headers: { 'content-type': 'application/json', 'x-github-delivery': deliveryId } });
  const response = await handler(deps)(request);
  assert.equal(response.status, 503);
  assert.deepEqual(deps.logs.map(line => JSON.parse(line)), [{ category: 'request_timeout', stage: 'request_read', deliveryId: null }]);
});

test('normal skips and invalid signatures produce no operational failure diagnostics', async () => {
  const deps = dependencies();
  await handler(deps)(signedRequest({}, { headers: { 'x-github-event': 'ping' } }));
  await handler(deps)(signedRequest(issueEvent(), { headers: { 'x-hub-signature-256': 'invalid' } }));
  assert.deepEqual(deps.logs, []);
});

test('requires explicit nonempty configuration rather than accepting an empty secret', () => {
  assert.throws(() => handler(dependencies({ secret: '' })), /configuration/i);
  assert.throws(() => handler(dependencies({ repository: { id: 0, fullName: 'randoneering/mellon' } })), /configuration/i);
  assert.equal(webhookSecret.length > 0, true);
});
