import assert from 'node:assert/strict';
import test from 'node:test';
import { createGitHubClient } from '../../src/github.mjs';
import { moderate } from '../../src/moderation.mjs';

const event = {
  action: 'opened', repository: { full_name: 'owner/repo' },
  issue: { number: 7, title: 'Title', body: 'Body', user: { login: 'contributor' } },
};
const getContext = () => ({ eventName: 'issues', repository: 'owner/repo', payload: event });
const getInputs = () => ({});
const classified = {
  protocol_version: 1, outcome: 'classified', robot_score: 0.8,
  detector_revision: 'c'.repeat(40), model_sha256: 'a'.repeat(64), input_sha256: 'b'.repeat(64),
};
const current = { state: 'open', title: 'Title', body: 'Body' };

function apiFixture() {
  const calls = [];
  return {
    calls,
    api: {
      async listComments() { calls.push('comments'); return []; },
      async getItem() { calls.push('state'); return current; },
      async getItemLabels() { calls.push('item-labels'); return []; },
      async createComment({ body }) {
        calls.push('post');
        return { id: 22, body, user: { login: 'github-actions[bot]', type: 'Bot' } };
      },
      async getReviewLabel() { calls.push('label_lookup'); return { exists: true }; },
      async getOutcomeLabel() { return { exists: true }; },
      async createOutcomeLabel() { return { confirmed: true }; },
      async addLabel() { calls.push('label_apply'); return { confirmed: true }; },
      async closeItem() { calls.push('close'); return { state: 'closed' }; },
    },
  };
}

test('PR state uses its pull endpoint and exposes the merged flag', async () => {
  const urls = [];
  const api = createGitHubClient({ token: 'fixture-token', fetchImpl: async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ ...current, merged: true }), { status: 200 });
  } });
  const state = await api.getItem({ repository: 'owner/repo', number: 7, kind: 'pull_request' });
  assert.equal(urls[0], 'https://api.github.com/repos/owner/repo/pulls/7');
  assert.equal(state.merged, true);
});

test('PR closure validates its identity before any authenticated request', async () => {
  let calls = 0;
  const api = createGitHubClient({ token: 'fixture-token', fetchImpl: async () => {
    calls++;
    return new Response('{"state":"closed"}', { status: 200 });
  } });
  await assert.rejects(api.closeItem({ repository: 'owner/repo', number: -1, kind: 'pull_request' }));
  assert.equal(calls, 0);
});

test('created comment confirmation requires the response body that was submitted', async () => {
  const api = createGitHubClient({ token: 'fixture-token', fetchImpl: async () =>
    new Response(JSON.stringify({ id: 22, body: 'different response',
      user: { login: 'github-actions[bot]', type: 'Bot' } }), { status: 201 }) });
  await assert.rejects(api.createComment({ repository: 'owner/repo', number: 7, body: 'expected response' }));
});

test('a scorer exception cannot expose its message through moderation results', async () => {
  const secret = 'PRIVATE_SUBMISSION_FIXTURE';
  const fixture = apiFixture();
  const result = await moderate({ getContext, getInputs, api: fixture.api,
    score: async () => { throw new Error(secret); } });
  assert.equal(result.outcome, 'error');
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.deepEqual(fixture.calls, []);
});

test('text removed entirely by preparation does not load or invoke inference', async () => {
  let calls = 0;
  const fixture = apiFixture();
  const context = () => ({ ...getContext(), payload: { ...event,
    issue: { ...event.issue, title: '```', body: '> quoted text' } } });
  const result = await moderate({ getContext: context, getInputs, api: fixture.api,
    score: async () => { calls++; return classified; } });
  assert.equal(result.outcome, 'empty_input');
  assert.equal(calls, 0);
  assert.deepEqual(fixture.calls, []);
});

test('an empty-input detector outcome cannot carry a fabricated probability', async () => {
  const fixture = apiFixture();
  const result = await moderate({ getContext, getInputs, api: fixture.api,
    score: async () => ({ ...classified, outcome: 'empty_input' }) });
  assert.equal(result.outcome, 'error');
  assert.deepEqual(fixture.calls, []);
});

for (const phase of ['pre-close state', 'close request']) {
  test(`a ${phase} failure preserves confirmed comment and classification metadata`, async () => {
    const fixture = apiFixture();
    let reads = 0;
    fixture.api.getItem = async () => {
      fixture.calls.push('state');
      reads++;
      if (phase === 'pre-close state' && reads === 2) throw new Error('PRIVATE_API_FIXTURE');
      return current;
    };
    if (phase === 'close request') fixture.api.closeItem = async () => {
      fixture.calls.push('close');
      throw new Error('PRIVATE_API_FIXTURE');
    };
    const result = await moderate({ getContext, getInputs, api: fixture.api,
      score: async () => classified });
    assert.equal(result.outcome, 'error');
    assert.equal(result.partial, true);
    assert.equal(result.comment_id, 22);
    assert.equal(result.score, 0.8);
    assert.equal(result.input_sha256, classified.input_sha256);
    assert.ok(!JSON.stringify(result).includes('PRIVATE_API_FIXTURE'));
    if (phase === 'pre-close state') assert.ok(!fixture.calls.includes('close'));
    if (phase === 'close request') {
      assert.ok(fixture.calls.indexOf('label_apply') < fixture.calls.lastIndexOf('state'));
      assert.ok(fixture.calls.indexOf('close') > fixture.calls.lastIndexOf('state'));
    }
  });
}
