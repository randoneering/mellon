import assert from 'node:assert/strict';
import test from 'node:test';
import { createReviewReader } from '../../src/automation/worker/review.mjs';
import { OBSERVED_SUBMITTED_REVIEW, SUBMITTED_IDENTITY, submittedReviewApi }
  from '../fixtures/agent-worker-review/submitted.mjs';

const HEAD = 'a'.repeat(40);
function input() {
  return { repository: 'randoneering/mellon', repositoryId: 1234,
    pullNumber: 8, headSha: HEAD, deadline: Date.now() + 2000,
    qodoIdentities: [{ ...SUBMITTED_IDENTITY }] };
}
function reader(fetch) {
  return createReviewReader({ token: 'synthetic-reader-token', repositoryId: 1234, fetch });
}
function comment(overrides = {}) {
  return { id: 901, pull_request_review_id: 81,
    user: { id: 151058649, type: 'Bot', login: 'qodo-code-review[bot]' },
    commit_id: HEAD, path: 'src/value.mjs', line: 1, side: 'RIGHT',
    pull_request_url: 'https://api.github.com/repos/randoneering/mellon/pulls/8',
    body: 'Synthetic source finding', ...overrides };
}

test('opt-in profile verifies App association and a current submitted review before completion', async () => {
  assert.equal(OBSERVED_SUBMITTED_REVIEW.review.commit_id,
    OBSERVED_SUBMITTED_REVIEW.pull.head.sha);
  assert.equal(OBSERVED_SUBMITTED_REVIEW.pull.state, 'closed');
  const f = submittedReviewApi();
  const result = await reader(f.fetch).readReview(input());
  assert.equal(result.status, 'complete');
  assert.equal(result.authenticated, true);
  assert.equal(result.draft, true);
  assert.equal(result.reviewId, 81);
  assert.equal(result.headSha, HEAD);
  assert.deepEqual(result.findings, []);
  assert.ok(f.calls.some(call => call.path === '/apps/qodo-code-review'));
  assert.ok(f.calls.some(call => call.path === '/users/qodo-code-review[bot]'));
  assert.equal(JSON.stringify(result).includes('synthetic-reader-token'), false);
});

test('a worker requiring its owned draft stops if the PR is marked ready externally', async () => {
  const f = submittedReviewApi({ mutate: call => {
    if (call.path.endsWith('/pulls/8')) call.data.draft = false;
    return call.data;
  } });
  const result = await reader(f.fetch).readReview({ ...input(), requireDraft: true });
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.reason, 'draft_state_changed');
});

test('a published submitted-review profile preserves all associated source findings', async () => {
  const f = submittedReviewApi({ comments: [comment()] });
  const result = await reader(f.fetch).readReview(input());
  assert.equal(result.status, 'complete');
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].commentId, 901);
  assert.equal(result.findings[0].body, 'Synthetic source finding');
});

test('legacy user-ID-only configuration cannot enable submitted-review completion', async () => {
  const f = submittedReviewApi();
  const run = input(); run.qodoIdentities = [{ userId: 151058649 }];
  const result = await reader(f.fetch).readReview(run);
  assert.equal(result.status, 'waiting');
  assert.equal(result.reason, 'unsupported_report');
  assert.ok(!f.calls.some(call => call.path.startsWith('/apps/')));
});

for (const [name, mutate] of [
  ['App ID', call => { if (call.path === '/apps/qodo-code-review') call.data.id = 1; }],
  ['App slug', call => { if (call.path === '/apps/qodo-code-review') call.data.slug = 'another-app'; }],
  ['bot ID', call => { if (call.path === '/users/qodo-code-review[bot]') call.data.id = 1; }],
  ['bot type', call => { if (call.path === '/users/qodo-code-review[bot]') call.data.type = 'User'; }],
  ['bot login', call => { if (call.path === '/users/qodo-code-review[bot]') call.data.login = 'imposter[bot]'; }],
]) test(`submitted-review completion rejects a mismatched ${name}`, async () => {
  const f = submittedReviewApi({ mutate: call => { mutate(call); return call.data; } });
  const result = await reader(f.fetch).readReview(input());
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.reason, 'bot_identity_mismatch');
});

for (const [name, change] of [
  ['missing submission', review => { delete review.submitted_at; }],
  ['null submission', review => { review.submitted_at = null; }],
  ['malformed submission', review => { review.submitted_at = 'unknown'; }],
  ['pending state', review => { review.state = 'PENDING'; }],
  ['unknown body', review => { review.body = 'Synthetic vendor completion claim'; }],
  ['unrepresented change request', review => { review.state = 'CHANGES_REQUESTED'; }],
  ['wrong PR link', review => { review.pull_request_url = 'https://api.github.com/repos/elsewhere/repo/pulls/8'; }],
]) test(`submitted-review completion rejects ${name}`, async () => {
  const f = submittedReviewApi({ mutate: call => {
    if (call.path.endsWith('/reviews')) change(call.data[0]);
    return call.data;
  } });
  const result = await reader(f.fetch).readReview(input());
  assert.notEqual(result.status, 'complete');
});

for (const [name, change] of [
  ['missing App ID', identity => { delete identity.appId; }],
  ['wrong profile', identity => { identity.completion = 'guess-clean'; }],
  ['unreviewed App slug', identity => { identity.appSlug = 'another-app'; }],
  ['extra authority', identity => { identity.allowSilence = true; }],
]) test(`submitted-review rejects invalid configuration: ${name}`, async () => {
  const f = submittedReviewApi(); const run = input(); change(run.qodoIdentities[0]);
  const result = await reader(f.fetch).readReview(run);
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.reason, 'invalid_binding');
  assert.equal(f.calls.length, 0);
});

for (const [name, finding] of [
  ['orphan review', comment({ pull_request_review_id: 99 })],
  ['wrong PR', comment({ pull_request_url: 'https://api.github.com/repos/elsewhere/repo/pulls/8' })],
]) test(`submitted-review cannot ignore a current bot comment with ${name}`, async () => {
  const f = submittedReviewApi({ comments: [finding] });
  const result = await reader(f.fetch).readReview(input());
  assert.notEqual(result.status, 'complete');
});

test('old published reviews wait for a new current-head submission without becoming clean', async () => {
  const f = submittedReviewApi({ mutate: call => {
    if (call.path.endsWith('/reviews')) call.data[0].commit_id = 'b'.repeat(40);
    return call.data;
  } });
  const result = await reader(f.fetch).readReview(input());
  assert.equal(result.status, 'waiting');
  assert.equal(result.reason, 'stale_review');
});

test('submitted-review identity changes during fetch cannot change the authorized snapshot', async () => {
  const run = input();
  const f = submittedReviewApi({ mutate: call => {
    run.qodoIdentities[0].userId = 9;
    return call.data;
  } });
  const result = await reader(f.fetch).readReview(run);
  assert.equal(result.status, 'complete');
  assert.equal(result.reviewId, 81);
});

test('completion never follows truncated or redirected App metadata', async () => {
  const f = submittedReviewApi({ mutate: call => call.path === '/apps/qodo-code-review'
    ? new Response('{}', { headers: { link: '<https://example.com>; rel="next"' } }) : call.data });
  const result = await reader(f.fetch).readReview(input());
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.reason, 'github_read_failed');
});
