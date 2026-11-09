import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { withCoordinator, toReview, expectTick, ROLE } from '../support/agent-worker-coordinator-database.mjs';
import { workerRoleQuery } from '../../src/automation/worker/pool.mjs';

let migrated = false;
async function migrate(h) {
  if (!migrated) {
    await h.owner.query(await readFile(new URL('../../migrations/agent-worker/004-review-requests.sql', import.meta.url), 'utf8'));
    migrated = true;
  }
  await h.owner.query(`GRANT SELECT, INSERT, UPDATE ON agent_worker.review_requests TO ${ROLE}`);
}
function configureOptIn(transport) {
  transport.manifest.reviewPolicy = { version: 1, profile: 'worker-command-maintainer-fallback-v1' };
  transport.manifest.qodoIdentities = [{ userId: 4000, appId: 4001,
    appSlug: 'qodo-code-review', completion: 'github-submitted-review-v1' }];
}
function wireReviewTransport(h, uncertain = false) {
  const nativeFetch = h.dependencies.fetch;
  const context = h.dependencies.publicationDependencies.getPullRequestContext;
  const comments = new Map();
  let posts = 0;
  const fetch = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === `/repos/randoneering/mellon/commits/${h.state.head}`) return Response.json({
      sha: h.state.head, author: { id: h.actor.databaseId, login: h.actor.login, type: 'Bot' },
      commit: { verification: { verified: true } },
    });
    if (path === '/repos/randoneering/mellon/issues/31/comments' && options.method === 'POST') {
      const row = (await h.owner.query('SELECT * FROM agent_worker.review_requests WHERE run_id=$1 AND head_sha=$2',
        [h.state.runId, h.state.head])).rows[0];
      assert.equal(row.attempted, true);
      assert.equal(row.comment_id, null);
      assert.deepEqual(JSON.parse(options.body), { body: '/agentic_review' });
      const comment = { id: 990 + posts++, body: '/agentic_review',
        issue_url: 'https://api.github.com/repos/randoneering/mellon/issues/31',
        user: { id: h.actor.databaseId, login: h.actor.login, type: 'Bot' },
        performed_via_github_app: { id: 5150 } };
      comments.set(comment.id, comment);
      if (uncertain) throw new Error('Private simulated lost POST acknowledgement');
      return Response.json(comment, { status: 201 });
    }
    const commentId = Number(path.match(/^\/repos\/randoneering\/mellon\/issues\/comments\/(\d+)$/)?.[1]);
    if (comments.has(commentId)) return Response.json(comments.get(commentId));
    return nativeFetch(url, options);
  };
  h.dependencies.fetch = fetch;
  h.dependencies.publicationDependencies = { ...h.dependencies.publicationDependencies, fetch,
    async getPullRequestContext(input) {
      const result = await context(input);
      result.installationToken.permissions.contents = 'read';
      return result;
    } };
  h.restart();
  return () => posts;
}

