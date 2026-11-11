import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoordinator } from '../../src/automation/worker/coordinator.mjs';
import { COMMIT_SHA } from '../fixtures/agent-worker-publication.mjs';
import { publicationHarness, draftHarness } from '../fixtures/worker-coordinator/publication.mjs';
import { delivery } from '../fixtures/worker-coordinator/harness.mjs';

for (const lostAcknowledgment of [false, true]) {
  test(`coordinator actual recovery/publisher with scripted store: one signed candidate, lost HTTP ack ${lostAcknowledgment}`, async () => {
    const h = await publicationHarness({ loseCommitAck: lostAcknowledgment });
    const coordinator = createCoordinator(h.dependencies);
    assert.equal((await coordinator.advanceTick(delivery())).status, 'advanced');
    const parent = h.state.phase.headSha;
    const result = await coordinator.advanceTick(delivery());
    assert.equal(result.status, 'advanced', JSON.stringify({ result, deadlines: h.state.recoveryStoreDeadlines,
      ledgerDeadlines: h.state.recoveryStoreDeadlines,
      calls: h.state.calls.filter(call => ['snapshot', 'getRun', 'recovery', 'putIntent', 'fenceIntent', 'confirmIntent'].includes(call[0])).map(call => [call[0], call[1]?.deadline]),
      claimDeadline: h.state.deadline, outerDeadline: h.state.outerDeadline }));
    assert.equal(h.fixture.state.branchWrites, 1);
    assert.equal(h.fixture.state.commitWrites, 1);
    assert.equal(h.state.run.expectedHeadSha, COMMIT_SHA);
    assert.equal(h.state.phase.headSha, parent);
    assert.equal(h.state.run.state, 'waiting_red_ci');
    assert.equal(h.state.calls.at(-1)[0], 'checkpoint');
    assert.equal(h.state.modelRequests, 1);
  });
}

test('coordinator actual reconstruction + same-intent recovery: observed immutable blobs reconcile with zero model/mutation replay', async () => {
  const h = await publicationHarness(); h.useActualReconstruction();
  const coordinator = createCoordinator(h.dependencies);
  await coordinator.advanceTick(delivery());
  h.installObservedCandidate();
  const response = await coordinator.advanceTick(delivery());
  assert.equal(response.status, 'advanced', JSON.stringify(response));
  assert.equal(h.state.modelRequests, 0);
  assert.equal(h.fixture.state.branchWrites, 0); assert.equal(h.fixture.state.commitWrites, 0);
  assert.equal(h.state.run.expectedHeadSha, COMMIT_SHA);
});

test('coordinator actual publication: uncertain confirmation acknowledgment has no release or compensating terminal write', async () => {
  const h = await publicationHarness(); const coordinator = createCoordinator(h.dependencies);
  await coordinator.advanceTick(delivery());
  h.state.confirmHook = () => { throw new Error('uncertain COMMIT'); };
  const response = await coordinator.advanceTick(delivery());
  assert.equal(response.reason, 'recovery_database_uncertain');
  assert.equal(h.fixture.state.commitWrites, 1);
  assert.equal(h.state.stops.length, 0);
  assert.equal(h.state.calls.filter(call => call[0] === 'checkpoint').length, 1);
});

for (const issuanceConfirmed of [true, false]) {
  test(`coordinator actual draft publisher with scripted opening phase: App issuance record ${issuanceConfirmed}`, async () => {
    const h = await draftHarness();
    if (!issuanceConfirmed) {
      const context = h.dependencies.publicationDependencies.getPullRequestContext;
      h.dependencies.publicationDependencies.getPullRequestContext = async request => {
        const result = await context(request); delete result.installationToken; return result;
      };
    }
    const coordinator = createCoordinator(h.dependencies);
    const response = await coordinator.advanceTick(delivery());
    assert.equal(response.status, issuanceConfirmed ? 'advanced' : 'needs_attention', JSON.stringify(response));
    assert.equal(h.fixture.state.prWrites, issuanceConfirmed ? 1 : 0);
    assert.equal(h.state.modelRequests, 0);
    if (issuanceConfirmed) {
      assert.equal(h.state.run.state, 'waiting_review');
      assert.equal(h.fixture.state.prs[0].draft, true);
      assert.ok(h.state.calls.filter(call => call[0] === 'draftChecks').length >= 2);
    }
  });
}

for (const boundary of ['branch', 'commit']) {
  test(`coordinator actual publisher fresh revocation before ${boundary} cancels under the current lease`, async () => {
    const h = await publicationHarness();
    if (boundary === 'branch') {
      const getContext = h.dependencies.publicationDependencies.getPublicationContext;
      h.dependencies.publicationDependencies.getPublicationContext = async request => {
        const context = await getContext(request); h.state.approvalReason = 'readiness_label_missing'; return context;
      };
    } else {
      const fetch = h.dependencies.publicationDependencies.fetch;
      h.dependencies.publicationDependencies.fetch = async (url, options) => {
        const response = await fetch(url, options);
        if (new URL(url).pathname.endsWith('/git/refs') && options.method === 'POST') h.state.approvalReason = 'readiness_label_missing';
        return response;
      };
    }
    const coordinator = createCoordinator(h.dependencies);
    await coordinator.advanceTick(delivery());
    const response = await coordinator.advanceTick(delivery());
    assert.equal(response.status, 'cancelled', JSON.stringify(response));
    assert.equal(h.fixture.state.commitWrites, 0);
    assert.equal(h.fixture.state.branchWrites, boundary === 'branch' ? 0 : 1);
  });
}
