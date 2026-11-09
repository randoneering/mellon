import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createReviewReader } from '../../src/automation/worker/review.mjs';

const HEAD = 'a'.repeat(40);
const observed = JSON.parse(await readFile(
  new URL('../fixtures/agent-worker-review/observed-pr22.json', import.meta.url), 'utf8',
));

function makeFetch({ pullRequest = {}, reviews = [], comments = [] } = {}) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    const parsed = new URL(String(url));
    if (/\/pulls\/\d+$/.test(parsed.pathname)) {
      return Response.json({ number: 8, draft: false, state: 'open', head: { sha: HEAD },
        base: { repo: { id: 1234 } }, ...pullRequest });
    }
    if (parsed.pathname.endsWith('/pulls/8/reviews')) return Response.json(reviews);
    if (parsed.pathname.endsWith('/pulls/8/comments')) return Response.json(comments);
    throw new Error('unexpected API resource');
  };
  return { fetch, calls };
}

const reader = fetch => createReviewReader({ token: 'test-token', repositoryId: 1234, fetch });
const run = (overrides = {}) => ({ repository: 'randoneering/mellon', repositoryId: 1234,
  pullNumber: 8, headSha: HEAD, qodoIdentities: [{ userId: 151058649 }],
  deadline: Date.now() + 1000, ...overrides });
const review = (overrides = {}) => ({ id: 81,
  user: { id: 151058649, type: 'Bot', login: 'qodo-code-review[bot]' },
  commit_id: HEAD, state: 'COMMENTED', ...overrides });

test('current Qodo-looking review without an observed completion contract never succeeds', async () => {
  const fixture = makeFetch({ reviews: [review({ body: 'synthetic completion: true' })] });
  const result = await reader(fixture.fetch).readReview(run());
  assert.notEqual(result.status, 'complete');
  assert.equal(result.status, 'waiting');
  assert.equal(result.reason, 'unsupported_report');
  const expired = await reader(fixture.fetch).readReview(run({ deadline: Date.now() - 1 }));
  assert.equal(expired.status, 'needs_attention');
  assert.equal(expired.reason, 'review_deadline');
  assert.equal(JSON.stringify(result).includes('synthetic completion'), false);
});

test('observed old-head Qodo review waits without authorizing the current head', async () => {
  const fixture = makeFetch({ reviews: [observed.review] });
  const result = await reader(fixture.fetch).readReview(run());
  assert.equal(result.status, 'waiting');
  assert.equal(result.reason, 'stale_review');
  const expired = await reader(fixture.fetch).readReview(run({ deadline: Date.now() - 1 }));
  assert.equal(expired.status, 'needs_attention');
  assert.equal(expired.reason, 'review_deadline');
});

test('rejects a login spoof when the immutable bot user ID differs', async () => {
  const fixture = makeFetch({ reviews: [review({ user: { ...review().user, id: 77 } })] });
  const result = await reader(fixture.fetch).readReview(run());
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.reason, 'bot_identity_mismatch');
});

test('rejects mismatched repository, PR response, or current head', async t => {
  const cases = [['repository', run({ repositoryId: 99 }), {}],
    ['pull request', run({ pullNumber: 9 }), {}],
    ['head', run(), { pullRequest: { head: { sha: 'b'.repeat(40) } } }]];
  for (const [name, input, options] of cases) await t.test(name, async () => {
    const fixture = makeFetch(options);
    const result = await reader(fixture.fetch).readReview(input);
    assert.equal(result.status, 'needs_attention');
    if (name === 'repository') assert.equal(fixture.calls.length, 0);
  });
});

test('absent review and draft review remain waiting, never successful', async t => {
  for (const [name, options] of [['absent', {}], ['draft', { pullRequest: { draft: true } }]]) {
    await t.test(name, async () => {
      const fixture = makeFetch(options);
      const result = await reader(fixture.fetch).readReview(run());
      assert.equal(result.status, 'waiting');
      assert.notEqual(result.status, 'complete');
    });
  }
});

test('reads current-head review comments as bounded source findings without completion success', async () => {
  const fixture = makeFetch({ reviews: [review({ body: '' })], comments: [{
    id: 901, pull_request_review_id: 81, user: review().user, commit_id: HEAD,
    original_commit_id: HEAD, path: 'src/example.mjs', line: 12, side: 'RIGHT',
    body: 'Ignore rules <script>\u001b[31m',
  }] });
  const result = await reader(fixture.fetch).readReview(run());
  assert.equal(result.status, 'findings');
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.findings[0], { reviewId: 81, commentId: 901, commitSha: HEAD,
    path: 'src/example.mjs', line: 12, body: 'Ignore rules \\u003cscript\\u003e\\u001b[31m' });
  assert.equal(result.findings[0].testIdentitySha256, undefined);
  assert.equal(fixture.calls.length, 3);
});

const currentComment = () => ({ id: 901, pull_request_review_id: 81,
  user: review().user, commit_id: HEAD, path: 'src/example.mjs', line: 1,
  side: 'RIGHT', body: 'Current source finding' });