async function rejectsDirectTransition(h, lease, assignments, values = []) {
  const client = await h.runtime.connect();
  try {
    await client.query('BEGIN');
    await assert.rejects(client.query(`UPDATE agent_worker.review_requests SET ${assignments}
      WHERE run_id=$1`, [lease.runId, ...values]), { code: 'P0001' });
  } finally {
    // RED attempts must not corrupt the row used by subsequent transition tests.
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
}

// The shared fixture verifies a fresh local database marker before any SQL.
test('actual review request journal fences attempts and preserves native evidence', async t => {
  await withCoordinator(async h => {
    await migrate(h);
    await toReview(h);
    const claim = await h.claim();
    assert.equal(claim.status, 'claimed');
    const row = await h.row();
    const input = { headSha: row.expected_head_sha, identitySha256: 'e'.repeat(64),
      actorId: h.actor.databaseId, actorLogin: h.actor.login,
      appId: 1234, pullRequestNumber: Number(row.pull_request_number) };
    const store = h.actualStore, lease = claim.lease;
    await t.test('reserve binds worker actor rather than ticket actor', async () => {
      const first = await store.reserveReviewRequest(lease, input);
      assert.equal(first.actorId, input.actorId);
      assert.equal(first.actorLogin, input.actorLogin);
      assert.equal(first.attempted, false);
      assert.deepEqual(await store.reserveReviewRequest(lease, input), first);
    });
    await t.test('closed inputs and immutable identities reject rekeying', async () => {
      await assert.rejects(store.reserveReviewRequest(lease, { ...input, text: 'private' }));
      await assert.rejects(store.reserveReviewRequest(lease, { ...input, actorId: input.actorId + 1 }));
      await assert.rejects(store.reserveReviewRequest(lease, { ...input, identitySha256: 'f'.repeat(64) }));
    });
    await t.test('SQL cannot combine reservation attempt and comment confirmation', async () => {
      await rejectsDirectTransition(h, lease,
        'attempted=true,attempted_generation=$2,comment_id=987', [lease.generation]);
      const row = await store.getReviewRequest(lease, input.headSha);
      assert.equal(row.attempted, false);
      assert.equal(row.commentId, null);
    });
    await t.test('SQL cannot combine reservation attempt confirmation and review evidence', async () => {
      await rejectsDirectTransition(h, lease,
        "attempted=true,attempted_generation=$2,comment_id=987,evidence_source='maintainer',native_review_id=90",
        [lease.generation]);
      const row = await store.getReviewRequest(lease, input.headSha);
      assert.equal(row.attempted, false);
      assert.equal(row.commentId, null);
      assert.equal(row.evidenceSource, null);
    });
    await t.test('SQL cannot fence an attempt under another lease generation', async () => {
      await rejectsDirectTransition(h, lease, 'attempted=true,attempted_generation=$2', [lease.generation + 1]);
      assert.equal((await store.getReviewRequest(lease, input.headSha)).attempted, false);
    });
    await t.test('attempt is executable once across restarted store instances', async () => {
      assert.equal((await store.attemptReviewRequest(lease, input)).canExecute, true);
      assert.equal((await store.attemptReviewRequest(lease, input)).canExecute, false);
      h.restart();
      assert.equal((await h.actualStore.attemptReviewRequest(lease, input)).canExecute, false);
    });
    await t.test('SQL cannot confirm a comment and attach review evidence in one transition', async () => {
      await rejectsDirectTransition(h, lease,
        "comment_id=987,evidence_source='maintainer',native_review_id=90");
      const row = await store.getReviewRequest(lease, input.headSha);
      assert.equal(row.attempted, true);
      assert.equal(row.commentId, null);
      assert.equal(row.evidenceSource, null);
    });
    await t.test('native confirmation reconciles once without rewriting comment identity', async () => {
      assert.equal((await store.confirmReviewRequest(lease, { ...input, commentId: 987 })).commentId, 987);
      assert.equal((await store.confirmReviewRequest(lease, { ...input, commentId: 987 })).commentId, 987);
      await assert.rejects(store.confirmReviewRequest(lease, { ...input, commentId: 988 }));
      assert.equal((await store.getReviewRequest(lease, input.headSha)).commentId, 987);
    });
    await t.test('review source stays distinct and immutable', async () => {
      const evidence = await store.recordReviewEvidence(lease, { ...input, source: 'maintainer', reviewId: 90 });
      assert.equal(evidence.evidenceSource, 'maintainer');
      assert.equal(evidence.nativeReviewId, 90);
      await assert.rejects(store.recordReviewEvidence(lease, { ...input, source: 'qodo', reviewId: 91 }));
    });
    await t.test('SQL guards reject direct identity or attempt reset and unsupported privileges', async () => {
      for (const set of ['actor_id=actor_id+1', 'attempted=false', 'comment_id=988', "evidence_source='qodo'"]) {
        await assert.rejects(h.runtime.query(`UPDATE agent_worker.review_requests SET ${set} WHERE run_id=$1`, [lease.runId]));
      }
      await assert.rejects(h.runtime.query('DELETE FROM agent_worker.review_requests WHERE run_id=$1', [lease.runId]));
    });
    await t.test('SQL rejects a forged head reservation', async () => {
      await assert.rejects(h.runtime.query(`INSERT INTO agent_worker.review_requests
        (run_id,head_sha,repository_id,repository_full_name,pull_request_number,actor_id,actor_login,app_id,identity_sha256,lease_generation)
        SELECT run_id,$2,repository_id,repository_full_name,pull_request_number,actor_id,actor_login,app_id,identity_sha256,lease_generation
        FROM agent_worker.review_requests WHERE run_id=$1`, [lease.runId, 'f'.repeat(40)]));
    });
    await t.test('actual grant attestation binds the opt-in journal without broad privileges', async () => {
      const grants = async reviewRequests => (await h.runtime.query(workerRoleQuery({ reviewRequests }))).rows[0].grants_ok;
      assert.equal(await grants(true), true);
      assert.equal(await grants(false), false);
      await h.owner.query(`GRANT DELETE ON agent_worker.review_requests TO ${ROLE}`);
      assert.equal(await grants(true), false);
      await h.owner.query(`REVOKE DELETE ON agent_worker.review_requests FROM ${ROLE}`);
      assert.equal(await grants(true), true);
    });
    await t.test('expired and stale leases cannot read or write the request', async () => {
      assert.equal(await store.getReviewRequest({ ...lease, generation: lease.generation + 1 }, input.headSha), null);
      await h.expireLease();
      await rejectsDirectTransition(h, lease, 'updated_at=clock_timestamp()');
      assert.equal(await store.getReviewRequest(lease, input.headSha), null);
      assert.equal(await store.confirmReviewRequest(lease, { ...input, commentId: 987 }), null);
    });
  });
});

test('actual opt-in lifecycle dispatches once per owned head and requires native human proof', async () => {
  await withCoordinator(async h => {
    await migrate(h);
    const posts = wireReviewTransport(h);
    await toReview(h);
    await expectTick(h, 'waiting');
    await expectTick(h, 'waiting');
    assert.equal(posts(), 1);
    const originalHead = h.state.head;
    assert.equal((await h.row()).terminal_at, null);
    h.state.review = 'finding'; h.restart({ futureReview: true });
    await expectTick(h, 'advanced');
    for (let i = 0; (await h.row()).state !== 'waiting_review' && i < 10; i++) {
      const row = await h.row(); h.state.ci = row.state === 'waiting_red_ci' ? 'red' : 'green';
      await expectTick(h, 'advanced');
    }
    assert.equal((await h.row()).state, 'waiting_review');
    assert.notEqual(h.state.head, originalHead);
    h.restart();
    await expectTick(h, 'waiting');
    assert.equal(posts(), 2);
    h.state.reviewObjects = [{ id: 9911, user: { id: h.manifest.approver.id,
      login: h.manifest.approver.login, type: 'User' }, commit_id: h.state.head,
      pull_request_url: 'https://api.github.com/repos/randoneering/mellon/pulls/31',
      state: 'APPROVED', submitted_at: new Date().toISOString(), body: '' }];
    await expectTick(h, 'ready_for_human');
    const records = (await h.owner.query('SELECT * FROM agent_worker.review_requests WHERE run_id=$1 ORDER BY created_at', [h.state.runId])).rows;
    assert.equal(records.length, 2);
    assert.equal(records[0].evidence_source, null);
    assert.equal(records[1].evidence_source, 'maintainer');
    assert.equal(Number(records[1].native_review_id), 9911);
    assert.equal(records[1].head_sha, h.state.head);
    assert.equal(posts(), 2);
    assert.equal(h.state.prs[0].draft, true);
  }, { configure: configureOptIn });
});

test('actual lost review POST acknowledgement stops with durable attempt and no automatic retry', async () => {
  await withCoordinator(async h => {
    await migrate(h);
    const posts = wireReviewTransport(h, true);
    await toReview(h);
    await expectTick(h, 'needs_attention');
    const row = await h.row();
    assert.equal(row.blocker_code, 'recovery_effect_unconfirmed');
    const request = (await h.owner.query('SELECT * FROM agent_worker.review_requests WHERE run_id=$1', [h.state.runId])).rows[0];
    assert.equal(request.attempted, true);
    assert.equal(request.comment_id, null);
    await expectTick(h, 'idle');
    assert.equal(posts(), 1);
    assert.equal(h.results.find(value => value.reviewDiagnostics)?.reviewDiagnostics.category, 'review_write_uncertain');
  }, { configure: configureOptIn });
});
