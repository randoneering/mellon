import test from 'node:test';
import assert from 'node:assert/strict';
import * as github from '../../src/personalized/github.mjs';

const response = items => new Response(JSON.stringify(items));
const listing = (number, pull = false) => ({ number, ...(pull ? { pull_request: {} } : {}) });

test('accepts repository shorthand and strict GitHub repository URLs', () => {
  for (const value of ['Acme/project', 'https://github.com/Acme/project', 'https://github.com/Acme/project/']) {
    assert.deepEqual(github.parseRepository(value), { owner: 'Acme', repo: 'project' });
  }
});

test('rejects unsafe or ambiguous repository addresses', () => {
  for (const value of ['', '../project', 'acme/..', 'acme/.', 'acme/project/extra',
    'http://github.com/acme/project', 'https://evil.example/acme/project',
    'https://user:secret@github.com/acme/project', 'https://github.com/acme/project?token=secret',
    'https://github.com/acme/project#fragment', 'https://github.com/acme/project/issues/1',
    'https://github.com/acme/%2e%2e/project', 'acme/project\n']) {
    assert.throws(() => github.parseRepository(value), /repository/i);
  }
});

test('discovers separate newest-created issue and PR samples through fixed read-only requests', async () => {
  const calls = [];
  const urls = await github.discoverRepositoryUrls('Acme/project', { issues: 2, pullRequests: 1 }, 'private-token', async (url, options) => {
    calls.push({ url: new URL(url), options });
    return new URL(url).pathname.endsWith('/issues')
      ? response([listing(9, true), listing(8), listing(7), listing(6)])
      : response([{ ...listing(9), html_url: 'https://evil.example/steal' }, listing(5)]);
  });
  assert.deepEqual(urls, [
    'https://github.com/Acme/project/issues/8', 'https://github.com/Acme/project/issues/7',
    'https://github.com/Acme/project/pull/9',
  ]);
  assert.equal(calls.length, 2);
  for (const { url, options } of calls) {
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(url.searchParams.get('state'), 'all');
    assert.equal(url.searchParams.get('sort'), 'created');
    assert.equal(url.searchParams.get('direction'), 'desc');
    assert.equal(url.searchParams.get('per_page'), '100');
    assert.equal(url.searchParams.get('page'), '1');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.authorization, 'Bearer private-token');
    assert.ok(options.signal instanceof AbortSignal);
  }
  assert.notEqual(calls[0].options.signal, calls[1].options.signal);
});

test('paginates mixed issue listings without counting PRs or duplicate issues', async () => {
  const pages = [];
  const urls = await github.discoverRepositoryUrls('a/b', { issues: 2, pullRequests: 0 }, 'token', async url => {
    const page = Number(new URL(url).searchParams.get('page'));
    pages.push(page);
    return response(page === 1
      ? [...Array.from({ length: 99 }, (_, i) => listing(1000 - i, true)), listing(4)]
      : [listing(4), listing(3), listing(2)]);
  });
  assert.deepEqual(urls, ['https://github.com/a/b/issues/4', 'https://github.com/a/b/issues/3']);
  assert.deepEqual(pages, [1, 2]);
});

test('stops at the requested limit without following untrusted pagination links', async () => {
  let requests = 0;
  const urls = await github.discoverRepositoryUrls('a/b', { issues: 1, pullRequests: 0 }, 'token', async () => {
    requests++;
    return new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => listing(100 - i))), {
      headers: { link: '<https://evil.example/steal>; rel="next"' },
    });
  });
  assert.deepEqual(urls, ['https://github.com/a/b/issues/100']);
  assert.equal(requests, 1);
});

test('skips disabled kinds and returns fewer submissions when a final page is exhausted', async () => {
  const paths = [];
  const urls = await github.discoverRepositoryUrls('a/b', { issues: 0, pullRequests: 20 }, 'token', async url => {
    paths.push(new URL(url).pathname);
    return response([listing(3)]);
  });
  assert.deepEqual(paths, ['/repos/a/b/pulls']);
  assert.deepEqual(urls, ['https://github.com/a/b/pull/3']);
});

