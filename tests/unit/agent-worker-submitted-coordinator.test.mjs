import assert from 'node:assert/strict';
import test from 'node:test';
import { createCoordinator } from '../../src/automation/worker/coordinator.mjs';
import { createReviewReader } from '../../src/automation/worker/review.mjs';
import { harness, delivery } from '../fixtures/worker-coordinator/harness.mjs';
import { hash, canonical } from '../fixtures/worker-candidates/inputs.mjs';
import { SUBMITTED_IDENTITY, submittedReviewApi } from '../fixtures/agent-worker-review/submitted.mjs';

async function setup(findings = false) {
  const h = await harness();
  h.manifest.qodoIdentities = [{ ...SUBMITTED_IDENTITY }];
  const digest = hash(canonical(h.manifest));
  h.dependencies.expectedManifestSha256 = digest;
  h.state.run.manifestHash = digest;
  const api = submittedReviewApi({ repositoryId: h.manifest.repository.id,
    pullNumber: 77, headSha: () => h.state.run.expectedHeadSha,
    comments: () => findings ? [{ id: 901, pull_request_review_id: 81,
      user: { id: 151058649, type: 'Bot', login: 'qodo-code-review[bot]' },
      commit_id: h.state.run.expectedHeadSha, side: 'RIGHT', line: 1,
      path: 'src/parser.mjs', body: 'Synthetic bounded report',
      pull_request_url: 'https://api.github.com/repos/randoneering/mellon/pulls/77',
    }] : [] });
  h.adapters.review = createReviewReader({ token: 'synthetic-token',
    repositoryId: h.manifest.repository.id, fetch: api.fetch });
  const coordinator = createCoordinator(h.dependencies);
  h.tick = () => coordinator.advanceTick(delivery());
  for (let index = 0; h.state.run.state !== 'waiting_review' && index < 12; index += 1) {
    h.state.checkStatus = h.state.run.state === 'waiting_red_ci' ? 'intended_red' : 'success';
    const result = await h.tick();
    assert.equal(result.status, 'advanced', result.reason);
  }
  assert.equal(h.state.run.state, 'waiting_review');
  return h;
}

test('actual submitted-review reader permits ready-for-human with fresh checks and an owned draft', async () => {
  const h = await setup();
  h.state.checkStatus = 'success';
  assert.equal((await h.tick()).status, 'ready_for_human');
  assert.equal(h.state.publications.filter(item => item.intent.kind === 'pr_create').length, 1);
  assert.equal(h.state.run.state, 'ready_for_human');
});

test('actual submitted-review source findings enter bounded investigation instead of readiness', async () => {
  const h = await setup(true);
  h.state.checkStatus = 'success';
  assert.equal((await h.tick()).status, 'advanced');
  assert.equal(h.state.phase.findingSource, 'qodo');
  assert.equal(h.state.run.repairCycleCount, 1);
  assert.equal((await h.tick()).status, 'advanced');
  assert.equal((await h.tick()).status, 'advanced');
  const context = h.state.contexts.find(value => value.findingReport);
  assert.equal(context.findingReport.body, 'Synthetic bounded report');
  assert.equal(context.investigation.references[0].testIdentitySha256, null);
  assert.equal(JSON.stringify(h.state.phase).includes('Synthetic bounded report'), false);
});

test('published Qodo review cannot replace failed current-head CI', async () => {
  const h = await setup();
  h.state.checkStatus = 'failure';
  assert.notEqual((await h.tick()).status, 'ready_for_human');
});
