import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createGitHubAppBroker } from '../../src/automation/worker/github-app.mjs';
import { validatePullRequestContext } from '../../src/automation/worker/publication-validation.mjs';
import { BROKER_REQUEST, brokerFixture } from '../fixtures/agent-worker-github-app.mjs';

async function boundedRejection(operation, reason) {
  let timer;
  try {
    const result = await Promise.race([
      operation.then(() => null, error => error),
      new Promise(resolve => { timer = setTimeout(() => resolve('wait-unbounded'), 750); }),
    ]);
    assert.ok(result instanceof Error, 'The broker must bound its local wait.');
    assert.equal(result.message, reason);
  } finally { clearTimeout(timer); }
}

test('installation authentication uses the verified App slug and public bot endpoint', async () => {
  const f = brokerFixture();
  assert.equal(await f.create().getReadToken(), 'ghs_test_1');
  assert.ok(f.calls.some(call => call.path === '/users/mellon[bot]'));
  assert.ok(!f.calls.some(call => call.path === '/user'));
});

test('pull request evidence belongs to its single least-privilege token issuance', async () => {
  const f = brokerFixture();
  const context = await f.create().getPullRequestContext(BROKER_REQUEST);
  assert.equal(f.issued.length, 1);
  assert.equal(context.publicationContext.token, f.issued[0].token);
  assert.deepEqual(f.issued[0].permissions, {
    metadata: 'read', contents: 'read', pull_requests: 'write',
  });
  assert.deepEqual(context.installationToken.permissions, f.issued[0].permissions);
  assert.equal(context.installationToken.tokenSha256,
    createHash('sha256').update(f.issued[0].token).digest('hex'));
  assert.equal(validatePullRequestContext(context, { repositoryId: 789 }).repositoryId, 789);
});

test('commit publication does not request pull request write permission', async () => {
  const f = brokerFixture();
  await f.create().getPublicationContext(BROKER_REQUEST);
  assert.deepEqual(f.issued[0].permissions, { metadata: 'read', contents: 'write' });
});

test('verified reader tokens are reused until refresh is required', async () => {
  const f = brokerFixture();
  const broker = f.create();
  assert.equal(await broker.getReadToken(), 'ghs_test_1');
  assert.equal(await broker.getReadToken(), 'ghs_test_1');
  assert.equal(f.issued.length, 1);
  f.advance(59 * 60_000);
  assert.equal(await broker.getReadToken(), 'ghs_test_2');
  assert.equal(f.issued.length, 2);
});

test('operator configuration cannot change broker authority after construction', async () => {
  const f = brokerFixture();
  const broker = f.create();
  f.config.appId = 999;
  f.config.repositoryId = 999;
  f.config.actor.databaseId = 999;
  assert.equal(await broker.getReadToken(), 'ghs_test_1');
  assert.equal(f.issued[0].repositories[0].id, 789);
  const jwt = f.calls[0].headers.authorization.slice(7).split('.')[1];
  assert.equal(JSON.parse(Buffer.from(jwt, 'base64url')).iss, '123');
});

test('another run branch is rejected before credentials are issued', async () => {
  const f = brokerFixture();
  await assert.rejects(f.create().getPublicationContext({
    ...BROKER_REQUEST,
    branch: 'agent-work/11111111-1111-1111-1111-111111111111',
  }), { message: 'github_app_request_invalid' });
  assert.equal(f.calls.length, 0);
});

