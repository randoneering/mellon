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
    async getItemLabels() { calls.push('item-labels'); return []; },
    async createComment({ body }) { calls.push('comment'); return { id: 51, body, user: { login: 'github-actions[bot]', type: 'Bot' } }; },
    async getReviewLabel() { calls.push('lookup'); return { exists: labelExists }; },
    async createReviewLabel() { calls.push('create-label'); return { confirmed: true }; },
    async getOutcomeLabel() { return { exists: true }; },
    async createOutcomeLabel() { return { confirmed: true }; },
    async addLabel() { calls.push('apply-label'); return { confirmed: true }; },
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

test('5xx label creation retries only after absent-state confirmation', async () => {
  const f = fixture({ mode: 'observe' });
  let writes = 0;
  let reads = 0;
  f.api.createReviewLabel = async () => {
    f.calls.push('create-label');
    if (++writes === 1) { const error = new Error('private 503'); error.status = 503; throw error; }
    return { confirmed: true };
  };
  f.api.getReviewLabel = async () => { f.calls.push('lookup'); return { exists: ++reads > 2 }; };
  const result = await f.run();
  assert.equal(result.outcome, 'flagged');
  assert.equal(writes, 2);
  assert.deepEqual(f.calls.filter(call => ['create-label', 'lookup'].includes(call)),
    ['lookup', 'create-label', 'lookup', 'create-label']);
  assert.equal(JSON.stringify(result).includes('private 503'), false);
});

test('label creation does not retry after the submission becomes stale', async () => {
  const f = fixture({ mode: 'observe' });
  let writes = 0;
  let states = 0;
  f.api.getItem = async () => ++states < 3
    ? { state: 'open', title: 'Original title', body: 'Original body' }
    : { state: 'closed', title: 'Original title', body: 'Original body' };
  f.api.createReviewLabel = async () => { writes++; throw new Error('uncertain'); };
  const result = await f.run();
  assert.equal(result.outcome, 'skipped');
  assert.equal(writes, 1);
});

test('already-present, failed-read, definite 4xx, and stale states never retry label writes', async () => {
  for (const scenario of ['present', 'read-failure', '4xx', 'stale']) {
    const f = fixture({ mode: 'observe', labelExists: scenario === 'present' || scenario === 'stale' });
    let writes = 0;
    const failWrite = async () => {
      writes++;
      const error = new Error('private write failure');
      if (scenario === '4xx') error.status = 403;
      if (scenario === 'stale') error.status = 503;
      throw error;
    };
    f.api.createReviewLabel = scenario === 'stale' ? async () => ({ confirmed: true }) : failWrite;
    f.api.addLabel = scenario === 'stale' ? failWrite : async () => ({ confirmed: true });
    f.api.getItemLabels = async () => [];
    let lookups = 0;
    f.api.getReviewLabel = async () => {
      lookups++;
      if (scenario === 'read-failure') throw new Error('private read failure');
      return { exists: scenario === 'present' };
    };
    if (scenario === 'stale') {
      let states = 0;
      f.api.getItem = async () => {
        f.calls.push('state');
        return ++states < 4 ? { state: 'open', title: 'Original title', body: 'Original body' }
          : { state: 'closed', title: 'Original title', body: 'Original body' };
      };
    }
    const result = await f.run();
    assert.equal(writes, ['present', 'read-failure'].includes(scenario) ? 0 : 1, scenario);
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
});

test('5xx label application retries after complete paginated state confirms absence', async () => {
  const f = fixture({ mode: 'enforce', labelExists: true });
  let writes = 0;
  let reads = 0;
  f.api.addLabel = async () => {
    f.calls.push('apply-label');
    if (++writes === 1) { const error = new Error('private 503'); error.status = 503; throw error; }
    return { confirmed: true };
  };
  f.api.getItemLabels = async () => {
    f.calls.push('labels');
    reads++;
    return [];
  };
  const result = await f.run();
  assert.equal(result.outcome, 'closed');
  assert.equal(writes, 2);
  assert.deepEqual(f.calls.filter(call => ['apply-label', 'labels'].includes(call)),
    ['labels', 'labels', 'apply-label', 'labels', 'labels', 'apply-label', 'labels']);
});

test('issue-label write does not retry after uncertain state read or definite 4xx', async () => {
  for (const failure of ['read', '4xx']) {
    const f = fixture({ mode: 'enforce', labelExists: true });
    let writes = 0;
    f.api.addLabel = async () => {
      writes++;
      const error = new Error('private write failure');
      if (failure === '4xx') error.status = 403;
      throw error;
    };
    f.api.getItemLabels = async () => {
      if (failure === 'read') throw new Error('private state read failure');
      return [];
    };
    const result = await f.run();
    assert.equal(result.outcome, 'error');
    assert.equal(writes, failure === 'read' ? 0 : 1);
    assert.equal(f.calls.includes('close'), false);
    assert.equal(JSON.stringify(result).includes('private'), false);
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

test('label creation and application without confirmation cannot close', async () => {
  for (const operation of ['createReviewLabel', 'addLabel']) {
    const f = fixture({ mode: 'enforce' });
    f.api.getItemLabels = async () => { f.calls.push('labels'); return []; };
    f.api[operation] = async () => { f.calls.push(operation); return undefined; };
    const outcome = await f.run();
    assert.equal(outcome.outcome, 'error');
    assert.equal(outcome.partial, true);
    assert.equal(outcome.comment_id, 51);
    assert.equal(f.calls.includes('close'), false);
    assert.equal(JSON.stringify(outcome).includes('PRIVATE'), false);
  }
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
  assert.ok(f.calls.lastIndexOf('labels') > f.calls.indexOf('apply-label'));
  assert.ok(f.calls.indexOf('close') > f.calls.lastIndexOf('labels'));
});

test('failed label reconciliation preserves confirmed response metadata and prevents closure', async () => {
  const f = fixture({ mode: 'enforce', labelExists: true });
  f.api.addLabel = async () => { f.calls.push('apply-label'); throw new Error('uncertain private error'); };
  let labelReads = 0;
  f.api.getItemLabels = async () => {
    f.calls.push('labels');
    if (++labelReads === 3) throw new Error('private response');
    return [];
  };
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

test('stale-before-label outcomes preserve response provenance without private output', async () => {
  for (const states of [
    [
      { state: 'open', title: 'Original title', body: 'Original body' },
      { state: 'closed', title: 'Original title', body: 'Original body' },
    ],
    [
      { state: 'open', title: 'Original title', body: 'Original body' },
      { state: 'open', title: 'Changed title', body: 'Original body' },
    ],
  ]) {
    const f = fixture({ mode: 'enforce', states, labelExists: true });
    const result = await f.run();
    assert.equal(result.outcome, 'skipped');
    assert.equal(result.comment_id, 51);
    assert.equal(result.partial, true);
    assert.equal(result.detector_revision, revision);
    assert.equal(result.model_sha256, hash);
    assert.equal(result.input_sha256, inputHash);
    assert.equal(JSON.stringify(result).includes('PRIVATE_RESPONSE_TEXT'), false);
  }
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
