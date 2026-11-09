import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTrustedReviewRequestPublisher, reviewRequestIdentity } from '../../src/automation/worker/review-request-publisher.mjs';
import { reviewRequestFixture } from '../fixtures/worker-review-request.mjs';

test('a fixed signing preflight does not have to be the newly generated commit', async () => {
  const h = reviewRequestFixture();
  assert.equal((await h.publisher.dispatch(h.input)).status, 'confirmed');
  assert.deepEqual(h.state.sequence, ['intent', 'attempt', 'post', 'confirm']);
  assert.equal((await h.publisher.dispatch(h.input)).alreadyConfirmed, true);
  assert.equal(h.state.posts, 1);
});

test('uncertain POST remains attempted across reruns without blind reposting', async () => {
  const h = reviewRequestFixture(); h.state.postFailure = true;
  const first = await h.publisher.dispatch(h.input);
  assert.equal(first.category, 'review_write_uncertain');
  h.state.postFailure = false;
  assert.equal((await h.publisher.dispatch(h.input)).category, 'review_write_uncertain');
  assert.equal(h.state.posts, 1);
  assert.doesNotMatch(JSON.stringify(first), /synthetic|private|transport/);
});

for (const [name, mutate] of [
  ['draft', h => { h.state.pr.draft = false; }],
  ['head', h => { h.state.pr.head.sha = 'd'.repeat(40); }],
  ['branch', h => { h.state.pr.head.ref = 'external'; }],
  ['author', h => { h.state.pr.user.id++; }],
  ['author login', h => { h.state.pr.user.login = 'spoof[bot]'; }],
  ['repository', h => { h.state.pr.head.repo = { id: 99, full_name: 'spoof/repo' }; }],
  ['commit author', h => { h.state.commit.author.id++; }],
  ['signature', h => { h.state.commit.commit.verification.verified = false; }],
]) test(`trusted review dispatch rejects ${name} drift without posting`, async () => {
  const h = reviewRequestFixture(); mutate(h);
  assert.equal((await h.publisher.dispatch(h.input)).status, 'needs_attention');
  assert.equal(h.state.posts, 0);
});

test('comment App spoofing cannot confirm a fenced write or authorize a retry', async () => {
  const h = reviewRequestFixture(); h.state.comment.performed_via_github_app.id++;
  assert.equal((await h.publisher.dispatch(h.input)).category, 'review_confirmation_mismatch');
  assert.equal((await h.publisher.dispatch(h.input)).category, 'review_write_uncertain');
  assert.equal(h.state.posts, 1);
});

test('confirmed partial work remains diagnosable after a lost database acknowledgement', async () => {
  const h = reviewRequestFixture();
  h.store.confirmReviewRequest = async () => { throw new Error('private database response'); };
  const value = await h.publisher.dispatch(h.input);
  assert.equal(value.status, 'needs_attention');
  assert.equal(value.commentId, 99);
  assert.doesNotMatch(JSON.stringify(value), /private database|synthetic/);
});

test('review dispatch rejects an over-scoped installation capability', async () => {
  const h = reviewRequestFixture(); h.state.permissions.issues = 'write';
  assert.equal((await h.publisher.dispatch(h.input)).category, 'review_context_invalid');
  assert.equal(h.state.posts, 0);
});

test('lease loss and fresh head drift after reservation prevent posting', async t => {
  for (const mode of ['lease', 'head']) await t.test(mode, async () => {
    const h = reviewRequestFixture(); let calls = 0;
    h.input.checkFence = async () => {
      if (++calls !== 2) return;
      if (mode === 'lease') throw new Error('private lease detail');
      h.state.pr.head.sha = 'f'.repeat(40);
    };
    assert.equal((await h.publisher.dispatch(h.input)).status, 'needs_attention');
    assert.equal(h.state.posts, 0);
    assert.equal(h.state.stored.attempted, false);
  });
});

test('head drift after a confirmed POST preserves the comment id but never authorizes completion', async () => {
  const h = reviewRequestFixture();
  h.state.onPost = () => {
    h.state.pr.head.sha = 'f'.repeat(40);
    return Response.json(h.state.comment, { status: 201 });
  };
  const value = await h.publisher.dispatch(h.input);
  assert.equal(value.category, 'review_head_changed');
  assert.equal(value.commentId, 99);
  assert.equal(h.state.stored.commentId, 99);
  assert.equal(h.state.posts, 1);
});

for (const [name, mutate] of [
  ['body marker', h => { h.state.comment.body += ' spoofed authority'; }],
  ['actor', h => { h.state.comment.user.id++; }],
  ['App', h => { h.state.comment.performed_via_github_app.id++; }],
  ['PR', h => { h.state.comment.issue_url = 'https://api.github.com/repos/randoneering/mellon/issues/13'; }],
]) test(`confirmed-id reconciliation rejects spoofed ${name} without a second POST`, async () => {
  const h = reviewRequestFixture();
  assert.equal((await h.publisher.dispatch(h.input)).status, 'confirmed');
  mutate(h);
  assert.equal((await h.publisher.dispatch(h.input)).category, 'review_confirmation_mismatch');
  assert.equal(h.state.posts, 1);
});

test('oversized POST acknowledgement stays uncertain and bounded', async () => {
  const h = reviewRequestFixture();
  h.state.onPost = () => new Response('x'.repeat(65537), { status: 201 });
  assert.equal((await h.publisher.dispatch(h.input)).category, 'review_write_uncertain');
  assert.equal((await h.publisher.dispatch(h.input)).category, 'review_write_uncertain');
  assert.equal(h.state.posts, 1);
});

