import assert from 'node:assert/strict';
import test from 'node:test';
import { OUTCOME_LABELS } from '../../src/github.mjs';
import { moderate } from '../../src/moderation.mjs';

const hash = 'a'.repeat(64);
const inputHash = 'b'.repeat(64);
const revision = 'c'.repeat(40);
const context = (eventName = 'issues') => {
  const itemKey = eventName === 'issues' ? 'issue' : 'pull_request';
  return { eventName, repository: 'o/r', payload: {
    action: 'opened', repository: { full_name: 'o/r' },
    [itemKey]: { number: 4, title: 'Title', body: 'Body', user: { login: 'contributor' } },
  } };
};
const classification = (robotScore = 0.9) => ({ protocol_version: 1, outcome: 'classified', robot_score: robotScore,
  detector_revision: revision, model_sha256: hash, input_sha256: inputHash });

function fixture({ mode = 'enforce', reviewLabel = 'true', robotScore = 0.9,
  eventName = 'issues', itemLabels = [] } = {}) {
  const calls = [];
  const api = {
    async listComments() { calls.push('comments'); return []; },
    async getItem() { calls.push('state'); return { state: 'open', title: 'Title', body: 'Body' }; },
    async getItemLabels() { calls.push('item-labels'); return itemLabels; },
    async createComment({ body }) { calls.push('comment'); return { id: 8, body, user: { login: 'github-actions[bot]', type: 'Bot' } }; },
    async closeItem() { calls.push('close'); },
    async getReviewLabel() { calls.push('review-lookup'); return { exists: true }; },
    async createReviewLabel() { calls.push('review-create'); return { confirmed: true }; },
    async addLabel() { calls.push('apply:mellon: review'); return { confirmed: true }; },
    async getOutcomeLabel({ name }) { calls.push(`outcome-lookup:${name}`); return { exists: false }; },
    async createOutcomeLabel({ name }) { calls.push(`outcome-create:${name}`); return { confirmed: true }; },
  };
  return {
    calls,
    api,
    run: () => moderate({ getContext: () => context(eventName), getInputs: () => ({ mode, reviewLabel }),
      api, score: async () => classification(robotScore) }),
  };
}

const names = OUTCOME_LABELS.map(({ name }) => name);

test('an open reviewed item rerun blocks pending labels and closure in both modes', async () => {
  for (const outcomeLabel of names) {
    for (const mode of ['observe', 'enforce']) {
      for (const eventName of ['issues', 'pull_request_target']) {
        const f = fixture({ mode, eventName, itemLabels: [
          { name: 'mellon: review' }, { name: outcomeLabel },
        ] });
        const outcome = await f.run();
        assert.equal(outcome.outcome, 'skipped', `${outcomeLabel} in ${mode}/${eventName}`);
        assert.ok(f.calls.includes('item-labels'), `${outcomeLabel} was checked`);
        assert.equal(f.calls.some(call => call.startsWith('apply:')), false);
        assert.equal(f.calls.includes('close'), false);
        assert.equal(f.calls.some(call => call.startsWith('outcome-create:')), false);
      }
    }
  }
});

test('mixed-case outcome labels protect reviewed issues and pull requests', async () => {
  for (const name of ['Mellon: Reviewed-Human', 'MELLON: REVIEWED-AI', 'mellon: Reviewed-Unsure']) {
    for (const [mode, reviewLabel] of [['observe', 'true'], ['enforce', 'true'], ['enforce', 'false']]) {
      for (const eventName of ['issues', 'pull_request_target']) {
        const f = fixture({ mode, reviewLabel, eventName, itemLabels: [{ name }] });
        const outcome = await f.run();
        assert.equal(outcome.outcome, 'skipped', `${name}/${mode}/${reviewLabel}/${eventName}`);
        assert.equal(f.calls.some(call => call.startsWith('apply:')), false);
        assert.equal(f.calls.includes('close'), false);
        assert.equal(f.calls.some(call => call.startsWith('outcome-create:')), false);
      }
    }
  }
});

test('enforce mode checks completed outcomes before closure when review labeling is disabled', async () => {
  for (const outcomeLabel of names) {
    const f = fixture({ mode: 'enforce', reviewLabel: 'false', itemLabels: [{ name: outcomeLabel }] });
    const outcome = await f.run();
    assert.equal(outcome.outcome, 'skipped', outcomeLabel);
    assert.ok(f.calls.includes('item-labels'));
    assert.equal(f.calls.some(call => call.startsWith('apply:')), false);
    assert.equal(f.calls.includes('close'), false);
  }
});

