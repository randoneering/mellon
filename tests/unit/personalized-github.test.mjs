import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSubmission, parseSubmissionUrl } from '../../src/personalized/github.mjs';

test('parses issue and pull request URLs into canonical submissions', () => {
  assert.deepEqual(parseSubmissionUrl('https://github.com/Owner/repo/issues/12'), {
    owner: 'Owner', repo: 'repo', kind: 'issue', number: 12,
    canonicalUrl: 'https://github.com/Owner/repo/issues/12',
  });
  assert.equal(parseSubmissionUrl('https://github.com/o/r/pull/4').kind, 'pull_request');
});

test('rejects unsupported URL forms before making a credentialed request', async () => {
  for (const url of [
    'http://github.com/o/r/issues/1', 'https://evil.example/o/r/issues/1',
    'https://user:pass@github.com/o/r/issues/1', 'https://github.com/o/r/issues/1?x=1',
    'https://github.com/o/r/issues/1#frag', 'https://github.com/o/r/issues/1/comments',
    'https://github.com/o/r/pulls/1',
  ]) assert.throws(() => parseSubmissionUrl(url));
});

test('fetches selected issue with credentials only to GitHub API', async () => {
  const calls = [];
  const result = await fetchSubmission(parseSubmissionUrl('https://github.com/o/r/issues/5'), 'secret', async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ title: 'Title', body: null }), { status: 200 });
  });
  assert.deepEqual(result, { title: 'Title', body: '' });
  assert.match(calls[0].url, /^https:\/\/api\.github\.com\/repos\/o\/r\/issues\/5$/);
  assert.equal(calls[0].options.headers.authorization, 'Bearer secret');
  assert.equal(calls[0].options.redirect, 'manual');
});

test('fetches a selected pull request with no description via the shared issues endpoint', async () => {
  const parsed = parseSubmissionUrl('https://github.com/owner/repo/pull/12');
  const calls = [];
  const result = await fetchSubmission(parsed, 'fixture-token', async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ title: 'Pull request', body: null }));
  });
  assert.deepEqual(result, { title: 'Pull request', body: '' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/owner/repo/issues/12');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.headers.authorization, 'Bearer fixture-token');
});

test('rejects a malformed pull request body with the fixed safe error', async () => {
  const parsed = parseSubmissionUrl('https://github.com/owner/repo/pull/12');
  await assert.rejects(
    fetchSubmission(parsed, 'fixture-token', async () =>
      new Response(JSON.stringify({ title: 'Private title', body: { text: 'Private description' } }))),
    { message: 'GitHub submission request failed safely.' },
  );
});

test('rejects mismatched parsed submission fields before fetching', async () => {
  const parsed = parseSubmissionUrl('https://github.com/o/r/issues/5');
  let called = false;
  await assert.rejects(fetchSubmission({ ...parsed, owner: 'other' }, 'secret', async () => {
    called = true;
  }));
  assert.equal(called, false);
});

test('rejects redirects and does not leak credential or response text in errors', async () => {
  await assert.rejects(fetchSubmission(parseSubmissionUrl('https://github.com/o/r/issues/5'), 'secret', async () =>
    new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } })), error => {
    assert.doesNotMatch(error.message, /secret|evil/);
    return true;
  });
});

test('reports inaccessible, rate-limited, malformed, and network failures safely', async () => {
  for (const fetchImpl of [
    async () => new Response('private', { status: 404 }),
    async () => new Response('private', { status: 429 }),
    async () => new Response('{}', { status: 200 }),
    async () => { throw new Error('secret network details'); },
  ]) await assert.rejects(fetchSubmission(parseSubmissionUrl('https://github.com/o/r/pull/5'), 'secret', fetchImpl), error => {
    assert.doesNotMatch(error.message, /secret|private/);
    return true;
  });
});