test('trusted review request publisher does not post for an unapproved policy', async () => {
  let posts = 0;
  const publisher = createTrustedReviewRequestPublisher({
    getPullRequestContext: async () => { throw new Error('must not request a token'); },
    fetch: async (_url, options) => { if (options.method === 'POST') posts += 1; },
  });
  const result = await publisher.dispatch({ reviewPolicy: undefined });
  assert.deepEqual(result, { status: 'disabled' });
  assert.equal(posts, 0);
});

test('trusted review request publisher rejects an invalid opt-in binding before obtaining context', async () => {
  let contexts = 0;
  const publisher = createTrustedReviewRequestPublisher({
    getPullRequestContext: async () => { contexts += 1; },
  });
  const result = await publisher.dispatch({ reviewPolicy: {
    version: 1, profile: 'worker-command-maintainer-fallback-v1',
  } });
  assert.deepEqual(result, { status: 'needs_attention', category: 'review_binding_invalid' });
  assert.equal(contexts, 0);
});

test('trusted review request writes once and reconciles a confirmed native comment by id', async () => {
  const runId = '00000000-0000-4000-8000-000000000001';
  const headSha = 'a'.repeat(40);
  const actor = { databaseId: 19, login: 'worker[bot]' };
  const now = Date.now();
  const appId = 23;
  const token = 'synthetic-token';
  const publicationContext = {
    token, tokenExpiresAt: new Date(now + 3_600_000).toISOString(),
    contextExpiresAt: new Date(now + 240_000).toISOString(), repositoryId: 7,
    repositoryName: 'randoneering/mellon', appId, installationId: 29, actor,
    signingPreflight: { repositoryId: 7, repositoryName: 'randoneering/mellon', appId,
      installationId: 29, expiresAt: new Date(now + 180_000).toISOString(),
      commit: { oid: headSha, author: actor, committer: { name: 'GitHub', email: 'noreply@github.com' },
        signature: { isValid: true, state: 'VALID', wasSignedByGitHub: true } } },
  };
  const installationToken = { repositoryId: 7, repositoryName: 'randoneering/mellon',
    appId, installationId: 29, tokenExpiresAt: publicationContext.tokenExpiresAt,
    tokenSha256: createHash('sha256').update(token).digest('hex'),
    permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } };
  const run = { runId, repositoryId: 7, repositoryFullName: 'randoneering/mellon',
    pullRequestNumber: 12, expectedHeadSha: headSha, branchName: `agent-work/${runId}` };
  let stored = null;
  const sequence = [];
  const store = {
    async getReviewRequest() { return stored; },
    async reserveReviewRequest(_lease, input) { stored = { ...input, attempted: false }; return stored; },
    async attemptReviewRequest(_lease, input) {
      sequence.push('attempt');
      stored = { ...input, attempted: true };
      return { ...stored, canExecute: true };
    },
    async confirmReviewRequest(_lease, input) { stored = { ...stored, ...input }; return stored; },
  };
  const comment = { id: 99, body: '/agentic_review',
    issue_url: 'https://api.github.com/repos/randoneering/mellon/issues/12',
    user: { id: actor.databaseId, login: actor.login, type: 'Bot' },
    performed_via_github_app: { id: appId } };
  let posts = 0;
  const fetch = async (url, options = {}) => {
    if (url.endsWith('/pulls/12')) return Response.json({ number: 12,
      base: { ref: 'main', repo: { id: 7, full_name: 'randoneering/mellon' } },
      head: { repo: { id: 7, full_name: 'randoneering/mellon' }, ref: run.branchName, sha: headSha },
      user: { id: actor.databaseId, login: actor.login, type: 'Bot' }, state: 'open', draft: true });
    if (url.endsWith(`/commits/${headSha}`)) return Response.json({ sha: headSha,
      author: { id: actor.databaseId, login: actor.login }, commit: { verification: { verified: true } } });
    if (url.endsWith('/issues/12/comments') && options.method === 'POST') {
      posts += 1;
      sequence.push('post');
      return Response.json(comment, { status: 201 });
    }
    if (url.endsWith('/issues/comments/99')) return Response.json(comment);
    throw new Error(`unexpected request ${url}`);
  };
  const publisher = createTrustedReviewRequestPublisher({
    getPullRequestContext: async () => ({ publicationContext, installationToken }), fetch,
  });
  const input = { reviewPolicy: { version: 1, profile: 'worker-command-maintainer-fallback-v1' },
    run, lease: {}, workerActor: actor, expectedWorkerActor: actor, deadline: now + 10_000,
    store, database: operation => operation({}), checkApproval: async () => {}, checkFence: async () => {} };
  const first = await publisher.dispatch(input);
  assert.equal(first.status, 'confirmed');
  assert.equal(first.commentId, 99);
  assert.deepEqual(sequence, ['attempt', 'post']);
  const second = await publisher.dispatch(input);
  assert.equal(second.status, 'confirmed');
  assert.equal(second.alreadyConfirmed, true);
  assert.equal(posts, 1);
});

test('review request identity binds the exact head, actor, app, and fixed command', () => {
  const run = { runId: 'run-1', repositoryId: 7, repositoryFullName: 'randoneering/mellon',
    pullRequestNumber: 12, expectedHeadSha: 'a'.repeat(40) };
  const actor = { databaseId: 19, login: 'worker[bot]' };
  const identity = reviewRequestIdentity(run, actor, 23);
  assert.match(identity, /^[a-f0-9]{64}$/);
  assert.notEqual(identity, reviewRequestIdentity({ ...run, expectedHeadSha: 'b'.repeat(40) }, actor, 23));
  assert.notEqual(identity, reviewRequestIdentity(run, actor, 24));
});
