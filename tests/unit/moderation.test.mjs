import test from 'node:test';
import assert from 'node:assert/strict';
import { moderate } from '../../src/moderation.mjs';

const hash = 'a'.repeat(64);
const inputHash = 'b'.repeat(64);
const revision = 'c'.repeat(40);
const event = { action: 'opened', repository: { full_name: 'o/r' }, issue: { number: 4, title: 'Title', body: 'Body', user: { login: 'contributor' } } };
function result(score) {
  return { protocol_version: 1, outcome: 'classified', robot_score: score, detector_revision: revision, model_sha256: hash, input_sha256: inputHash };
}
function setup(scoreValue = 0.8, options = {}) {
  const calls = [];
  const api = {
    async listComments() { calls.push('comments'); return options.comments ?? []; },
    async getItem() { calls.push('state'); return options.states?.shift() ?? { state: 'open', title: 'Title', body: 'Body' }; },
    async getItemLabels() { calls.push('item-labels'); return options.labels ?? []; },
    async createComment({ body }) { calls.push('post'); return { id: 22, body, user: { login: 'github-actions[bot]', type: 'Bot' } }; },
    async closeItem() { calls.push('close'); },
    async getOutcomeLabel() { return { exists: true }; },
    async createOutcomeLabel() { return { confirmed: true }; },
  };
  let scored = 0;
  return { calls, api, get scored() { return scored; }, score: async ({ protocol_version, text }) => { scored++; assert.equal(protocol_version, 1); assert.equal(text, 'Title\n\nBody'); return result(scoreValue); } };
}
const getContext = () => ({ eventName: 'issues', repository: 'o/r', payload: event });
const getInputs = () => ({});
const responseOnlyInputs = () => ({ autoClose: 'false' });
const responseOnlyInputsWithMode = () => ({ mode: 'enforce', autoClose: 'false' });
const observeInputs = () => ({ mode: 'observe' });
const observeWithoutLabelInputs = () => ({ mode: 'observe', reviewLabel: 'false' });
const marker = `<!-- mellon-submission-moderation-v1 repo=o/r item=4 input=${inputHash} detector=${revision} model=${hash} -->`;

test('enforce mode applies enabled review labels after responses for issues and pull requests', async () => {
  for (const [eventName, itemKey] of [
    ['issues', 'issue'],
    ['pull_request_target', 'pull_request'],
  ]) {
    for (const autoClose of ['true', 'false']) {
      const fixture = setup();
      fixture.api.getReviewLabel = async () => { fixture.calls.push('label_lookup'); return { exists: false }; };
      fixture.api.createReviewLabel = async () => { fixture.calls.push('label_create'); return { confirmed: true }; };
      fixture.api.addLabel = async () => { fixture.calls.push('label_apply'); return { confirmed: true }; };
      const context = { eventName, repository: 'o/r', payload: {
        action: 'opened', repository: { full_name: 'o/r' },
        [itemKey]: { number: 4, title: 'Title', body: 'Body', user: { login: 'contributor' } },
      } };
      const outcome = await moderate({ getContext: () => context,
        getInputs: () => ({ autoClose, reviewLabel: 'true' }), api: fixture.api, score: fixture.score });
      assert.equal(outcome.outcome, autoClose === 'true' ? 'closed' : 'commented');
      assert.equal(outcome.comment_id, 22);
      assert.equal(outcome.partial, false);
      assert.deepEqual(fixture.calls, autoClose === 'true'
        ? ['comments', 'state', 'post', 'state', 'item-labels', 'label_lookup', 'state', 'item-labels', 'label_create',
          'state', 'item-labels', 'label_apply', 'state', 'item-labels', 'close']
        : ['comments', 'state', 'post', 'state', 'item-labels', 'label_lookup', 'state', 'item-labels', 'label_create',
          'state', 'item-labels', 'label_apply', 'state']);
    }
  }
});

