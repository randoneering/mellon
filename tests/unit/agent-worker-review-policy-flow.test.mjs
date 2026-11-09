import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoordinator } from '../../src/automation/worker/coordinator.mjs';
import { harness, delivery, syntheticFutureReview } from '../fixtures/worker-coordinator/harness.mjs';
import { hash, canonical } from '../fixtures/worker-candidates/inputs.mjs';

async function optedIn() {
  const h = await harness();
  h.manifest.reviewPolicy = { version: 1, profile: 'worker-command-maintainer-fallback-v1' };
  h.manifest.qodoIdentities = [{ userId: 4000, appId: 4001,
    appSlug: 'qodo-code-review', completion: 'github-submitted-review-v1' }];
  h.state.run.manifestHash = h.dependencies.expectedManifestSha256 = hash(canonical(h.manifest));
  h.dependencies.ownedActor = { databaseId: 19, login: 'worker[bot]' };
  h.state.dispatches = 0; h.state.proof = null; h.state.reviewReason = 'review_absent';
  h.adapters.reviewRequestPublisher = { async dispatch() {
    assert.equal(h.state.run.state, 'waiting_review');
    assert.ok(h.state.run.pullRequestNumber);
    assert.equal(h.state.publications.filter(item => item.intent.kind === 'pr_create').length, 1);
    h.state.dispatches++;
    return h.state.dispatchFailure ?? { status: 'confirmed', commentId: 99, appId: 23,
      identitySha256: 'e'.repeat(64) };
  } };
  h.adapters.review.readReview = async () => h.state.reviewResult ?? { status: 'waiting', reason: h.state.reviewReason };
  h.adapters.review.readMaintainerReview = async () => {
    h.state.humanReads = (h.state.humanReads ?? 0) + 1;
    return h.state.humanApproved ? { status: 'approved', headSha: h.state.run.expectedHeadSha,
      reviewId: 901, reviewerId: h.manifest.approver.id, reviewerLogin: h.manifest.approver.login } : { status: 'waiting' };
  };
  h.store.recordReviewEvidence = async (_lease, input) => {
    h.state.proof = input; return { evidenceSource: input.source, nativeReviewId: input.reviewId };
  };
  const c = createCoordinator(h.dependencies);
  h.tick = () => c.advanceTick(delivery());
  for (let i = 0; h.state.run.state !== 'waiting_review' && i < 10; i++) {
    h.state.checkStatus = h.state.run.state === 'waiting_red_ci' ? 'intended_red' : 'success';
    assert.equal((await h.tick()).status, 'advanced');
  }
  assert.equal(h.state.run.state, 'waiting_review');
  return h;
}

test('opt-in dispatch runs while evidence is absent and acknowledgement never implies coverage', async () => {
  const h = await optedIn();
  assert.equal((await h.tick()).status, 'waiting');
  assert.equal(h.state.dispatches, 1);
  assert.equal(h.state.proof, null);
  assert.equal(h.state.run.terminalAt, null);
});

test('native human proof records maintainer source with unchanged CI and full-head evidence', async () => {
  const h = await optedIn(); h.state.humanApproved = true;
  const result = await h.tick();
  assert.equal(result.status, 'ready_for_human');
  assert.equal(h.state.proof.source, 'maintainer');
  assert.equal(h.state.proof.headSha, h.state.run.expectedHeadSha);
  assert.equal(h.state.proof.reviewId, 901);
  assert.equal(h.state.run.checkEvidence.reviewId, 901);
  assert.equal(result.reviewDiagnostics.source, 'maintainer');
});

test('native Qodo completion records Qodo source without calling human fallback', async () => {
  const h = await optedIn(); h.state.reviewResult = syntheticFutureReview(h.state);
  assert.equal((await h.tick()).status, 'ready_for_human');
  assert.equal(h.state.proof.source, 'qodo');
  assert.equal(h.state.humanReads ?? 0, 0);
});

test('current actionable Qodo findings are not discarded through human fallback', async () => {
  const h = await optedIn(); h.state.humanApproved = true;
  h.state.reviewResult = syntheticFutureReview(h.state, [{ unsupported: 'finding' }]);
  assert.equal((await h.tick()).status, 'needs_attention');
  assert.equal(h.state.humanReads ?? 0, 0);
  assert.equal(h.state.proof, null);
});

for (const reason of ['unsupported_report', 'github_read_failed', 'bot_identity_mismatch']) {
  test(`review failure ${reason} cannot use human fallback`, async () => {
    const h = await optedIn(); h.state.humanApproved = true;
    h.state.reviewResult = { status: reason === 'unsupported_report' ? 'waiting' : 'needs_attention', reason };
    assert.notEqual((await h.tick()).status, 'ready_for_human');
    assert.equal(h.state.humanReads ?? 0, 0);
  });
}

test('CI waiting prevents command dispatch and human readiness', async () => {
  const h = await optedIn(); h.state.checkStatus = 'waiting'; h.state.humanApproved = true;
  assert.equal((await h.tick()).status, 'waiting');
  assert.equal(h.state.dispatches, 0);
  assert.equal(h.state.proof, null);
});

test('uncertain dispatch stops safely with fixed diagnostics rather than reposting', async () => {
  const h = await optedIn(); h.state.dispatchFailure = { status: 'needs_attention', category: 'review_write_uncertain' };
  const result = await h.tick();
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.reason, 'recovery_effect_unconfirmed');
  assert.equal(result.reviewDiagnostics.category, 'review_write_uncertain');
  assert.equal(h.state.humanReads ?? 0, 0);
});
