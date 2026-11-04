import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubClient, OUTCOME_LABELS } from '../../src/github.mjs';

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
  assert.deepEqual(JSON.parse(calls[1].options.body), { name: 'mellon: review', color: 'fbca04', description: 'Flagged by Mellon for maintainer review.' });
  assert.deepEqual(JSON.parse(calls[2].options.body), { labels: ['mellon: review'] });
});

test('GitHub client looks up fixed outcome labels without changing existing metadata', async () => {
  const calls = [];
  const labels = [
    'mellon: reviewed-human',
    'mellon: reviewed-ai',
    'mellon: reviewed-unsure',
  ];
  const client = createGitHubClient({ token: 'token', fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({
      name: decodeURIComponent(new URL(url).pathname.split('/').at(-1)),
      color: 'custom-color',
      description: 'Existing maintainer metadata',
    }), { status: 200 });
  } });

  assert.deepEqual(OUTCOME_LABELS.map(({ name }) => name), labels);
  for (const name of labels) {
    assert.deepEqual(await client.getOutcomeLabel({ repository: 'o/r', name }), { exists: true });
  }
  assert.deepEqual(calls.map(({ url, options }) => [options.method, new URL(url).pathname]), labels.map(name => [
    'GET', `/repos/o/r/labels/${encodeURIComponent(name)}`,
  ]));
});

test('GitHub client accepts existing outcome label identities with different capitalization', async () => {
  for (const [name, returnedName] of [
    ['mellon: reviewed-human', 'Mellon: Reviewed-Human'],
    ['mellon: reviewed-ai', 'MELLON: REVIEWED-AI'],
    ['mellon: reviewed-unsure', 'mellon: Reviewed-Unsure'],
  ]) {
    const calls = [];
    const client = createGitHubClient({ token: 'token', fetchImpl: async (url, options) => {
      calls.push({ method: options.method, url: String(url) });
      return new Response(JSON.stringify({ name: returnedName, color: 'abcdef', description: 'Kept by maintainer' }), { status: 200 });
    } });
    assert.deepEqual(await client.getOutcomeLabel({ repository: 'o/r', name }), { exists: true });
    assert.deepEqual(await client.createOutcomeLabel({ repository: 'o/r', name }), { confirmed: true });
    assert.deepEqual(calls.map(call => call.method), ['GET', 'POST']);
    assert.equal(calls[0].url, `https://api.github.com/repos/o/r/labels/${encodeURIComponent(name)}`);
  }
});

test('GitHub client creates only fixed outcome labels with distinct metadata', async () => {
  const calls = [];
  const client = createGitHubClient({ token: 'token', fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ name: JSON.parse(options.body).name }), { status: 201 });
  } });
  const definitions = [
    { name: 'mellon: reviewed-human', color: '0e8a16', description: 'Maintainer assessed the submission text as human-like.' },
    { name: 'mellon: reviewed-ai', color: 'd73a4a', description: 'Maintainer assessed the submission text as AI-like.' },
    { name: 'mellon: reviewed-unsure', color: 'fbca04', description: 'Maintainer could not confidently assess the submission text.' },
  ];

  for (const { name } of definitions) {
    assert.deepEqual(await client.createOutcomeLabel({ repository: 'o/r', name }), { confirmed: true });
  }
  assert.deepEqual(calls.map(({ url, options }) => [
    options.method, new URL(url).pathname, JSON.parse(options.body),
  ]), definitions.map(definition => ['POST', '/repos/o/r/labels', definition]));
});