test('enforce mode skips disabled labels and reuses genuine responses for issues and pull requests', async () => {
  for (const [eventName, itemKey] of [
    ['issues', 'issue'],
    ['pull_request_target', 'pull_request'],
  ]) {
    for (const autoClose of ['true', 'false']) {
      const fixture = setup(0.8, { comments: [{ id: 3, body: marker,
        user: { login: 'github-actions[bot]', type: 'Bot' } }] });
      fixture.api.getReviewLabel = async () => { fixture.calls.push('label_lookup'); return { exists: true }; };
      fixture.api.createReviewLabel = async () => { fixture.calls.push('label_create'); return { confirmed: true }; };
      fixture.api.addLabel = async () => { fixture.calls.push('label_apply'); return { confirmed: true }; };
      const context = { eventName, repository: 'o/r', payload: {
        action: 'opened', repository: { full_name: 'o/r' },
        [itemKey]: { number: 4, title: 'Title', body: 'Body', user: { login: 'contributor' } },
      } };
      const outcome = await moderate({ getContext: () => context,
        getInputs: () => ({ autoClose, reviewLabel: 'false' }), api: fixture.api, score: fixture.score });
      assert.equal(outcome.outcome, autoClose === 'true' ? 'closed' : 'commented');
      assert.equal(outcome.comment_id, 3);
      assert.equal(fixture.calls.includes('label_lookup'), false);
      assert.equal(fixture.calls.includes('label_apply'), false);
      assert.deepEqual(fixture.calls, autoClose === 'true'
        ? ['comments', 'state', 'item-labels', 'close']
        : ['comments', 'state']);
    }
  }
});

test('enforce mode defaults labeling on for existing Action input fixtures', async () => {
  const fixture = setup();
  fixture.api.getReviewLabel = async () => { fixture.calls.push('label_lookup'); return { exists: false }; };
  fixture.api.createReviewLabel = async () => { fixture.calls.push('label_create'); return { confirmed: true }; };
  fixture.api.addLabel = async () => { fixture.calls.push('label_apply'); return { confirmed: true }; };
  const outcome = await moderate({ getContext, getInputs, api: fixture.api, score: fixture.score });
  assert.equal(outcome.outcome, 'closed');
  assert.deepEqual(fixture.calls, ['comments', 'state', 'post', 'state', 'item-labels', 'label_lookup', 'state', 'item-labels',
    'label_create', 'state', 'item-labels', 'label_apply', 'state', 'item-labels', 'close']);
});

test('response-only mode confirms issue and pull request responses without closing', async () => {
  for (const [eventName, kind, itemKey] of [
    ['issues', 'issue', 'issue'],
    ['pull_request_target', 'pull_request', 'pull_request'],
  ]) {
    const fixture = setup();
    fixture.api.getReviewLabel = async () => { fixture.calls.push('label_lookup'); return { exists: true }; };
    fixture.api.addLabel = async () => { fixture.calls.push('label_apply'); return { confirmed: true }; };
    const context = { eventName, repository: 'o/r', payload: {
      action: 'opened', repository: { full_name: 'o/r' },
      [itemKey]: { number: 4, title: 'Title', body: 'Body', user: { login: 'contributor' } },
    } };
    const outcome = await moderate({ getContext: () => context, getInputs: responseOnlyInputs,
      api: fixture.api, score: fixture.score });
    assert.equal(outcome.outcome, 'commented');
    assert.equal(outcome.comment_id, 22);
    assert.equal(outcome.partial, false);
    assert.deepEqual(fixture.calls, ['comments', 'state', 'post', 'state', 'item-labels', 'label_lookup', 'state',
      'item-labels', 'label_apply', 'state']);
  }
});

test('response-only mode defaults to existing closure behavior unless explicitly disabled', async () => {
  const fixture = setup();
  fixture.api.getReviewLabel = async () => { fixture.calls.push('label_lookup'); return { exists: true }; };
  fixture.api.addLabel = async () => { fixture.calls.push('label_apply'); return { confirmed: true }; };
  const outcome = await moderate({ getContext, getInputs: () => ({ reviewLabel: 'false' }), api: fixture.api, score: fixture.score });
  assert.equal(outcome.outcome, 'closed');
  assert.deepEqual(fixture.calls, ['comments', 'state', 'post', 'state', 'item-labels', 'close']);
});