const cases = [
  ['wrong App ID', '/app', data => ({ ...data, id: 999 }), 'github_app_identity_mismatch'],
  ['wrong App slug', '/app', data => ({ ...data, slug: 'imposter' }), 'github_app_identity_mismatch'],
  ['wrong installation', '/app/installations/456', data => ({ ...data, id: 999 }), 'github_app_identity_mismatch'],
  ['wrong installation App', '/app/installations/456', data => ({ ...data, app_id: 999 }), 'github_app_identity_mismatch'],
  ['suspended installation', '/app/installations/456', data => ({ ...data, suspended_at: '2026-01-01T00:00:00Z' }), 'github_app_identity_mismatch'],
  ['wrong bot ID', '/users/mellon[bot]', data => ({ ...data, id: 999 }), 'github_app_actor_mismatch'],
  ['human instead of bot', '/users/mellon[bot]', data => ({ ...data, type: 'User' }), 'github_app_actor_mismatch'],
  ['wrong repository identity', '/repositories/789', data => ({ ...data, id: 999 }), 'github_app_repository_mismatch'],
  ['extra token privilege', '/app/installations/456/access_tokens', data => ({ ...data, permissions: { ...data.permissions, administration: 'write' } }), 'github_app_capability_unconfirmed'],
  ['wrong token privilege', '/app/installations/456/access_tokens', data => ({ ...data, permissions: { ...data.permissions, contents: 'write' } }), 'github_app_capability_unconfirmed'],
  ['missing token privilege', '/app/installations/456/access_tokens', data => { delete data.permissions.checks; return data; }, 'github_app_capability_unconfirmed'],
  ['wrong token repository', '/app/installations/456/access_tokens', data => ({ ...data, repositories: [{ id: 999, full_name: 'randoneering/mellon' }] }), 'github_app_capability_unconfirmed'],
  ['expired token', '/app/installations/456/access_tokens', data => ({ ...data, expires_at: '2000-01-01T00:00:00Z' }), 'github_app_capability_unconfirmed'],
  ['overlong token expiry', '/app/installations/456/access_tokens', data => ({ ...data, expires_at: '2099-01-01T00:00:00Z' }), 'github_app_capability_unconfirmed'],
  ['missing token expiry', '/app/installations/456/access_tokens', data => { delete data.expires_at; return data; }, 'github_app_capability_unconfirmed'],
  ['broader accessible repositories', '/installation/repositories', data => ({ ...data, total_count: 2 }), 'github_app_capability_unconfirmed'],
  ['wrong accessible repository', '/installation/repositories', data => ({ ...data, repositories: [{ id: 999, full_name: 'randoneering/mellon' }] }), 'github_app_capability_unconfirmed'],
];
for (const [name, path, change, reason] of cases) {
  test(`broker rejects ${name}`, async () => {
    const f = brokerFixture({ mutate: call => call.path === path ? change(call.data) : call.data });
    await assert.rejects(f.create().getReadToken(), { message: reason });
  });
}

for (const [name, change] of [
  ['wrong pinned commit', repo => { repo.object.oid = 'f'.repeat(40); }],
  ['wrong signing actor', repo => { repo.object.author.user.databaseId = 999; }],
  ['invalid signature', repo => { repo.object.signature.isValid = false; }],
  ['wrong preflight repository', repo => { repo.databaseId = 999; }],
]) {
  test(`runtime authorization rejects ${name}`, async () => {
    const f = brokerFixture({ mutate: call => {
      if (call.path === '/graphql') change(call.data.data.repository);
      return call.data;
    } });
    await assert.rejects(f.create().verifyRuntime(), { message: 'github_app_preflight_invalid' });
  });
}

test('runtime authorization reads verified repository and signing proof', async () => {
  const f = brokerFixture();
  assert.equal(await f.create().verifyRuntime(), true);
  assert.ok(f.calls.some(call => call.path === '/installation/repositories'));
  assert.ok(f.calls.some(call => call.path === '/graphql'));
});

test('GraphQL errors cannot authorize a partial signing response', async () => {
  const f = brokerFixture({ mutate: call => call.path === '/graphql'
    ? { ...call.data, errors: [{ message: 'private detail' }] } : call.data });
  await assert.rejects(f.create().getPublicationContext(BROKER_REQUEST),
    { message: 'github_app_preflight_invalid' });
});

test('an all-repositories installation still receives a single-repository token', async () => {
  const f = brokerFixture({ mutate: call => call.path === '/app/installations/456'
    ? { ...call.data, repository_selection: 'all' } : call.data });
  assert.equal(await f.create().getReadToken(), 'ghs_test_1');
  assert.deepEqual(JSON.parse(f.calls.find(call => call.path.endsWith('/access_tokens')).body).repository_ids, [789]);
});

