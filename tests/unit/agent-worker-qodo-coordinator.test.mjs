import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, delivery } from '../fixtures/worker-coordinator/harness.mjs';
import { createCoordinator } from '../../src/automation/worker/coordinator.mjs';

async function setup(reviewResult) {
  const h = await harness();
  h.adapters.review = { async readReview(request) {
    return structuredClone(typeof reviewResult === 'function' ? reviewResult(request, h) : reviewResult);
  } };
  h.coordinator = createCoordinator(h.dependencies);
  return h;
}

async function tick(h) {
  return h.coordinator.advanceTick(delivery());
}

async function reachReview(h) {
  for (let index = 0; h.state.run.state !== 'waiting_review' && index < 12; index += 1) {
    h.state.checkStatus = h.state.run.state === 'waiting_red_ci' ? 'intended_red' : 'success';
    const result = await tick(h);
    assert.equal(result.status, 'advanced');
  }
  assert.equal(h.state.run.state, 'waiting_review');
}

const finding = {
  reviewId: 81,
  commentId: 901,
  commitSha: 'a'.repeat(40),
  path: 'src/parser.mjs',
  line: 1,
  body: 'Untrusted report text',
};

function boundReview(findings, h, request) {
  return {
    status: 'findings', authenticated: true, repository: request.repository,
    repositoryId: request.repositoryId, pullNumber: request.pullNumber,
    headSha: h.state.run.expectedHeadSha, draft: false, state: 'open', findings,
  };
}

test('Qodo current source finding enters shared bounded repair without native CI identity', async () => {
  const h = await setup((request, current) => boundReview([
    { ...finding, commitSha: current.state.run.expectedHeadSha },
  ], current, request));
  await reachReview(h);
  h.state.checkStatus = 'success';
  const result = await tick(h);
  assert.equal(result.status, 'advanced');
  assert.equal(h.state.phase.purpose, 'repair_investigation');
  assert.equal(h.state.phase.findingSource, 'qodo');
  assert.equal(h.state.run.repairCycleCount, 1);
  assert.equal(JSON.stringify(h.state.phase).includes(finding.body), false);
  assert.equal((await tick(h)).status, 'advanced');
  assert.equal(h.state.phase.purpose, 'repair_tests');
  assert.equal((await tick(h)).status, 'advanced');
  const investigation = h.state.contexts.find(context => context.investigation)?.investigation;
  assert.equal(investigation.references[0].testIdentitySha256, null);
  assert.equal(investigation.references[0].blobSha, h.state.files[5].blobSha);
  assert.equal(JSON.stringify(investigation).includes(finding.body), false);
  const report = h.state.contexts.find(context => context.investigation)?.findingReport;
  assert.equal(report.body, finding.body);
  assert.equal(report.fileIndex, investigation.references[0].fileIndex);
  assert.equal(report.findingSha256, investigation.findingSha256);
  assert.equal(JSON.stringify(h.state.phase).includes(finding.body), false);
});

test('authenticated findings on the owned draft enter repair without declaring clean completion', async () => {
  const h = await setup((request, current) => ({ ...boundReview([
    { ...finding, commitSha: current.state.run.expectedHeadSha },
  ], current, request), draft: true }));
  await reachReview(h);
  h.state.checkStatus = 'success';
  assert.equal((await tick(h)).status, 'advanced');
  assert.equal(h.state.phase.findingSource, 'qodo');
  assert.equal(h.state.run.repairCycleCount, 1);
  assert.notEqual(h.state.run.state, 'ready_for_human');
});

test('coordinator requires owned-draft review evidence even while the reader is waiting', async () => {
  let requireDraft;
  const h = await setup(request => { requireDraft = request.requireDraft; return { status: 'waiting' }; });
  await reachReview(h);
  assert.equal((await tick(h)).status, 'waiting');
  assert.equal(requireDraft, true);
});

test('Qodo source finding rejects wrong commit, unapproved path, or out-of-range line', async t => {
  const cases = [
    ['head', { ...finding, commitSha: 'b'.repeat(40) }],
    ['path', { ...finding, path: 'package.json' }],
    ['line', { ...finding, line: 9999 }],
  ];
  for (const [name, value] of cases) await t.test(name, async () => {
    const h = await setup((request, current) => boundReview([{
      ...value, commitSha: name === 'head' ? 'b'.repeat(40) : current.state.run.expectedHeadSha,
    }], current, request));
    await reachReview(h);
    h.state.checkStatus = 'success';
    assert.equal((await tick(h)).status, 'needs_attention');
    assert.equal(h.state.run.repairCycleCount, 0);
  });
});

test('Qodo current findings reject mismatched repository and empty completion is not inferred', async () => {
  const h = await setup((request, current) => ({
    ...boundReview([], current, request), repositoryId: 7,
  }));
  await reachReview(h);
  h.state.checkStatus = 'success';
  assert.equal((await tick(h)).status, 'needs_attention');
  assert.equal(h.state.publications.filter(item => item.intent.kind === 'pr_create').length, 1);
});