test('uses real classifier result and enforces inclusive unrounded cutoff', async () => {
  for (const [value, expected] of [[0.6, 'below_cutoff'], [0.799999, 'below_cutoff'], [0.8, 'closed'], [0.800001, 'closed']]) {
    const fixture = setup(value);
    fixture.api.getReviewLabel = async () => { fixture.calls.push('label_lookup'); return { exists: true }; };
    fixture.api.addLabel = async () => { fixture.calls.push('label_apply'); return { confirmed: true }; };
    const outcome = await moderate({ getContext, getInputs: () => ({ reviewLabel: 'false' }), api: fixture.api, score: fixture.score });
    assert.equal(outcome.outcome, expected);
    assert.equal(fixture.scored, 1);
    assert.equal(fixture.calls.includes('post'), expected === 'closed');
  }
});

test('observe mode skips all GitHub calls when review labeling is disabled', async () => {
  const fixture = setup(0.8);
  const outcome = await moderate({ getContext, getInputs: observeWithoutLabelInputs, api: fixture.api, score: fixture.score });
  assert.equal(outcome.outcome, 'flagged');
  assert.equal(outcome.label, undefined);
  assert.equal(outcome.score, 0.8);
  assert.deepEqual(fixture.calls, []);
});

test('observe mode flags at the inclusive cutoff using only state checks and label operations for an issue', async () => {
  const fixture = setup(0.8);
  fixture.api.getReviewLabel = async () => { fixture.calls.push('label_lookup'); return { exists: false }; };
  fixture.api.createReviewLabel = async () => { fixture.calls.push('label_create'); return { confirmed: true }; };
  fixture.api.addLabel = async () => { fixture.calls.push('label_apply'); return { confirmed: true }; };
  const outcome = await moderate({ getContext, getInputs: observeInputs, api: fixture.api, score: fixture.score });
  assert.equal(outcome.outcome, 'flagged');
  assert.equal(outcome.score, 0.8);
  assert.deepEqual(fixture.calls, ['state', 'item-labels', 'label_lookup', 'state', 'item-labels', 'label_create',
    'state', 'item-labels', 'label_apply']);
});

test('observe mode flags pull requests through issue-label operations', async () => {
  const calls = [];
  const context = { eventName: 'pull_request_target', repository: 'o/r', payload: {
    action: 'opened', repository: { full_name: 'o/r' }, pull_request: { number: 4, title: 'Title', body: 'Body', user: { login: 'contributor' } },
  } };
  const api = {
    async getItem() { calls.push('state'); return { state: 'open', title: 'Title', body: 'Body', merged: false }; },
    async getItemLabels() { calls.push('item-labels'); return []; },
    async getReviewLabel() { calls.push('label_lookup'); return { exists: true }; },
    async createReviewLabel() { calls.push('label_create'); return { confirmed: true }; },
    async getOutcomeLabel() { return { exists: true }; },
    async createOutcomeLabel() { return { confirmed: true }; },
    async addLabel(item) { calls.push(`label_apply:${item.kind}`); return { confirmed: true }; },
  };
  const outcome = await moderate({ getContext: () => context, getInputs: observeInputs, api, score: async () => result(0.85) });
  assert.equal(outcome.outcome, 'flagged');
  assert.deepEqual(calls, ['state', 'item-labels', 'label_lookup', 'state', 'item-labels', 'label_apply:pull_request']);
});

test('observe mode does not mask a definite label creation failure', async () => {
  const fixture = setup(0.9);
  fixture.api.getReviewLabel = async () => { fixture.calls.push('label_lookup'); return { exists: false }; };
  fixture.api.createReviewLabel = async () => { fixture.calls.push('label_create'); const error = new Error('safe API failure'); error.status = 403; throw error; };
  fixture.api.addLabel = async () => { fixture.calls.push('label_apply'); return { confirmed: true }; };
  const outcome = await moderate({ getContext, getInputs: observeInputs, api: fixture.api, score: fixture.score });
  assert.equal(outcome.outcome, 'error');
  assert.deepEqual(fixture.calls, ['state', 'item-labels', 'label_lookup', 'state', 'item-labels', 'label_create', 'label_lookup']);
});

