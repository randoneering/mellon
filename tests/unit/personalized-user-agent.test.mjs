import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchSubmission, parseSubmissionUrl } from '../../src/personalized/github.mjs';

// Removing the header or deriving it from request data must break this test.
test('personalized GitHub requests include the fixed client User-Agent', async () => {
  const fixtures = [
    {
      url: 'https://github.com/example-one/project-a/issues/7',
      endpoint: 'https://api.github.com/repos/example-one/project-a/issues/7',
      token: 'synthetic-token-one',
      response: { title: 'Issue title', body: 'Issue body' },
      expected: { title: 'Issue title', body: 'Issue body' },
    },
    {
      url: 'https://github.com/example-two/project-b/pull/19',
      endpoint: 'https://api.github.com/repos/example-two/project-b/issues/19',
      token: 'synthetic-token-two',
      response: { title: 'Pull request title', body: null },
      expected: { title: 'Pull request title', body: '' },
    },
  ];
  const signals = new Set();

  for (const fixture of fixtures) {
    const requests = [];
    // Replace only the external transport; run the real request builder.
    const fetchImpl = async (endpoint, options) => {
      requests.push({ endpoint, options });
      return new Response(JSON.stringify(fixture.response), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const result = await fetchSubmission(parseSubmissionUrl(fixture.url), fixture.token, fetchImpl);

    assert.equal(requests.length, 1);
    const { endpoint, options } = requests[0];
    assert.equal(options.headers['user-agent'], 'mellon-personalized-detection');
    assert.equal(endpoint, fixture.endpoint);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.deepEqual(options.headers, {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${fixture.token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'mellon-personalized-detection',
    });
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    assert.equal(signals.has(options.signal), false);
    signals.add(options.signal);
    assert.deepEqual(result, fixture.expected);
  }
});
