import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubClient } from '../../src/github.mjs';

test('GitHub client requests fixed trusted issue resources with bounded credentials', async () => {
  const calls = [];
  const client = createGitHubClient({ token: 'secret-token', fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ state: 'open', title: 'Title', body: 'Body', merged: false }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  } });
  await client.getItem({ repository: 'owner/repo', number: 7, kind: 'issue' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/owner/repo/issues/7');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.authorization, 'Bearer secret-token');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.signal instanceof AbortSignal, true);
});

test('GitHub client supports fixed review-label lookup, create, and application requests', async () => {
  const calls = [];
  const client = createGitHubClient({ token: 'token', fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    if (options.method === 'GET') return new Response(null, { status: 404 });
    if (new URL(url).pathname.endsWith('/issues/4/labels')) {
      return new Response('[{"name":"mellon: review"}]', { status: 200 });
    }
    return new Response('{"name":"mellon: review"}', { status: 201 });
  } });
  assert.deepEqual(await client.getReviewLabel({ repository: 'o/r' }), { exists: false });
  await client.createReviewLabel({ repository: 'o/r' });
  await client.addLabel({ repository: 'o/r', number: 4 });
  assert.deepEqual(calls.map(call => [call.options.method, new URL(call.url).pathname]), [
    ['GET', '/repos/o/r/labels/mellon%3A%20review'],
    ['POST', '/repos/o/r/labels'],
    ['POST', '/repos/o/r/issues/4/labels'],
  ]);
  assert.deepEqual(JSON.parse(calls[1].options.body), { name: 'mellon: review', color: 'fbca04', description: 'Flagged by Mellon observation mode.' });
  assert.deepEqual(JSON.parse(calls[2].options.body), { labels: ['mellon: review'] });
});

test('label creation 422 race is reconciled, while unrelated failures remain errors', async () => {
  const calls = [];
  let labelAvailable = false;
  const client = createGitHubClient({ token: 'token', fetchImpl: async (url, options) => {
    const pathname = new URL(url).pathname;
    calls.push([options.method, pathname]);
    if (options.method === 'POST' && pathname === '/repos/o/r/labels') {
      return new Response(JSON.stringify({ message: 'Validation Failed' }), { status: 422 });
    }
    if (pathname.includes('/labels/mellon%3A%20review')) {
      labelAvailable = true;
      return new Response(JSON.stringify({ name: 'mellon: review' }), { status: 200 });
    }
    return new Response('private failure', { status: 500 });
  } });
  await client.createReviewLabel({ repository: 'o/r' });
  assert.equal(labelAvailable, true);
  assert.deepEqual(calls, [['POST', '/repos/o/r/labels'], ['GET', '/repos/o/r/labels/mellon%3A%20review']]);
  const unavailable = createGitHubClient({ token: 'token', fetchImpl: async () => new Response('private failure', { status: 500 }) });
  await assert.rejects(unavailable.getReviewLabel({ repository: 'o/r' }), /failed safely/);
});

test('GitHub client uses correct closure endpoints and validates response identities', async () => {
  const calls = [];
  const client = createGitHubClient({ token: 'token', fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    if (options.method === 'PATCH') return new Response('{"state":"closed"}', { status: 200 });
    return new Response('{"id":13,"body":"posted","user":{"login":"github-actions[bot]","type":"Bot"}}', { status: 201 });
  } });
  const comment = await client.createComment({ repository: 'o/r', number: 2, body: 'posted' });
  assert.equal(comment.id, 13);
  await client.closeItem({ repository: 'o/r', number: 2, kind: 'pull_request' });
  await client.closeItem({ repository: 'o/r', number: 2, kind: 'issue' });
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(JSON.parse(calls[0].options.body).body, 'posted');
  assert.match(calls[1].url, /pulls\/2$/);
  assert.match(calls[2].url, /issues\/2$/);
});

test('GitHub client rejects redirects, malformed and oversized bodies without leaking details', async () => {
  let behavior = 'redirect';
  const client = createGitHubClient({ token: 'never-log-this', fetchImpl: async () => {
    if (behavior === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://evil.example/' } });
    if (behavior === 'malformed') return new Response('private response text', { status: 200 });
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('x'.repeat(2_000_000)));
      controller.close();
    } }), { status: 200 });
  } });
  for (const next of ['redirect', 'malformed', 'oversized']) {
    behavior = next;
    await assert.rejects(client.getItem({ repository: 'o/r', number: 1, kind: 'issue' }), (error) => {
      assert.equal(error.message.includes('never-log-this'), false);
      assert.equal(error.message.includes('private response text'), false);
      return true;
    });
  }
});

test('GitHub client applies timeout and caller cancellation safely', async () => {
  const never = (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('private abort')), { once: true });
  });
  const timeoutClient = createGitHubClient({ token: 'token', timeoutMs: 10, fetchImpl: never });
  await assert.rejects(timeoutClient.getItem({ repository: 'o/r', number: 1, kind: 'issue' }), /failed safely/);
  const caller = new AbortController();
  const callerClient = createGitHubClient({ token: 'token', signal: caller.signal, fetchImpl: never });
  const request = callerClient.getItem({ repository: 'o/r', number: 1, kind: 'issue' });
  caller.abort();
  await assert.rejects(request, /failed safely/);
});