test('accepts the maximum count and stops after one full page', async () => {
  let requests = 0;
  const urls = await github.discoverRepositoryUrls('a/b', { issues: 100, pullRequests: 0 }, 'token', async () => {
    requests++;
    return response(Array.from({ length: 100 }, (_, i) => listing(100 - i)));
  });
  assert.equal(urls.length, 100);
  assert.equal(urls.at(-1), 'https://github.com/a/b/issues/1');
  assert.equal(requests, 1);
});

test('repository requests use five-second deadlines and sanitize response timeouts', async t => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const durations = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    durations.push(milliseconds);
    return timeout(milliseconds);
  });
  await assert.rejects(github.discoverRepositoryUrls('a/b', { issues: 1, pullRequests: 0 }, 'private-token', async () => ({
    ok: true, status: 200,
    json: async () => { throw new DOMException('private-body private-token', 'TimeoutError'); },
  })), error => {
    assert.match(error.message, /repository discovery failed/i);
    assert.doesNotMatch(error.message, /private-token|private-body/);
    return true;
  });
  assert.deepEqual(durations, [5000]);
});

test('returns an empty selection for an empty repository', async () => {
  assert.deepEqual(await github.discoverRepositoryUrls('a/b', { issues: 20, pullRequests: 20 }, 'token', async () => response([])), []);
});

test('rejects invalid limits and missing credentials before fetching', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; return response([]); };
  for (const limits of [
    { issues: 0, pullRequests: 0 }, { issues: -1, pullRequests: 1 },
    { issues: 101, pullRequests: 0 }, { issues: 1.5, pullRequests: 1 },
    { issues: '20', pullRequests: 1 }, { issues: NaN, pullRequests: 1 },
    { issues: 1, pullRequests: Infinity },
  ]) await assert.rejects(github.discoverRepositoryUrls('a/b', limits, 'token', fetchImpl), /count|limit/i);
  await assert.rejects(github.discoverRepositoryUrls('a/b', { issues: 1, pullRequests: 0 }, '', fetchImpl));
  assert.equal(requests, 0);
});

test('reports absent repository sample counts without making a request', async () => {
  let requests = 0;
  const fetchImpl = async () => {
    requests++;
    return response([]);
  };
  for (const counts of [undefined, null, {}, { issues: 1 }, { pullRequests: 1 }]) {
    await assert.rejects(
      github.discoverRepositoryUrls('a/b', counts, 'token', fetchImpl),
      { message: 'Issue and PR counts must be integers from 0 to 100, with at least one positive count.' },
    );
  }
  assert.equal(requests, 0);
});

test('bounds scans even when all issue pages contain only PRs', async () => {
  let requests = 0;
  await assert.rejects(github.discoverRepositoryUrls('a/b', { issues: 1, pullRequests: 0 }, 'token', async () => {
    requests++;
    return response(Array.from({ length: 100 }, (_, i) => listing(i + 1, true)));
  }), /scan limit.*fewer issues/i);
  assert.equal(requests, 10);
});

for (const [name, fetchImpl] of [
  ['redirect', async () => new Response(null, { status: 302, headers: { location: 'https://evil.example' } })],
  ['rate limit', async () => new Response('private-body', { status: 429 })],
  ['missing repository', async () => new Response('private-body', { status: 404 })],
  ['network', async () => { throw new Error('private-token private-body'); }],
  ['non-list', async () => response({ message: 'private-body' })],
  ['bad number', async () => response([{ number: '../steal' }])],
  ['null entry', async () => response([null])],
]) {
  test(`sanitizes repository discovery ${name} failures`, async () => {
    await assert.rejects(github.discoverRepositoryUrls('a/b', { issues: 1, pullRequests: 0 }, 'private-token', fetchImpl), error => {
      assert.match(error.message, /repository discovery failed/i);
      assert.doesNotMatch(error.message, /private-token|private-body|evil|steal/);
      return true;
    });
  });
}