test('rechecks outcomes before pending-label writes after a mid-run review swap', async () => {
  for (const mode of ['observe', 'enforce']) {
    const f = fixture({ mode });
    let reads = 0;
    f.api.getReviewLabel = async () => ({ exists: true });
    f.api.getItemLabels = async () => {
      f.calls.push('item-labels');
      return ++reads === 2 ? [{ name: names[0] }] : [];
    };
    const outcome = await f.run();
    assert.equal(outcome.outcome, 'skipped');
    assert.equal(reads, 2);
    assert.equal(f.calls.some(call => call.startsWith('apply:')), false);
    assert.equal(f.calls.includes('close'), false);
  }
});

test('an outcome label added during an uncertain pending-label write prevents retry and closure', async () => {
  const f = fixture({ mode: 'enforce' });
  let reads = 0;
  let writes = 0;
  f.api.getReviewLabel = async () => ({ exists: true });
  f.api.addLabel = async () => {
    writes++;
    const error = new Error('uncertain pending-label write');
    error.status = 503;
    throw error;
  };
  f.api.getItemLabels = async () => {
    f.calls.push('item-labels');
    if (++reads === 4) return [{ name: names[1] }];
    return [];
  };
  const outcome = await f.run();
  assert.equal(outcome.outcome, 'skipped');
  assert.equal(reads, 4);
  assert.equal(writes, 1);
  assert.equal(f.calls.includes('close'), false);
  assert.doesNotMatch(JSON.stringify(outcome), /uncertain pending-label write/);
});

test('a review completed after pending-label reconciliation prevents closure', async () => {
  const f = fixture({ mode: 'enforce' });
  let reads = 0;
  let writes = 0;
  f.api.getReviewLabel = async () => ({ exists: true });
  f.api.addLabel = async () => {
    writes++;
    const error = new Error('uncertain pending-label write');
    error.status = 503;
    throw error;
  };
  f.api.getItemLabels = async () => {
    f.calls.push('item-labels');
    reads++;
    if (reads === 3) return [{ name: 'mellon: review' }];
    if (reads === 4) return [{ name: names[2] }];
    return [];
  };
  const outcome = await f.run();
  assert.equal(outcome.outcome, 'skipped');
  assert.equal(reads, 4);
  assert.equal(writes, 1);
  assert.equal(f.calls.includes('close'), false);
});

test('unreadable or malformed outcome labels fail safely before pending or closure writes', async () => {
  for (const mode of ['observe', 'enforce']) {
    for (const failure of ['unreadable', 'malformed']) {
      const f = fixture({ mode });
      f.api.getItemLabels = async () => {
        f.calls.push('item-labels');
        if (failure === 'unreadable') throw new Error('private labels response');
        return [{ name: 7 }];
      };
      const outcome = await f.run();
      assert.equal(outcome.outcome, 'error', `${mode}/${failure}`);
      assert.equal(f.calls.some(call => call.startsWith('apply:')), false);
      assert.equal(f.calls.includes('close'), false);
      assert.doesNotMatch(JSON.stringify(outcome), /private labels response/);
    }
  }
  for (const failure of ['unreadable', 'malformed']) {
    const f = fixture({ mode: 'enforce', reviewLabel: 'false' });
    f.api.getItemLabels = async () => {
      f.calls.push('item-labels');
      if (failure === 'unreadable') throw new Error('private labels response');
      return [{ name: null }];
    };
    const outcome = await f.run();
    assert.equal(outcome.outcome, 'error', `label opt-out/${failure}`);
    assert.equal(f.calls.includes('close'), false);
    assert.doesNotMatch(JSON.stringify(outcome), /private labels response/);
  }
});

test('uses current paginated item labels, not embedded item labels, for review completion', async () => {
  const f = fixture({ mode: 'observe' });
  f.api.getItem = async () => ({ state: 'open', title: 'Title', body: 'Body',
    labels: [{ name: names[0] }] });
  f.api.getItemLabels = async () => { f.calls.push('item-labels'); return []; };
  const outcome = await f.run();
  assert.equal(outcome.outcome, 'flagged');
  assert.ok(f.calls.includes('apply:mellon: review'));
});

