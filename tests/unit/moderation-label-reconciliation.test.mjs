import assert from 'node:assert/strict';
import test from 'node:test';
import { moderate } from '../../src/moderation.mjs';

const hash = 'a'.repeat(64);
const inputHash = 'b'.repeat(64);
const revision = 'c'.repeat(40);
const marker = `<!-- mellon-submission-moderation-v1 repo=o/r item=4 input=${inputHash} detector=${revision} model=${hash} -->`;
const context = () => ({ eventName: 'issues', repository: 'o/r', payload: {
  action: 'opened', repository: { full_name: 'o/r' },
  issue: { number: 4, title: 'Original title', body: 'Original body', user: { login: 'contributor' } },
} });
const inputs = mode => () => ({ mode, autoClose: 'true' });
const classification = { protocol_version: 1, outcome: 'classified', robot_score: 0.9,
  detector_revision: revision, model_sha256: hash, input_sha256: inputHash };

function fixture({ mode = 'enforce', states, labelExists = false } = {}) {
  const calls = [];
  const itemStates = [...(states ?? [])];
  const api = {
    async listComments() { calls.push('comments'); return []; },
    async getItem() {
      calls.push('state');
      return itemStates.length ? itemStates.shift() : { state: 'open', title: 'Original title', body: 'Original body' };
    },
    async createComment({ body }) { calls.push('comment'); return { id: 51, body, user: { login: 'github-actions[bot]', type: 'Bot' } }; },
    async getReviewLabel() { calls.push('lookup'); return { exists: labelExists }; },
    async createReviewLabel() { calls.push('create-label'); },
    async addLabel() { calls.push('apply-label'); },
    async closeItem() { calls.push('close'); },
  };
  return {
    calls, api,
    run: () => moderate({ getContext: context, getInputs: inputs(mode), api,
      score: async () => classification }),
  };
}

test('label creation race is reconciled before application in both modes', async () => {
  for (const mode of ['observe', 'enforce']) {
    const stateReads = mode === 'observe' ? [
      { state: 'open', title: 'Original title', body: 'Original body' },
      { state: 'open', title: 'Original title', body: 'Original body' },
      { state: 'open', title: 'Original title', body: 'Original body' },
    ] : [
      { state: 'open', title: 'Original title', body: 'Original body' },
      { state: 'open', title: 'Original title', body: 'Original body' },
      { state: 'open', title: 'Original title', body: 'Original body' },
      { state: 'open', title: 'Original title', body: 'Original body' },
    ];
    const f = fixture({ mode, states: stateReads });
    f.api.createReviewLabel = async () => { f.calls.push('create-label'); throw new Error('422 race'); };
    f.api.getReviewLabel = async () => {
      f.calls.push('lookup');
      return { exists: f.calls.filter(call => call === 'lookup').length > 1 };
    };
    const outcome = await f.run();
    assert.equal(outcome.outcome, mode === 'observe' ? 'flagged' : 'closed');
    assert.ok(f.calls.indexOf('lookup', f.calls.indexOf('create-label')) > f.calls.indexOf('create-label'));
    assert.ok(f.calls.includes('apply-label'));
    assert.ok(mode !== 'enforce' || f.calls.indexOf('apply-label') < f.calls.indexOf('close'));
  }
});

test('uncertain label creation is confirmed by lookup before any label application', async () => {
  const f = fixture({ mode: 'enforce' });
  f.api.createReviewLabel = async () => { f.calls.push('create-label'); throw new Error('timeout token detail'); };
  let lookups = 0;
  f.api.getReviewLabel = async () => { f.calls.push('lookup'); return { exists: ++lookups === 2 }; };
  const outcome = await f.run();
  assert.equal(outcome.outcome, 'closed');
  assert.equal(f.calls.filter(call => call === 'create-label').length, 1);
  assert.equal(f.calls.filter(call => call === 'apply-label').length, 1);
  assert.ok(f.calls.indexOf('apply-label') < f.calls.indexOf('close'));
});

test('uncertain label application reconciles current labels and avoids repeating writes', async () => {
  const f = fixture({ mode: 'enforce', labelExists: true });
  f.api.addLabel = async () => { f.calls.push('apply-label'); throw new Error('write timeout secret'); };
  f.api.getItem = async () => {
    f.calls.push('state');
    return { state: 'open', title: 'Original title', body: 'Original body' };
  };
  f.api.getItemLabels = async () => { f.calls.push('labels'); return [{ name: 'mellon: review' }]; };
  const outcome = await f.run();
  assert.equal(outcome.outcome, 'closed');
  assert.equal(f.calls.filter(call => call === 'apply-label').length, 1);
  assert.ok(f.calls.indexOf('labels') > f.calls.indexOf('apply-label'));
  assert.ok(f.calls.indexOf('close') > f.calls.indexOf('labels'));
});

test('failed label reconciliation preserves confirmed response metadata and prevents closure', async () => {
  const f = fixture({ mode: 'enforce', labelExists: true });
  f.api.addLabel = async () => { f.calls.push('apply-label'); throw new Error('uncertain private error'); };
  f.api.getLabels = async () => { f.calls.push('labels'); throw new Error('private response'); };
  const outcome = await f.run();
  assert.equal(outcome.outcome, 'error');
  assert.equal(outcome.partial, true);
  assert.equal(outcome.comment_id, 51);
  assert.equal(outcome.score, 0.9);
  assert.equal(outcome.detector_revision, revision);
  assert.equal(outcome.model_sha256, hash);
  assert.equal(outcome.input_sha256, inputHash);
  assert.equal(JSON.stringify(outcome).includes('private response'), false);
  assert.equal(f.calls.includes('close'), false);
  assert.equal(f.calls.filter(call => call === 'apply-label').length, 1);
});

test('changed or closed items stop labeling and closure while retaining confirmed response', async () => {
  for (const changed of [
    { state: 'open', title: 'Changed title', body: 'Original body' },
    { state: 'closed', title: 'Original title', body: 'Original body' },
  ]) {
    const f = fixture({ mode: 'enforce', states: [
      { state: 'open', title: 'Original title', body: 'Original body' },
      changed,
    ], labelExists: true });
    const outcome = await f.run();
    assert.equal(outcome.outcome, 'skipped');
    assert.equal(outcome.partial, true);
    assert.equal(outcome.comment_id, 51);
    assert.equal(f.calls.includes('apply-label'), false);
    assert.equal(f.calls.includes('close'), false);
  }
});

test('label response metadata excludes arbitrary GitHub fields and submission data', async () => {
  const f = fixture({ mode: 'observe' });
  f.api.getReviewLabel = async () => ({ exists: false, body: 'PRIVATE_RESPONSE_TEXT', token: 'PRIVATE_TOKEN' });
  f.api.createReviewLabel = async () => ({ confirmed: true, id: 99, private: 'PRIVATE_RESPONSE_TEXT' });
  f.api.addLabel = async () => ({ confirmed: true, name: 'mellon: review', private: 'PRIVATE_RESPONSE_TEXT' });
  const outcome = await f.run();
  assert.equal(outcome.outcome, 'flagged');
  assert.equal(JSON.stringify(outcome).includes('PRIVATE_RESPONSE_TEXT'), false);
  assert.equal(JSON.stringify(outcome).includes('PRIVATE_TOKEN'), false);
});