test('observe mode reuses existing label and skips stale state without any label write', async () => {
  const existing = setup(0.9);
  existing.api.getReviewLabel = async () => { existing.calls.push('label_lookup'); return { exists: true }; };
  existing.api.createReviewLabel = async () => { existing.calls.push('label_create'); };
  existing.api.addLabel = async () => { existing.calls.push('label_apply'); return { confirmed: true }; };
  const observed = await moderate({ getContext, getInputs: observeInputs, api: existing.api, score: existing.score });
  assert.equal(observed.outcome, 'flagged');
  assert.deepEqual(existing.calls, ['state', 'item-labels', 'label_lookup', 'state', 'item-labels', 'label_apply']);
  const stale = setup(0.9, { states: [{ state: 'closed', title: 'Title', body: 'Body' }] });
  stale.api.getReviewLabel = async () => { stale.calls.push('label_lookup'); return { exists: false }; };
  stale.api.createReviewLabel = async () => { stale.calls.push('label_create'); return { confirmed: true }; };
  stale.api.addLabel = async () => { stale.calls.push('label_apply'); return { confirmed: true }; };
  assert.equal((await moderate({ getContext, getInputs: observeInputs, api: stale.api, score: stale.score })).outcome, 'skipped');
  assert.deepEqual(stale.calls, ['state']);
});

test('observe mode below cutoff does not read or write GitHub and enforce default remains unchanged', async () => {
  const below = setup(0.799999);
  assert.equal((await moderate({ getContext, getInputs: observeInputs, api: below.api, score: below.score })).outcome, 'below_cutoff');
  assert.deepEqual(below.calls, []);
  const enforce = setup(0.8);
  enforce.api.getReviewLabel = async () => { enforce.calls.push('label_lookup'); return { exists: true }; };
  enforce.api.addLabel = async () => { enforce.calls.push('label_apply'); };
  assert.equal((await moderate({ getContext, getInputs: () => ({ reviewLabel: 'false' }), api: enforce.api, score: enforce.score })).outcome, 'closed');
  assert.deepEqual(enforce.calls, ['comments', 'state', 'post', 'state', 'item-labels', 'close']);
});

test('reuses genuine matching response only in response-only mode', async () => {
  const fixture = setup(0.8, { comments: [{ id: 3, body: marker, user: { login: 'github-actions[bot]', type: 'Bot' } }] });
  fixture.api.getReviewLabel = async () => { fixture.calls.push('label_lookup'); return { exists: true }; };
  fixture.api.addLabel = async () => { fixture.calls.push('label_apply'); return { confirmed: true }; };
  const outcome = await moderate({ getContext, getInputs: responseOnlyInputs, api: fixture.api, score: fixture.score });
  assert.equal(outcome.outcome, 'commented');
  assert.equal(outcome.comment_id, 3);
  assert.deepEqual(fixture.calls, ['comments', 'state', 'item-labels', 'label_lookup', 'state', 'item-labels',
    'label_apply', 'state']);
});

test('response-only rerun retains confirmed response when state read fails', async () => {
  const fixture = setup(0.8, { comments: [{ id: 3, body: marker, user: { login: 'github-actions[bot]', type: 'Bot' } }] });
  fixture.api.getItem = async () => { fixture.calls.push('state'); throw new Error('private API detail'); };
  const outcome = await moderate({ getContext, getInputs: responseOnlyInputs, api: fixture.api, score: fixture.score });
  assert.equal(outcome.outcome, 'error');
  assert.equal(outcome.partial, true);
  assert.equal(outcome.comment_id, 3);
  assert.equal(outcome.score, 0.8);
  assert.equal(outcome.detector_revision, revision);
  assert.equal(outcome.model_sha256, hash);
  assert.equal(outcome.input_sha256, inputHash);
  assert.equal(JSON.stringify(outcome).includes('private API detail'), false);
  assert.deepEqual(fixture.calls, ['comments', 'state']);
});