test('authoritative repository listing supports absent inline issuance repositories', async () => {
  const f = brokerFixture({ mutate: call => {
    if (call.path.endsWith('/access_tokens')) delete call.data.repositories;
    return call.data;
  } });
  assert.equal(await f.create().getReadToken(), 'ghs_test_1');
  assert.ok(f.calls.some(call => call.path === '/installation/repositories'));
});

test('fetch that ignores abort still has a bounded local wait', async () => {
  const f = brokerFixture({ transport: () => new Promise(() => {}) });
  await boundedRejection(f.create().getReadToken({ deadline: Date.now() + 40 }),
    'github_app_deadline_exceeded');
});

test('a response body that ignores abort still has a bounded local wait', async () => {
  const f = brokerFixture({ transport: () => new Response(new ReadableStream({ start() {} })) });
  await boundedRejection(f.create().getReadToken({ deadline: Date.now() + 40 }),
    'github_app_deadline_exceeded');
});

test('caller abort rejects even when fetch ignores its signal', async () => {
  const controller = new AbortController();
  const f = brokerFixture({ transport: () => {
    controller.abort();
    return new Promise(() => {});
  } });
  await boundedRejection(f.create().getReadToken({ signal: controller.signal, deadline: Date.now() + 40 }),
    'github_app_deadline_exceeded');
});

for (const [name, transport, reason] of [
  ['redirect', () => new Response('', { status: 302, headers: { location: 'https://example.com' } }), 'github_app_redirect_rejected'],
  ['malformed JSON', () => new Response('{private detail'), 'github_app_response_invalid'],
  ['invalid UTF-8', () => new Response(new Uint8Array([0xff])), 'github_app_response_invalid'],
  ['credential-bearing error', () => { throw new Error('github_app_ghs_private_payload'); }, 'github_app_unavailable'],
]) {
  test(`broker safely rejects ${name}`, async () => {
    const f = brokerFixture({ transport });
    await assert.rejects(f.create().getReadToken(), { message: reason });
  });
}

test('oversized streaming responses stop before the complete payload is read', async () => {
  const data = new TextEncoder().encode(JSON.stringify({ padding: 'x'.repeat(400_000) }));
  let offset = 0;
  let cancelled = false;
  const f = brokerFixture({ transport: () => new Response(new ReadableStream({
    pull(controller) {
      const next = Math.min(offset + 32_768, data.length);
      controller.enqueue(data.slice(offset, next));
      offset = next;
      if (offset === data.length) controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 })) });
  await assert.rejects(f.create().getReadToken(), { message: 'github_app_response_invalid' });
  assert.ok(offset < data.length);
  assert.equal(cancelled, true);
});

test('runtime authorization detects revoked grants even with warm token caches', async () => {
  let revoked = false;
  const f = brokerFixture({ mutate: call => {
    if (revoked && call.path === '/app/installations/456') {
      call.data.permissions.pull_requests = 'read';
    }
    return call.data;
  } });
  const broker = f.create();
  assert.equal(await broker.verifyRuntime(), true);
  revoked = true;
  await assert.rejects(broker.verifyRuntime(), { message: 'github_app_capability_unconfirmed' });
});

test('late fetch responses release their body after local cancellation', async () => {
  const controller = new AbortController();
  let deliver;
  let cancelled = false;
  const f = brokerFixture({ transport: () => {
    controller.abort();
    return new Promise(resolve => { deliver = resolve; });
  } });
  await assert.rejects(f.create().getReadToken({ signal: controller.signal }),
    { message: 'github_app_deadline_exceeded' });
  deliver(new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 })));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test('invalid private key failures expose only a fixed broker error', () => {
  const f = brokerFixture();
  assert.throws(() => createGitHubAppBroker({ ...f.config, privateKey: 'private-invalid-key' }),
    { message: 'github_app_config_invalid' });
});