test('GitHub comment pagination is same-origin and includes every page', async () => {
  const urls = [];
  const client = createGitHubClient({ token: 'token', fetchImpl: async (url) => {
    urls.push(String(url));
    const page = urls.length === 1
      ? [{ id: 1, body: 'one', user: { login: 'contributor', type: 'User' } }]
      : [{ id: 2, body: 'two', user: { login: 'github-actions[bot]', type: 'Bot' } }];
    return new Response(JSON.stringify(page), { status: 200, headers: {
      link: urls.length === 1 ? '<https://api.github.com/repos/o/r/issues/4/comments?page=2>; rel="next"' : '',
    } });
  } });
  const comments = await client.listComments({ repository: 'o/r', number: 4 });
  assert.deepEqual(comments.map((comment) => comment.id), [1, 2]);
  assert.equal(urls.length, 2);
});

test('uncertain label application reconciles before any repeated POST', async () => {
  const urls = [];
  const client = createGitHubClient({ token: 'token', fetchImpl: async (url, options) => {
    const parsed = new URL(url);
    urls.push([options.method ?? 'GET', parsed.pathname, parsed.search]);
    if (options.method === 'POST') return new Response(null, { status: 500 });
    if (options.method === 'GET' && parsed.searchParams.get('page') === '2') {
      return new Response('[{"name":"mellon: review"}]', { status: 200 });
    }
    if (options.method === 'GET' && parsed.pathname === '/repos/o/r/issues/4/labels') {
      return new Response('[{"name":"other"}]', { status: 200, headers: {
        link: '<https://api.github.com/repos/o/r/issues/4/labels?page=2&per_page=100>; rel="next"',
      } });
    }
    throw new Error('unexpected endpoint');
  } });
  const result = await client.addLabel({ repository: 'o/r', number: 4 });
  assert.deepEqual(result, { confirmed: true });
  assert.deepEqual(urls, [
    ['POST', '/repos/o/r/issues/4/labels', ''],
    ['GET', '/repos/o/r/issues/4/labels', '?per_page=100'],
    ['GET', '/repos/o/r/issues/4/labels', '?page=2&per_page=100'],
  ]);
});

test('uncertain label creation reconciles before any repeated POST', async () => {
  const calls = [];
  const client = createGitHubClient({ token: 'token', fetchImpl: async (url, options) => {
    const pathname = new URL(url).pathname;
    calls.push([options.method ?? 'GET', pathname]);
    if (options.method === 'POST') return new Response(null, { status: 503 });
    return new Response('{"name":"mellon: review"}', { status: 200 });
  } });
  assert.deepEqual(await client.createReviewLabel({ repository: 'o/r' }), { confirmed: true });
  assert.deepEqual(calls, [
    ['POST', '/repos/o/r/labels'],
    ['GET', '/repos/o/r/labels/mellon%3A%20review'],
  ]);
});

test('uncertain label writes do not proceed after reconciliation finds stale state', async () => {
  const calls = [];
  const client = createGitHubClient({ token: 'token', fetchImpl: async (url, options) => {
    const parsed = new URL(url);
    calls.push([options.method ?? 'GET', parsed.pathname]);
    if (options.method === 'POST') return new Response(null, { status: 500 });
    if (parsed.pathname === '/repos/o/r/labels/mellon%3A%20review') return new Response(null, { status: 404 });
    if (parsed.pathname === '/repos/o/r/issues/4/labels') return new Response('[{"name":"other"}]', { status: 200 });
    throw new Error('unexpected endpoint');
  } });
  await assert.rejects(client.createReviewLabel({ repository: 'o/r' }), /failed safely/);
  await assert.deepEqual(await client.addLabel({ repository: 'o/r', number: 4 }), { confirmed: false });
  assert.deepEqual(calls, [
    ['POST', '/repos/o/r/labels'],
    ['GET', '/repos/o/r/labels/mellon%3A%20review'],
    ['POST', '/repos/o/r/issues/4/labels'],
    ['GET', '/repos/o/r/issues/4/labels'],
  ]);
});

test('GitHub client rejects malformed label arrays during reconciliation', async () => {
  const client = createGitHubClient({ token: 'token', fetchImpl: async () => new Response('[{"name":3}]', { status: 200 }) });
  await assert.rejects(client.getItemLabels({ repository: 'o/r', number: 4 }), /failed safely/);
});

test('GitHub client rejects cross-origin pagination before issuing another request', async () => {
  let calls = 0;
  const client = createGitHubClient({ token: 'token', fetchImpl: async () => {
    calls++;
    return new Response('[]', { status: 200, headers: { link: '<https://evil.example/repo?page=2>; rel="next"' } });
  } });
  await assert.rejects(client.listComments({ repository: 'o/r', number: 4 }), /failed safely/);
  assert.equal(calls, 1);
});