test('spoofed matching markers from contributors never count as genuine response', async () => {
  const fixture = setup(0.8, { comments: [{ id: 3, body: marker, user: { login: 'contributor', type: 'User' } }] });
  fixture.api.getReviewLabel = async () => { fixture.calls.push('label_lookup'); return { exists: true }; };
  fixture.api.addLabel = async () => { fixture.calls.push('label_apply'); return { confirmed: true }; };
  const outcome = await moderate({ getContext, getInputs: responseOnlyInputs, api: fixture.api, score: fixture.score });
  assert.equal(outcome.outcome, 'commented');
  assert.equal(outcome.comment_id, 22);
  assert.deepEqual(fixture.calls, ['comments', 'state', 'post', 'state', 'item-labels', 'label_lookup', 'state',
    'item-labels', 'label_apply', 'state']);
});

test('reuses only a genuine bot comment and checks state before response and closure', async () => {
  const fixture = setup(0.8, { comments: [{ id: 3, body: `spoof ${marker}`, user: { login: 'contributor', type: 'User' } }] });
  fixture.api.getReviewLabel = async () => { fixture.calls.push('label_lookup'); return { exists: true }; };
  fixture.api.addLabel = async () => { fixture.calls.push('label_apply'); return { confirmed: true }; };
  const outcome = await moderate({ getContext, getInputs, api: fixture.api, score: fixture.score });
  assert.equal(outcome.outcome, 'closed');
  assert.deepEqual(fixture.calls, ['comments', 'state', 'post', 'state', 'item-labels', 'label_lookup', 'state',
    'item-labels', 'label_apply', 'state', 'item-labels', 'close']);
});

test('changed current state prevents response and post-response change reports partial skip', async () => {
  const changed = setup(0.8, { states: [{ state: 'open', title: 'changed', body: 'Body' }] });
  assert.equal((await moderate({ getContext, getInputs, api: changed.api, score: changed.score })).outcome, 'skipped');
  assert.deepEqual(changed.calls, ['comments', 'state']);
  const later = setup(0.8, { states: [{ state: 'open', title: 'Title', body: 'Body' }, { state: 'closed', title: 'Title', body: 'Body' }] });
  const outcome = await moderate({ getContext, getInputs, api: later.api, score: later.score });
  assert.equal(outcome.outcome, 'skipped');
  assert.equal(outcome.partial, true);
  assert.equal(later.calls.includes('close'), false);
});

test('invalid score metadata never causes API access and classifier remains lazy for skipped inputs', async () => {
  const fixture = setup(0.9);
  for (const invalid of [
    { ...result(NaN) }, { ...result(Infinity) }, { ...result(-0.1) }, { ...result(1.1) },
    { ...result(0.9), detector_revision: 'rev-1' }, { ...result(0.9), model_sha256: undefined },
    { ...result(0.9), input_sha256: undefined }, { ...result(0.9), protocol_version: 2 },
  ]) {
    fixture.score = async () => invalid;
    assert.equal((await moderate({ getContext, getInputs, api: fixture.api, score: fixture.score })).outcome, 'error');
  }
  assert.deepEqual(fixture.calls, []);
  let calls = 0;
  const unsupported = await moderate({ getContext: () => ({ eventName: 'issues', repository: 'o/r', payload: { action: 'closed' } }), getInputs, api: fixture.api, score: async () => { calls++; } });
  assert.equal(unsupported.outcome, 'skipped');
  assert.equal(calls, 0);
});

test('empty input is reported without API calls and requires real provenance', async () => {
  const fixture = setup();
  fixture.score = async () => ({ protocol_version: 1, outcome: 'empty_input', detector_revision: revision, model_sha256: hash, input_sha256: inputHash });
  const outcome = await moderate({ getContext, getInputs, api: fixture.api, score: fixture.score });
  assert.equal(outcome.outcome, 'empty_input');
  assert.deepEqual(fixture.calls, []);
});

test('uncertain response-only write reconciles once and does not blindly repost or close', async () => {
  const fixture = setup();
  fixture.api.getReviewLabel = async () => { fixture.calls.push('label_lookup'); return { exists: true }; };
  fixture.api.addLabel = async () => { fixture.calls.push('label_apply'); return { confirmed: true }; };
  let listings = 0;
  fixture.api.listComments = async () => { listings++; return listings === 1 ? [] : [{ id: 22, body: marker, user: { login: 'github-actions[bot]', type: 'Bot' } }]; };
  fixture.api.createComment = async () => { fixture.calls.push('post'); throw new Error('timeout secret'); };
  const outcome = await moderate({ getContext, getInputs: responseOnlyInputs, api: fixture.api, score: fixture.score });
  assert.equal(outcome.outcome, 'commented');
  assert.equal(outcome.comment_id, 22);
  assert.equal(fixture.calls.filter((call) => call === 'post').length, 1);
  assert.equal(fixture.calls.includes('close'), false);
  assert.equal(listings, 2);
});