test('GitHub client rejects unknown outcome labels and malformed label identities safely', async () => {
  let calls = 0;
  const client = createGitHubClient({ token: 'token', fetchImpl: async () => {
    calls++;
    return new Response('{"name":"mellon: review"}', { status: 200 });
  } });
  for (const name of ['mellon: review', 'custom label', '../issues/1']) {
    await assert.rejects(client.getOutcomeLabel({ repository: 'o/r', name }), /failed safely/);
    await assert.rejects(client.createOutcomeLabel({ repository: 'o/r', name }), /failed safely/);
  }
  await assert.rejects(client.getOutcomeLabel({ repository: 'o/r/other', name: 'mellon: reviewed-human' }), /failed safely/);
  await assert.rejects(client.createOutcomeLabel({ repository: 'o/r/other', name: 'mellon: reviewed-human' }), /failed safely/);
  const mismatched = createGitHubClient({ token: 'token', fetchImpl: async () => new Response('{"name":"mellon: review"}', { status: 200 }) });
  await assert.rejects(mismatched.getOutcomeLabel({ repository: 'o/r', name: 'mellon: reviewed-human' }), /failed safely/);
  await assert.rejects(mismatched.createOutcomeLabel({ repository: 'o/r', name: 'mellon: reviewed-human' }), /failed safely/);
  assert.equal(calls, 0);
});

test('GitHub client reports absent outcome labels and hides API error details', async () => {
  const client = createGitHubClient({ token: 'token', fetchImpl: async () => new Response('private response', { status: 404 }) });
  assert.deepEqual(await client.getOutcomeLabel({ repository: 'o/r', name: 'mellon: reviewed-human' }), { exists: false });
  const unavailable = createGitHubClient({ token: 'token', fetchImpl: async () => new Response('private response', { status: 500 }) });
  await assert.rejects(unavailable.getOutcomeLabel({ repository: 'o/r', name: 'mellon: reviewed-human' }), error => {
    assert.equal(error.message, 'GitHub API request failed safely.');
    assert.equal(error.message.includes('private response'), false);
    return true;
  });
});

test('label write errors expose only status for safe caller reconciliation', async () => {
  const calls = [];
  const client = createGitHubClient({ token: 'token', fetchImpl: async (url, options) => {
    calls.push(options.method);
    return new Response('private failure detail', { status: 503 });
  } });
  await assert.rejects(client.createReviewLabel({ repository: 'o/r' }), error => {
    assert.equal(error.status, 503);
    assert.equal(error.message.includes('private failure detail'), false);
    return true;
  });
  assert.deepEqual(calls, ['POST']);
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

test('label application does not retry or reconcile outside moderation state checks', async () => {
  let calls = 0;
  const client = createGitHubClient({ token: 'token', fetchImpl: async () => {
    calls++;
    return new Response(null, { status: 503 });
  } });
  await assert.rejects(client.addLabel({ repository: 'o/r', number: 4 }), error => error.status === 503);
  assert.equal(calls, 1);
});



test('GitHub client reads every page of current item labels', async () => {
  const urls = [];
  const client = createGitHubClient({ token: 'token', fetchImpl: async (url) => {
    urls.push(String(url));
    const page = urls.length === 1 ? [{ name: 'mellon: review' }]
      : [{ name: 'mellon: reviewed-unsure' }];
    return new Response(JSON.stringify(page), { status: 200, headers: {
      link: urls.length === 1
        ? '<https://api.github.com/repos/o/r/issues/4/labels?page=2>; rel="next"'
        : '',
    } });
  } });
  const labels = await client.getItemLabels({ repository: 'o/r', number: 4 });
  assert.deepEqual(labels, [{ name: 'mellon: review' }, { name: 'mellon: reviewed-unsure' }]);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /per_page=100$/);
  assert.match(urls[1], /page=2$/);
});

test('GitHub client rejects unparseable label pagination instead of returning incomplete labels', async () => {
  for (const link of [
    'unparseable pagination',
    '<https://api.github.com/repos/o/r/issues/4/labels?page=2>; rel=next',
    '<https://api.github.com/repos/o/r/issues/4/labels?page=2>; rel="next"; invalid',
  ]) {
    let calls = 0;
    const client = createGitHubClient({ token: 'token', fetchImpl: async () => {
      calls++;
      return new Response('[]', { status: 200, headers: { link } });
    } });
    await assert.rejects(client.getItemLabels({ repository: 'o/r', number: 4 }), /failed safely/);
    assert.equal(calls, 1);
  }
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