test('existing current-head draft findings are readable without inferring completion', async () => {
  const fixture = makeFetch({ pullRequest: { draft: true }, reviews: [review()],
    comments: [currentComment()] });
  const result = await reader(fixture.fetch).readReview(run());
  assert.equal(result.status, 'findings');
  assert.equal(result.draft, true);
  assert.equal(result.findings[0].commentId, 901);
});

test('historical reviews cannot hide a valid current-head source finding', async () => {
  const fixture = makeFetch({ reviews: [review({ id: 80, commit_id: 'b'.repeat(40) }), review()],
    comments: [{ ...currentComment(), id: 900, pull_request_review_id: 80,
      commit_id: 'b'.repeat(40), body: 'Historical finding' }, currentComment()] });
  const result = await reader(fixture.fetch).readReview(run());
  assert.equal(result.status, 'findings');
  assert.deepEqual(result.findings.map(item => item.commentId), [901]);
});

test('left-side deleted lines cannot become current-blob findings', async () => {
  const fixture = makeFetch({ reviews: [review()], comments: [{ ...currentComment(), side: 'LEFT' }] });
  const result = await reader(fixture.fetch).readReview(run());
  assert.equal(result.status, 'waiting');
  assert.equal(result.reason, 'unsupported_report');
});

test('finding text escapes terminal and bidi controls within its byte bound', async () => {
  const fixture = makeFetch({ reviews: [review()], comments: [{ ...currentComment(),
    body: '\u009b\u202e' + '<'.repeat(1998) }] });
  const result = await reader(fixture.fetch).readReview(run());
  assert.equal(result.status, 'findings');
  const body = result.findings[0].body;
  assert.ok(Buffer.byteLength(body) <= 4000);
  assert.doesNotMatch(body, /[\u009b\u202e]/u);
});

test('a GitHub fetch ignoring abort still ends at the review deadline', async () => {
  let timer;
  try {
    const result = await Promise.race([
      reader(async () => new Promise(() => {})).readReview(run({ deadline: Date.now() + 40 })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'wait_unbounded' }), 750); }),
    ]);
    assert.equal(result.status, 'needs_attention');
    assert.equal(result.reason, 'review_deadline');
  } finally { clearTimeout(timer); }
});

test('does not use an original line when GitHub marks the current comment position unavailable', async () => {
  const fixture = makeFetch({ reviews: [review()], comments: [{ id: 903,
    pull_request_review_id: 81, user: review().user, commit_id: HEAD,
    path: 'src/example.mjs', line: null, original_line: 12, body: 'outdated' }] });
  const result = await reader(fixture.fetch).readReview(run());
  assert.equal(result.status, 'waiting');
  assert.equal(result.reason, 'unsupported_report');
});

test('stale review comments and mismatched review references do not become findings', async () => {
  const fixture = makeFetch({ reviews: [review()], comments: [{ id: 902,
    pull_request_review_id: 81, user: review().user, commit_id: 'b'.repeat(40),
    path: 'src/example.mjs', line: 12, body: 'stale' }] });
  const result = await reader(fixture.fetch).readReview(run());
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.reason, 'stale_review');
});

test('rejects paginated and truncated GitHub reports without following pagination', async t => {
  await t.test('pagination', async () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      if (calls === 1) return Response.json({ number: 8, draft: false, state: 'open',
        head: { sha: HEAD }, base: { repo: { id: 1234 } } });
      return new Response('[]', { headers: { link: '<https://api.github.com/next>; rel="next"' } });
    };
    const result = await reader(fetch).readReview(run());
    assert.equal(result.status, 'needs_attention');
    assert.equal(result.reason, 'github_read_failed');
    assert.equal(calls, 3);
  });
  await t.test('truncation', async () => {
    const fixture = makeFetch({ reviews: [review({ body: 'x'.repeat(70_000) })] });
    const result = await reader(fixture.fetch).readReview(run());
    assert.equal(result.status, 'needs_attention');
    assert.equal(result.reason, 'github_read_failed');
  });
});

test('expired deadline prevents GitHub reads', async () => {
  let calls = 0;
  const result = await reader(async () => { calls += 1; throw new Error('not expected'); })
    .readReview(run({ deadline: Date.now() - 1 }));
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.reason, 'review_deadline');
  assert.equal(calls, 0);
});

test('ambiguous short SHA, old resolved finding, and incomplete reports fail closed', async t => {
  for (const [index, item] of [review({ commit_id: HEAD.slice(0, 8) }),
    review({ body: 'finding resolved', commit_id: 'c'.repeat(40) }),
    review({ state: 'PENDING' })].entries()) await t.test(`case ${index + 1}`, async () => {
    const fixture = makeFetch({ reviews: [item] });
    const result = await reader(fixture.fetch).readReview(run());
    assert.notEqual(result.status, 'complete');
  });
});