test('uncertain response-only write that cannot be confirmed fails without closing', async () => {
  const fixture = setup();
  fixture.api.createComment = async () => { fixture.calls.push('post'); throw new Error('timeout secret'); };
  const outcome = await moderate({ getContext, getInputs: responseOnlyInputs, api: fixture.api, score: fixture.score });
  assert.equal(outcome.outcome, 'error');
  assert.equal(outcome.uncertainty, true);
  assert.equal(fixture.calls.filter((call) => call === 'post').length, 1);
  assert.equal(fixture.calls.includes('close'), false);
});

test('response-only stale submissions do not post and state changes after response do not close', async () => {
  const before = setup(0.8, { states: [{ state: 'open', title: 'changed', body: 'Body' }] });
  const skippedBefore = await moderate({ getContext, getInputs: responseOnlyInputsWithMode, api: before.api, score: before.score });
  assert.equal(skippedBefore.outcome, 'skipped');
  assert.deepEqual(before.calls, ['comments', 'state']);

  const after = setup(0.8, { states: [{ state: 'open', title: 'Title', body: 'Body' },
    { state: 'closed', title: 'Title', body: 'Body' }] });
  const skippedAfter = await moderate({ getContext, getInputs: responseOnlyInputsWithMode, api: after.api, score: after.score });
  assert.equal(skippedAfter.outcome, 'skipped');
  assert.equal(skippedAfter.partial, true);
  assert.deepEqual(after.calls, ['comments', 'state', 'post', 'state']);
});

test('response-only mode leaves observe mode label-only and never posts or closes', async () => {
  const fixture = setup(0.9);
  fixture.api.getReviewLabel = async () => { fixture.calls.push('label_lookup'); return { exists: true }; };
  fixture.api.addLabel = async () => { fixture.calls.push('label_apply'); return { confirmed: true }; };
  const outcome = await moderate({ getContext, getInputs: () => ({ mode: 'observe', autoClose: 'false' }),
    api: fixture.api, score: fixture.score });
  assert.equal(outcome.outcome, 'flagged');
  assert.deepEqual(fixture.calls, ['state', 'item-labels', 'label_lookup', 'state', 'item-labels', 'label_apply']);
});

test('failed reconciliation and close failures are safe partial errors', async () => {
  const fixture = setup();
  fixture.api.createComment = async () => { throw new Error('token leaked'); };
  fixture.api.listComments = async () => { if (fixture.calls.filter((call) => call === 'comments').length > 1) throw new Error('raw'); return []; };
  const uncertain = await moderate({ getContext, getInputs, api: fixture.api, score: fixture.score });
  assert.equal(uncertain.outcome, 'error');
  assert.equal(uncertain.uncertainty, true);
  assert.equal(fixture.calls.includes('close'), false);
  const closeFailure = setup();
  closeFailure.api.getReviewLabel = async () => { closeFailure.calls.push('label_lookup'); return { exists: true }; };
  closeFailure.api.addLabel = async () => { closeFailure.calls.push('label_apply'); return { confirmed: true }; };
  closeFailure.api.closeItem = async () => { closeFailure.calls.push('close'); throw new Error('raw token'); };
  const partial = await moderate({ getContext, getInputs, api: closeFailure.api, score: closeFailure.score });
  assert.equal(partial.outcome, 'error');
  assert.equal(partial.partial, true);
  assert.equal(partial.error.includes('raw token'), false);
  assert.ok(closeFailure.calls.indexOf('label_apply') < closeFailure.calls.lastIndexOf('state'));
  assert.ok(closeFailure.calls.indexOf('close') > closeFailure.calls.lastIndexOf('state'));
});