test('provisions fixed outcome labels in both modes and only applies the pending label', async () => {
  for (const mode of ['observe', 'enforce']) {
    const f = fixture({ mode });
    const outcome = await f.run();
    assert.equal(outcome.outcome, mode === 'observe' ? 'flagged' : 'closed');
    assert.deepEqual(f.calls.filter(call => call.startsWith('outcome-lookup:')),
      names.map(name => `outcome-lookup:${name}`));
    assert.deepEqual(f.calls.filter(call => call.startsWith('outcome-create:')),
      names.map(name => `outcome-create:${name}`));
    assert.deepEqual(f.calls.filter(call => call.startsWith('apply:')),
      ['apply:mellon: review']);
  }
});

test('does not provision outcome labels before checking current submission state', async () => {
  for (const mode of ['observe', 'enforce']) {
    for (const state of ['closed', 'unreadable']) {
      const f = fixture({ mode });
      f.api.getItem = async () => {
        if (state === 'unreadable') throw new Error('private state failure');
        return { state, title: 'Title', body: 'Body' };
      };
      const outcome = await f.run();
      assert.equal(outcome.outcome, state === 'closed' ? 'skipped' : 'error');
      assert.equal(f.calls.some(call => call.startsWith('outcome-create:')), false);
      assert.equal(f.calls.includes('close'), false);
    }
  }
});

test('reuses existing outcome labels without attempting to change their metadata', async () => {
  const f = fixture({ mode: 'observe' });
  f.api.getOutcomeLabel = async ({ name }) => {
    f.calls.push(`outcome-lookup:${name}`);
    return { exists: true };
  };
  const outcome = await f.run();
  assert.equal(outcome.outcome, 'flagged');
  assert.deepEqual(f.calls.filter(call => call.startsWith('outcome-lookup:')),
    names.map(name => `outcome-lookup:${name}`));
  assert.equal(f.calls.some(call => call.startsWith('outcome-create:')), false);
});

test('reconciles an outcome-label creation race and continues provisioning other labels', async () => {
  const f = fixture({ mode: 'observe' });
  const firstName = names[0];
  let firstLookups = 0;
  f.api.getOutcomeLabel = async ({ name }) => {
    f.calls.push(`outcome-lookup:${name}`);
    return { exists: name === firstName && ++firstLookups > 1 };
  };
  f.api.createOutcomeLabel = async ({ name }) => {
    f.calls.push(`outcome-create:${name}`);
    if (name === firstName) {
      const error = new Error('conflict response detail');
      error.status = 422;
      throw error;
    }
    return { confirmed: true };
  };
  const outcome = await f.run();
  assert.equal(outcome.outcome, 'flagged');
  assert.equal(f.calls.filter(call => call === `outcome-create:${firstName}`).length, 1);
  assert.deepEqual(f.calls.filter(call => call.startsWith('outcome-create:')),
    names.map(name => `outcome-create:${name}`));
  assert.doesNotMatch(JSON.stringify(outcome), /conflict response detail/);
});

test('reconciles an uncertain write that created the label without repeating it', async () => {
  const f = fixture({ mode: 'observe' });
  const firstName = names[0];
  let firstLookups = 0;
  f.api.getOutcomeLabel = async ({ name }) => {
    f.calls.push(`outcome-lookup:${name}`);
    return { exists: name === firstName && ++firstLookups > 1 };
  };
  f.api.createOutcomeLabel = async ({ name }) => {
    f.calls.push(`outcome-create:${name}`);
    if (name === firstName) {
      const error = new Error('uncertain response detail');
      error.status = 503;
      throw error;
    }
    return { confirmed: true };
  };
  const outcome = await f.run();
  assert.equal(outcome.outcome, 'flagged');
  assert.equal(f.calls.filter(call => call === `outcome-create:${firstName}`).length, 1);
  assert.deepEqual(f.calls.filter(call => call.startsWith('outcome-create:')),
    names.map(name => `outcome-create:${name}`));
  assert.doesNotMatch(JSON.stringify(outcome), /uncertain response detail/);
});

test('retries uncertain outcome-label writes within a bound without blocking moderation', async () => {
  const f = fixture({ mode: 'enforce' });
  const firstName = names[0];
  let firstWrites = 0;
  f.api.createOutcomeLabel = async ({ name }) => {
    f.calls.push(`outcome-create:${name}`);
    if (name === firstName) {
      firstWrites++;
      const error = new Error('private uncertain write');
      error.status = 503;
      throw error;
    }
    return { confirmed: true };
  };
  const outcome = await f.run();
  assert.equal(outcome.outcome, 'closed');
  assert.equal(firstWrites, 3);
  assert.equal(f.calls.filter(call => call === `outcome-lookup:${firstName}`).length, 4);
  assert.deepEqual(f.calls.filter(call => call.startsWith('outcome-create:')),
    [firstName, firstName, firstName, ...names.slice(1)].map(name => `outcome-create:${name}`));
  assert.ok(f.calls.includes('close'));
  assert.doesNotMatch(JSON.stringify(outcome), /private uncertain write/);
});

test('reports incomplete outcome-label setup without blocking moderation', async () => {
  for (const mode of ['observe', 'enforce']) {
    for (const failure of ['lookup', 'malformed', 'create', 'unconfirmed', 'reconcile']) {
      const f = fixture({ mode });
      let lookups = 0;
      f.api.getOutcomeLabel = async () => {
        lookups++;
        if (failure === 'lookup' || failure === 'reconcile' && lookups > 1) throw new Error('private setup response');
        return failure === 'malformed' ? { exists: 'unknown' } : { exists: false };
      };
      f.api.createOutcomeLabel = async () => {
        if (failure === 'unconfirmed') return { confirmed: false, detail: 'private setup response' };
        const error = new Error('private setup response');
        error.status = 403;
        throw error;
      };
      const outcome = await f.run();
      assert.equal(outcome.outcome, mode === 'observe' ? 'flagged' : 'closed', failure);
      assert.equal(outcome.outcome_labels_incomplete, true, failure);
      assert.equal(f.calls.includes('close'), mode === 'enforce');
      assert.doesNotMatch(JSON.stringify(outcome), /private setup response/);
    }
  }
});

test('confirmed outcome-label setup has no incomplete status after reconciliation', async () => {
  for (const status of [422, 503]) {
    const f = fixture({ mode: 'observe' });
    const created = new Set();
    f.api.getOutcomeLabel = async ({ name }) => ({ exists: created.has(name) });
    f.api.createOutcomeLabel = async ({ name }) => {
      created.add(name);
      const error = new Error('private create error');
      error.status = status;
      throw error;
    };
    const outcome = await f.run();
    assert.equal(outcome.outcome, 'flagged');
    assert.equal(outcome.outcome_labels_incomplete, undefined);
    assert.equal(created.size, 3);
  }
});

test('incomplete setup status survives later pending-label and closure failures', async () => {
  for (const failure of ['pending', 'close']) {
    const f = fixture();
    f.api.getOutcomeLabel = async () => { throw new Error('private setup response'); };
    if (failure === 'pending') {
      f.api.addLabel = async () => {
        const error = new Error('private pending failure');
        error.status = 403;
        throw error;
      };
    } else {
      f.api.closeItem = async () => { throw new Error('private close failure'); };
    }
    const outcome = await f.run();
    assert.equal(outcome.outcome, 'error');
    assert.equal(outcome.partial, true);
    assert.equal(outcome.comment_id, 8);
    assert.equal(outcome.outcome_labels_incomplete, true);
    assert.doesNotMatch(JSON.stringify(outcome), /private (setup response|pending failure|close failure)/);
  }
});

test('does not provision outcomes when labeling is disabled, score is below cutoff, or event is ineligible', async () => {
  for (const mode of ['observe', 'enforce']) {
    const disabled = fixture({ mode, reviewLabel: 'false' });
    const disabledOutcome = await disabled.run();
    assert.equal(disabledOutcome.outcome_labels_incomplete, undefined);
    assert.equal(disabled.calls.some(call => call.startsWith('outcome-')), false);

    const below = fixture({ mode, robotScore: 0.799999 });
    assert.equal((await below.run()).outcome, 'below_cutoff');
    assert.equal(below.calls.some(call => call.startsWith('outcome-')), false);

    let scoreCalls = 0;
    const ineligible = fixture({ mode });
    const outcome = await moderate({ getContext: () => ({ ...context(), payload: {
      ...context().payload, action: 'edited',
    } }), getInputs: () => ({ mode }), api: ineligible.api,
    score: async () => { scoreCalls++; return classification(); } });
    assert.equal(outcome.outcome, 'skipped');
    assert.equal(scoreCalls, 0);
    assert.equal(ineligible.calls.some(call => call.startsWith('outcome-')), false);
  }
});
