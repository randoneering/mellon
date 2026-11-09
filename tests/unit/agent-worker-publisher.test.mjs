import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { publish, probePublication } from '../../src/automation/worker/publisher.mjs';
import * as publisher from '../../src/automation/worker/publisher.mjs';
const ensureDraftPr = (...args) => {
  assert.equal(typeof publisher.ensureDraftPr, 'function', 'missing ensureDraftPr implementation');
  return publisher.ensureDraftPr(...args);
};
import { gitBlobSha } from '../../src/automation/worker/publication-validation.mjs';
import { createCheckReader } from '../../src/automation/worker/checks.mjs';
import {
  BASE_SHA,
  CHANGE_CONTENT,
  CHANGE_PATH,
  COMMIT_SHA,
  RUN_ID,
  TOKEN,
  createPublisherFixture,
  createDraftPrFixture,
  createOwnedHistoryFixture,
  PR_TEMPLATE,
} from '../fixtures/agent-worker-publication.mjs';

function writes(fixture) {
  return fixture.calls.filter(call => call.url.endsWith('/git/refs')
    || call.url.endsWith('/graphql')
      && JSON.parse(call.body).query.includes('mutation AgentWorkerCreateCommit'));
}

function graphqlMutations(fixture) {
  return fixture.calls.filter(call => call.url.endsWith('/graphql')
    && JSON.parse(call.body).query.includes('mutation AgentWorkerCreateCommit'));
}

test('publishes one structured commit to the deterministic run branch with expected-head CAS', async () => {
  const fixture = createPublisherFixture();
  const result = await publish(fixture.request, fixture.dependencies);

  assert.equal(result.status, 'confirmed');
  assert.equal(result.branch, `agent-work/${RUN_ID}`);
  assert.equal(result.parentSha, BASE_SHA);
  assert.equal(result.commitSha, COMMIT_SHA);
  assert.equal(result.branchHeadSha, COMMIT_SHA);
  assert.match(result.inputHash, /^[a-f0-9]{64}$/);
  assert.equal(fixture.state.branchWrites, 1);
  assert.equal(fixture.state.commitWrites, 1);
  assert.equal(fixture.state.approvalCalls, 3);
  assert.ok(fixture.state.fenceCalls.includes('branch'));
  assert.ok(fixture.state.fenceCalls.includes('commit'));
  assert.ok(fixture.state.fenceCalls.includes('probe'));

  const mutation = JSON.parse(graphqlMutations(fixture)[0].body).variables.input;
  assert.equal(mutation.branch.repositoryNameWithOwner, 'randoneering/mellon');
  assert.equal(mutation.branch.branchName, `agent-work/${RUN_ID}`);
  assert.equal(mutation.expectedHeadOid, BASE_SHA);
  assert.equal(mutation.fileChanges.additions[0].path, CHANGE_PATH);
  assert.equal(Buffer.from(mutation.fileChanges.additions[0].contents, 'base64').toString(), CHANGE_CONTENT);
  assert.equal(mutation.fileChanges.deletions, undefined);
  assert.equal(mutation.message.headline, 'Apply approved agent changes');
  assert.equal(Object.hasOwn(mutation, 'author'), false);
  assert.equal(Object.hasOwn(mutation, 'committer'), false);

  const requests = writes(fixture);
  assert.deepEqual(requests.map(call => [call.method, new URL(call.url).pathname]), [
    ['POST', '/repos/randoneering/mellon/git/refs'],
    ['POST', '/graphql'],
  ]);
  assert.ok(requests.every(call => new URL(call.url).origin === 'https://api.github.com'));
  assert.ok(requests.every(call => call.redirect === 'manual'));
  assert.ok(requests.every(call => call.method === 'POST'));
  assert.ok(requests.every(call => !call.url.includes('/main')));
  assert.ok(requests.every(call => !call.method.includes('PATCH') && !call.method.includes('PUT')));
  assert.ok(fixture.calls.every(call => new URL(call.url).origin === 'https://api.github.com'));
  assert.ok(fixture.calls.every(call => call.headers.authorization === `Bearer ${TOKEN}`));
  assert.ok(fixture.calls.every(call => {
    const url = new URL(call.url);
    return url.pathname === '/graphql'
      ? url.search === ''
      : url.search === '' || url.search === '?recursive=1';
  }));
  for (const call of fixture.calls.filter(item => item.url.endsWith('/graphql'))) {
    const query = JSON.parse(call.body).query;
    assert.ok(query.includes('mutation AgentWorkerCreateCommit')
      || query.includes('query AgentWorkerCommitProof'));
  }
});

for (const options of [{}, { loseBranchAck: true }, { loseCommitAck: true }]) {
  test(`documented Git-object trees and GraphQL short refs confirm and reconcile ${JSON.stringify(options)}`, async () => {
    const fixture = createPublisherFixture(options);
    const result = await publish(fixture.request, fixture.dependencies);
    assert.equal(result.status, 'confirmed');
    assert.equal(result.commitSha, COMMIT_SHA);
    const before = writes(fixture).length;
    const recovered = await probePublication(fixture.request, fixture.dependencies);
    assert.equal(recovered.status, 'confirmed');
    assert.equal(recovered.commitSha, COMMIT_SHA);
    assert.equal(writes(fixture).length, before);
    for (const call of fixture.calls.filter(item => item.url.endsWith('/graphql'))) {
      assert.match(JSON.parse(call.body).query, /ref[\s\S]*\bprefix\b/);
    }
  });
}

for (const loseCommitAck of [false, true]) {
  test(`six-commit lifecycle confirms its final implementation and recovery: lost ack ${loseCommitAck}`, async () => {
    const fixture = createOwnedHistoryFixture(5, { loseCommitAck });
    assert.equal((await publish(fixture.request, fixture.dependencies)).status, 'confirmed');
    assert.equal(fixture.state.commitWrites, 1);
    assert.equal((await probePublication(fixture.request, fixture.dependencies)).status, 'confirmed');
    assert.equal(fixture.state.commitWrites, 1);
  });
}

test('six-commit lifecycle can open its one draft PR after the second repair', async () => {
  const fixture = createOwnedHistoryFixture(6, { draftPr: true });
  assert.equal((await ensureDraftPr(fixture.request, fixture.dependencies)).status, 'confirmed');
  assert.equal(fixture.state.prWrites, 1);
});

test('six-commit lifecycle denies a seventh new commit before dispatch', async () => {
  const fixture = createOwnedHistoryFixture(6);
  assert.equal((await publish(fixture.request, fixture.dependencies)).status, 'needs_attention');
  assert.equal(fixture.state.commitWrites, 0);
});

test('six-commit lifecycle rejects excessive or foreign ancestry before PR creation', async () => {
  for (const [length, options] of [[7, {}], [6, { foreignDepth: 2 }]]) {
    const fixture = createOwnedHistoryFixture(length, { ...options, draftPr: true });
    assert.equal((await ensureDraftPr(fixture.request, fixture.dependencies)).status, 'needs_attention');
    assert.equal(fixture.state.prWrites, 0);
  }
});

test('accepts an approved merge commit as the base parent', async () => {
  const fixture = createPublisherFixture({
    baseParents: [{ sha: '2'.repeat(40) }, { sha: '3'.repeat(40) }],
  });
  const result = await publish(fixture.request, fixture.dependencies);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.parentSha, BASE_SHA);
});

test('uses only the expected base and current head, never a caller-selected branch', async () => {
  const fixture = createPublisherFixture();
  fixture.request.branch = 'main';
  const result = await publish(fixture.request, fixture.dependencies);
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.reason, 'invalid_input');
  assert.equal(fixture.state.branchWrites, 0);
  assert.equal(fixture.state.commitWrites, 0);
});

test('reconciles a lost branch-create acknowledgment before the commit', async () => {
  const fixture = createPublisherFixture({ loseBranchAck: true });
  const result = await publish(fixture.request, fixture.dependencies);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.branch, `agent-work/${RUN_ID}`);
  assert.equal(fixture.state.branchWrites, 1);
  assert.equal(fixture.state.commitWrites, 1);
});

test('reconciles a lost commit acknowledgment only from exact signed remote state', async () => {
  const fixture = createPublisherFixture({ loseCommitAck: true });
  const result = await publish(fixture.request, fixture.dependencies);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.commitSha, COMMIT_SHA);
  assert.equal(fixture.state.commitWrites, 1);
  assert.equal(graphqlMutations(fixture).length, 1);
});

test('does not repeat a commit when an uncertain write left the expected head unchanged', async () => {
  const fixture = createPublisherFixture({
    loseCommitAck: true,
    commitDoesNotApply: true,
  });
  const result = await publish(fixture.request, fixture.dependencies);
  assert.equal(result.status, 'needs_attention');
  assert.equal(fixture.state.commitWrites, 1);
  assert.equal(graphqlMutations(fixture).length, 1);
});

test('does not retry branch creation when an uncertain write left no branch', async () => {
  const fixture = createPublisherFixture({ branchCreateDoesNotApply: true });
  const result = await publish(fixture.request, fixture.dependencies);
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.reason, 'branch_write_unconfirmed');
  assert.equal(fixture.state.branchWrites, 1);
  assert.equal(fixture.state.commitWrites, 0);
});

test('stops when the run branch already contains foreign or human work', async () => {
  const fixture = createPublisherFixture({ initialBranchHead: '9'.repeat(40) });
  const result = await publish(fixture.request, fixture.dependencies);
  assert.equal(result.status, 'needs_attention');
  assert.equal(fixture.state.branchWrites, 0);
  assert.equal(fixture.state.commitWrites, 0);
});

test('expected-head CAS rejects a branch moved between the probe and commit', async () => {
  const fixture = createPublisherFixture({ moveBeforeCommit: true });
  const result = await publish(fixture.request, fixture.dependencies);
  assert.equal(result.status, 'needs_attention');
  assert.equal(fixture.state.branchWrites, 1);
  assert.equal(fixture.state.commitWrites, 1);
  assert.equal(graphqlMutations(fixture).length, 1);
});

test('rejects protected paths and forbidden patch operations before any write', async () => {
  for (const [manifest, proposedChanges] of [
    [{ allowedPaths: ['.github/workflows/test.yml'] }, [
      { operation: 'create', path: '.github/workflows/test.yml', content: 'untrusted' },
    ]],
    [{}, [{ operation: 'delete', path: CHANGE_PATH }]],
  ]) {
    const fixture = createPublisherFixture({ manifest, proposedChanges });
    const result = await publish(fixture.request, fixture.dependencies);
    assert.equal(result.status, 'needs_attention');
    assert.equal(result.reason, 'patch_rejected');
    assert.equal(fixture.state.branchWrites, 0);
    assert.equal(fixture.state.commitWrites, 0);
  }
});

test('requires verified short-lived App signing context before any publication write', async () => {
  const fixture = createPublisherFixture({
    context: context => ({ ...context, signingPreflight: null }),
  });
  const result = await publish(fixture.request, fixture.dependencies);
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.reason, 'signing_preflight_missing');
  assert.equal(fixture.state.branchWrites, 0);
  assert.equal(fixture.state.commitWrites, 0);
  assert.equal(writes(fixture).length, 0);
});

test('requires fresh approval before publication and performs no write on denial', async () => {
  const fixture = createPublisherFixture({ approvalDenied: true });
  const result = await publish(fixture.request, fixture.dependencies);
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.reason, 'approval_denied');
  assert.equal(writes(fixture).length, 0);
});

test('requires the current lease, generation, and durable intent before each mutation', async () => {
  const branchDenied = createPublisherFixture({ fenceDecisions: { branch: 'deny' } });
  const branchResult = await publish(branchDenied.request, branchDenied.dependencies);
  assert.equal(branchResult.status, 'needs_attention');
  assert.equal(branchDenied.state.branchWrites, 0);
  assert.equal(branchDenied.state.commitWrites, 0);

  const commitDenied = createPublisherFixture({ fenceDecisions: { commit: 'deny' } });
  const commitResult = await publish(commitDenied.request, commitDenied.dependencies);
  assert.equal(commitResult.status, 'needs_attention');
  assert.equal(commitResult.branchHeadSha, BASE_SHA);
  assert.equal(commitDenied.state.branchWrites, 1);
  assert.equal(commitDenied.state.commitWrites, 0);
});

test('reconcile-only intent state never repeats a prior uncertain commit', async () => {
  const fixture = createPublisherFixture({
    initialBranchHead: BASE_SHA,
    fenceDecisions: { commit: 'reconcile_only' },
  });
  const result = await publish(fixture.request, fixture.dependencies);
  assert.equal(result.status, 'needs_attention');
  assert.equal(fixture.state.branchWrites, 0);
  assert.equal(fixture.state.commitWrites, 0);
});

test('does not confirm a commit without the expected App actor and GitHub signature proof', async () => {
  for (const options of [{ wrongActor: true }, { wrongSignature: true }]) {
    const fixture = createPublisherFixture(options);
    const result = await publish(fixture.request, fixture.dependencies);
    assert.equal(result.status, 'needs_attention');
    assert.notEqual(result.commitSha, COMMIT_SHA);
  }
});

test('rejects truncated trees and unsupported file modes before confirming publication', async () => {
  const truncated = createPublisherFixture({ truncatedBaseTree: true });
  const truncatedResult = await publish(truncated.request, truncated.dependencies);
  assert.equal(truncatedResult.status, 'needs_attention');
  assert.equal(truncated.state.branchWrites, 0);
  assert.equal(truncated.state.commitWrites, 0);

  const modeChange = createPublisherFixture({ committedMode: '100755' });
  const modeResult = await publish(modeChange.request, modeChange.dependencies);
  assert.equal(modeResult.status, 'needs_attention');
  assert.notEqual(modeResult.status, 'confirmed');
});

test('rejects executable-mode edits before creating the branch', async () => {
  const oldContent = 'old script\n';
  const fixture = createPublisherFixture({
    manifest: { allowedPaths: ['scripts/example.mjs'] },
    proposedChanges: [{
      operation: 'modify',
      path: 'scripts/example.mjs',
      content: 'new script\n',
      expectedBlobSha: gitBlobSha(oldContent),
    }],
    baseTree: [
      { path: 'scripts', mode: '040000', type: 'tree', sha: '8'.repeat(40) },
      {
        path: 'scripts/example.mjs',
        mode: '100755',
        type: 'blob',
        sha: gitBlobSha(oldContent),
      },
    ],
  });
  const result = await publish(fixture.request, fixture.dependencies);
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.reason, 'unsupported_file_mode');
  assert.equal(fixture.state.branchWrites, 0);
  assert.equal(fixture.state.commitWrites, 0);
});

test('reconciles partial GraphQL success from the exact branch, parent, tree, and signer', async () => {
  const fixture = createPublisherFixture({ partialGraphqlSuccess: true });
  const result = await publish(fixture.request, fixture.dependencies);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.commitSha, COMMIT_SHA);
  assert.equal(fixture.state.commitWrites, 1);
});

test('rejects extra tree changes and signing mismatches during commit reconciliation', async () => {
  const extraPath = createPublisherFixture({ extraPath: 'src/unapproved.txt' });
  const extraResult = await publish(extraPath.request, extraPath.dependencies);
  assert.equal(extraResult.status, 'needs_attention');
  assert.equal(extraPath.state.commitWrites, 1);

  const proofUnavailable = createPublisherFixture({ proofErrors: true });
  const proofResult = await publish(proofUnavailable.request, proofUnavailable.dependencies);
  assert.equal(proofResult.status, 'needs_attention');
  assert.equal(proofUnavailable.state.commitWrites, 1);
});

test('bounds hanging token, approval, and fence callbacks by the same deadline', async () => {
  for (const options of [
    { hangContext: true },
    { hangApproval: true },
    { hangFencePhase: 'branch' },
  ]) {
    const fixture = createPublisherFixture({ ...options, timeoutMs: 10 });
    const result = await publish(fixture.request, fixture.dependencies);
    assert.equal(result.status, 'needs_attention');
    assert.equal(result.reason, 'deadline_exceeded');
    assert.equal(fixture.state.branchWrites, 0);
    assert.equal(fixture.state.commitWrites, 0);
  }
});

test('rejects oversized complete-tree responses before a write', async () => {
  const fixture = createPublisherFixture({ oversizedTree: true });
  const result = await publish(fixture.request, fixture.dependencies);
  assert.equal(result.status, 'needs_attention');
  assert.equal(fixture.state.branchWrites, 0);
  assert.equal(fixture.state.commitWrites, 0);
});

test('does not expose GitHub error bodies, tokens, or proposed content in safe outcomes', async () => {
  const fixture = createPublisherFixture({
    loseCommitAck: true,
    commitDoesNotApply: true,
  });
  const result = await publish(fixture.request, fixture.dependencies);
  const output = JSON.stringify(result);
  assert.equal(output.includes(TOKEN), false);
  assert.equal(output.includes('private'), false);
  assert.equal(output.includes(CHANGE_CONTENT), false);
  assert.equal(result.status, 'needs_attention');
});

test('rejects redirects without forwarding the App token or following the redirect', async () => {
  const fixture = createPublisherFixture({ redirectPath: '/repos/randoneering/mellon' });
  const result = await publish(fixture.request, fixture.dependencies);
  assert.equal(result.status, 'needs_attention');
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].redirect, 'manual');
  assert.equal(new URL(fixture.calls[0].url).origin, 'https://api.github.com');
  assert.equal(fixture.state.branchWrites, 0);
});

test('bounds the aggregate deadline across repository reads and hanging fetches', async () => {
  const fixture = createPublisherFixture({
    hangPath: '/repos/randoneering/mellon',
    timeoutMs: 10,
  });
  const result = await publish(fixture.request, fixture.dependencies);
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.reason, 'deadline_exceeded');
  assert.equal(fixture.state.branchWrites, 0);
  assert.equal(fixture.state.commitWrites, 0);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('probe is read-only and reports exact confirmed or absent branch state', async () => {
  const confirmedFixture = createPublisherFixture({ initialBranchHead: COMMIT_SHA });
  const confirmedResult = await probePublication(
    confirmedFixture.request,
    confirmedFixture.dependencies,
  );
  assert.equal(confirmedResult.status, 'confirmed');
  assert.equal(confirmedResult.commitSha, COMMIT_SHA);
  assert.equal(writes(confirmedFixture).length, 0);

  const absentFixture = createPublisherFixture();
  const absentResult = await probePublication(absentFixture.request, absentFixture.dependencies);
  assert.equal(absentResult.status, 'needs_attention');
  assert.equal(absentResult.reason, 'branch_absent');
  assert.equal(writes(absentFixture).length, 0);
});

function prWrites(fixture) {
  return fixture.calls.filter(call => call.method !== 'GET' && call.url !== 'https://api.github.com/graphql');
}

async function createdFixture() {
  const fixture = createDraftPrFixture();
  assert.equal((await ensureDraftPr(fixture.request, fixture.dependencies)).status, 'confirmed');
  return fixture;
}

test('draft PR creation requires initial green, rechecks head/approval/fence, and writes only one draft', async () => {
  const fixture = createDraftPrFixture();
  const result = await ensureDraftPr(fixture.request, fixture.dependencies);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.prNumber, 31);
  assert.equal(result.prId, 8001);
  assert.equal(result.prCount, 1);
  assert.equal(result.headSha, COMMIT_SHA);
  assert.equal(result.draft, true);
  assert.equal(result.branch, fixture.branch);
  assert.match(result.inputHash, /^[a-f0-9]{64}$/);
  assert.equal(fixture.state.lastFence.kind, 'pr_create');
  assert.deepEqual(fixture.state.events.slice(fixture.state.events.indexOf('checks'),
    fixture.state.events.indexOf('create') + 1), ['checks', 'head', 'approval', 'fence:pr', 'create']);
  assert.equal(fixture.state.checkArgs.run.expectedHeadSha, COMMIT_SHA);
  assert.equal(fixture.state.checkArgs.branch, fixture.branch);
  assert.ok(fixture.state.checkArgs.signal instanceof AbortSignal);
  assert.ok(Number.isSafeInteger(fixture.state.checkArgs.deadline));
  assert.deepEqual(Object.keys(fixture.state.createdBody).sort(), ['base', 'body', 'draft', 'head', 'title']);
  assert.equal(fixture.state.createdBody.draft, true);
  assert.equal(fixture.state.createdBody.base, 'main');
  assert.equal(fixture.state.createdBody.head, `randoneering:${fixture.branch}`);
  for (const heading of PR_TEMPLATE.split('\n').filter(line => line.startsWith('## '))) {
    assert.ok(fixture.state.createdBody.body.includes(heading));
  }
  assert.match(fixture.state.createdBody.body, /https:\/\/github.com\/randoneering\/mellon\/issues\/21/);
  assert.match(fixture.state.createdBody.body, new RegExp(COMMIT_SHA));
  assert.doesNotMatch(JSON.stringify(fixture.state.createdBody), /\b(close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+#?\d/i);
  assert.deepEqual(prWrites(fixture).map(call => [call.method, new URL(call.url).pathname]),
    [['POST', '/repos/randoneering/mellon/pulls']]);
  assert.ok(fixture.calls.every(call => new URL(call.url).origin === 'https://api.github.com'
    && call.redirect === 'manual'));
  for (const call of fixture.calls) {
    if (call.url === 'https://api.github.com/graphql') {
      const document = JSON.parse(call.body).query;
      assert.match(document, /^query AgentWorkerCommitProof/);
      assert.doesNotMatch(document, /mutation|addComment|mergePullRequest|markPullRequestReadyForReview/);
    } else if (call.method !== 'GET') {
      assert.equal(call.url, 'https://api.github.com/repos/randoneering/mellon/pulls');
      assert.equal(call.method, 'POST');
    }
  }
  assert.equal(fixture.state.prs[0].draft, true);
  assert.equal(fixture.state.branchWrites, 0);
  assert.equal(fixture.state.commitWrites, 0);
  assert.doesNotMatch(JSON.stringify(result), /fixture-token|private|What does this/);
});

test('uncertain draft creation is reconciled from exact remote identity without another POST', async () => {
  const fixture = createDraftPrFixture({ losePrAck: true });
  const result = await ensureDraftPr(fixture.request, fixture.dependencies);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.prCount, 1);
  assert.equal(fixture.state.prWrites, 1);
  assert.equal(fixture.state.prs.length, 1);
  assert.ok(fixture.state.events.slice(fixture.state.events.indexOf('create')).includes('list'));
  assert.equal((await ensureDraftPr(fixture.request, fixture.dependencies)).status, 'confirmed');
  assert.equal(fixture.state.prWrites, 1);
});

test('an existing exact PR reconciles read-only even when checks are now unavailable', async () => {
  const fixture = await createdFixture();
  fixture.dependencies.checkInitialChecks = () => { throw new Error('must not request new green'); };
  fixture.dependencies.checkFence = async args => ({ ...args, decision: 'reconcile_only' });
  fixture.calls.length = 0;
  const result = await ensureDraftPr(fixture.request, fixture.dependencies);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.prCount, 1);
  assert.equal(prWrites(fixture).length, 0);
});

for (const [name, mutate] of [
  ['base branch', pr => { pr.base.ref = 'release'; }],
  ['base commit', pr => { pr.base.sha = '9'.repeat(40); }],
  ['head commit', pr => { pr.head.sha = BASE_SHA; }],
  ['head branch', pr => { pr.head.ref = 'main'; }],
  ['owner', pr => { pr.head.repo.owner.login = 'someone'; }],
  ['repository', pr => { pr.head.repo.id += 1; }],
  ['actor', pr => { pr.user.id += 1; }],
  ['actor login', pr => { pr.user.login = 'another[bot]'; }],
  ['run marker', pr => { pr.body = pr.body.replace(RUN_ID, '00000000-0000-4000-8000-000000000001'); }],
  ['summary injection', pr => { pr.body += '\nFixes #21'; }],
  ['title', pr => { pr.title = 'untrusted'; }],
  ['non-draft', pr => { pr.draft = false; }],
  ['closed', pr => { pr.state = 'closed'; }],
  ['merged', pr => { pr.merged_at = new Date().toISOString(); }],
]) {
  test(`existing PR with mismatched ${name} blocks writes and confirmation`, async () => {
    const fixture = await createdFixture();
    mutate(fixture.state.prs[0]);
    fixture.calls.length = 0;
    const result = await ensureDraftPr(fixture.request, fixture.dependencies);
    assert.equal(result.status, 'needs_attention');
    assert.equal(prWrites(fixture).length, 0);
  });
}

test('duplicate PR identities never produce exact-count success or another creation', async () => {
  const fixture = await createdFixture();
  fixture.state.prs.push(structuredClone(fixture.state.prs[0]));
  fixture.calls.length = 0;
  const result = await ensureDraftPr(fixture.request, fixture.dependencies);
  assert.equal(result.status, 'needs_attention');
  assert.equal(prWrites(fixture).length, 0);
});

for (const [name, mutate] of [
  ['waiting', value => { value.status = 'waiting'; }],
  ['red', value => { value.status = 'intended_red'; }],
  ['stale', value => { value.headSha = BASE_SHA; }],
  ['foreign repository', value => { value.repositoryId += 1; }],
  ['foreign branch', value => { value.branch = 'main'; }],
  ['foreign event', value => { value.event = 'pull_request'; }],
  ['missing workflow', value => { value.runs = []; }],
  ['duplicate workflow', value => { value.runs.push(value.runs[0]); }],
  ['wrong workflow', value => { value.runs[0].workflowId += 1; }],
  ['invalid run ID', value => { value.runs[0].runId = 0; }],
  ['invalid attempt', value => { value.runs[0].runAttempt = 0; }],
  ['stale workflow', value => { value.runs[0].headSha = BASE_SHA; }],
  ['missing check', value => { value.checks = []; }],
  ['duplicate check', value => { value.checks.push(value.checks[0]); }],
  ['wrong App', value => { value.runs[0].checks[0].appId += 1; }],
  ['stale check', value => { value.runs[0].checks[0].headSha = BASE_SHA; }],
  ['pending check', value => { value.runs[0].checks[0].status = 'in_progress'; }],
  ['red check', value => { value.runs[0].checks[0].conclusion = 'failure'; }],
  ['missing suite', value => { delete value.runs[0].checks[0].checkSuiteId; }],
  ['different flattened evidence', value => { value.checks[0] = { ...value.checks[0], checkRunId: 999 }; }],
]) {
  test(`initial ${name} evidence cannot authorize draft creation`, async () => {
    const fixture = createDraftPrFixture({ checks: value => { mutate(value); return value; } });
    const result = await ensureDraftPr(fixture.request, fixture.dependencies);
    assert.equal(result.status, 'needs_attention');
    assert.equal(fixture.state.prWrites, 0);
  });
}

for (const [name, mutate] of [
  ['missing issuance', value => { delete value.installationToken; }],
  ['unknown issuance key', value => { value.installationToken.raw = TOKEN; }],
  ['wrong repository', value => { value.installationToken.repositoryId += 1; }],
  ['wrong name', value => { value.installationToken.repositoryName = 'someone/mellon'; }],
  ['wrong App', value => { value.installationToken.appId += 1; }],
  ['wrong installation', value => { value.installationToken.installationId += 1; }],
  ['wrong token hash', value => { value.installationToken.tokenSha256 = '0'.repeat(64); }],
  ['wrong expiry', value => { value.installationToken.tokenExpiresAt = new Date(0).toISOString(); }],
  ['expired context', value => { value.publicationContext.contextExpiresAt = new Date(0).toISOString(); }],
  ['read-only PR scope', value => { value.installationToken.permissions.pull_requests = 'read'; }],
  ['unconfirmed permission', value => { value.installationToken.permissions.pull_requests = true; }],
  ['unsupported scope', value => { value.installationToken.permissions.administration = 'write'; }],
]) {
  test(`trusted token context with ${name} fails before any remote write`, async () => {
    const fixture = createDraftPrFixture({ prContext: value => { mutate(value); return value; } });
    const result = await ensureDraftPr(fixture.request, fixture.dependencies);
    assert.equal(result.status, 'needs_attention');
    assert.equal(fixture.state.prWrites, 0);
    assert.equal(fixture.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /fixture-token|private|administration/);
  });
}

for (const options of [
  { moveAfterChecks: true }, { revokeBeforeWrite: true },
  { fenceDecisions: { pr: 'reconcile_only' } }, { fenceDecisions: { probe: 'reconcile_only' } },
  { fenceOverride: { kind: 'commit_create' } }, { template: 'Fixes #21\n' },
  { listFailure: true }, { prRedirect: true },
]) {
  test(`draft creation fails closed at boundary ${JSON.stringify(options)}`, async () => {
    const fixture = createDraftPrFixture(options);
    const result = await ensureDraftPr(fixture.request, fixture.dependencies);
    assert.equal(result.status, 'needs_attention');
    assert.equal(fixture.state.prWrites, 0);
    assert.doesNotMatch(JSON.stringify(result), /fixture-token|private/);
  });
}

test('uncertain creation with no observable PR is never repeated within the call or reconciliation-only retry', async () => {
  const fixture = createDraftPrFixture({ losePrAck: true, prDoesNotApply: true });
  assert.equal((await ensureDraftPr(fixture.request, fixture.dependencies)).status, 'needs_attention');
  fixture.dependencies.checkFence = async args => ({ ...args, decision: 'reconcile_only' });
  assert.equal((await ensureDraftPr(fixture.request, fixture.dependencies)).status, 'needs_attention');
  assert.equal(fixture.state.prWrites, 1);
});

test('a successful creation response alone cannot confirm a mismatched remote PR', async () => {
  const fixture = createDraftPrFixture({ createdPr: pr => ({ ...pr, draft: false }) });
  assert.equal((await ensureDraftPr(fixture.request, fixture.dependencies)).status, 'needs_attention');
  assert.equal(fixture.state.prWrites, 1);
});

test('PR reads use bounded static pagination and do not accept a partial exact-count result', async () => {
  const fixture = createDraftPrFixture({ prPage: () => new Response(JSON.stringify([]), {
    headers: { link: '<https://evil.invalid/>; rel="next"' },
  }) });
  assert.equal((await ensureDraftPr(fixture.request, fixture.dependencies)).status, 'needs_attention');
  const lists = fixture.calls.filter(call => new URL(call.url).pathname.endsWith('/pulls'));
  assert.equal(lists.length, 3);
  assert.ok(lists.every(call => new URL(call.url).searchParams.get('head') === `randoneering:${fixture.branch}`));
  assert.ok(lists.every(call => new URL(call.url).searchParams.get('state') === 'all'));
  assert.equal(fixture.state.prWrites, 0);
});

for (const option of ['hangPrContext', 'hangChecks', 'hangPrList']) {
  test(`one aggregate deadline bounds ${option} without exposing errors`, async () => {
    const fixture = createDraftPrFixture({ [option]: true, timeoutMs: 25 });
    const result = await ensureDraftPr(fixture.request, fixture.dependencies);
    assert.equal(result.reason, 'deadline_exceeded');
    assert.equal(fixture.state.prWrites, 0);
  });
}

test('PR input rejects model/request-supplied checks, summaries, token records, and operation kind changes', async () => {
  for (const mutate of [
    request => { request.checks = { status: 'success' }; },
    request => { request.body = 'Fixes #21'; },
    request => { request.installationToken = {}; },
    request => { request.intent.kind = 'commit_create'; },
    request => { request.run.expectedHeadSha = request.run.baseSha; },
  ]) {
    const fixture = createDraftPrFixture();
    mutate(fixture.request);
    assert.equal((await ensureDraftPr(fixture.request, fixture.dependencies)).reason, 'invalid_input');
    assert.equal(fixture.calls.length, 0);
  }
});

for (const phase of ['branch', 'commit', 'pr']) {
  test(`a suspended ${phase} owner cannot dispatch after its fenced deadline`, () => {
    const probe = new URL('../fixtures/agent-worker-publication-deadline.mjs', import.meta.url);
    const child = spawnSync(process.execPath, [fileURLToPath(probe), phase], {
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0);
    assert.equal(child.stderr, '');
    assert.deepEqual(JSON.parse(child.stdout), {
      status: 'needs_attention', reason: 'deadline_exceeded',
      branchWrites: phase === 'commit' ? 1 : 0, commitWrites: 0,
      prWrites: 0, unhandled: 0,
    });
  });
}

test('a fired deadline stays expired even before the wall clock advances', async t => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const fixture = createPublisherFixture({ hangApproval: true, timeoutMs: 10 });
  const result = await publish(fixture.request, fixture.dependencies);
  assert.equal(result.reason, 'deadline_exceeded');
  assert.equal(fixture.state.commitWrites, 0);
});

test('publication manifest passes V2 check-reader admission before remote evidence reads', async () => {
  const fixture = createDraftPrFixture();
  const manifest = fixture.request.approvedManifest;
  const reader = createCheckReader({ token: TOKEN, repository: 'randoneering/mellon',
    fetch: async () => { throw new Error('Controlled unavailable transport.'); } });
  const result = await reader.readChecks({
    run: { headSha: COMMIT_SHA, branch: fixture.branch, runId: 77, runAttempt: 1 },
    manifest: { repository: manifest.repository, requiredChecks: manifest.requiredChecks,
      requiredWorkflowIdentities: manifest.requiredWorkflowIdentities },
  });
  assert.equal(result.reason, 'github_read_failed');
  assert.equal((await ensureDraftPr(fixture.request, fixture.dependencies)).status, 'confirmed');
});

test('multiple approved workflows require complete distinct successful evidence', async () => {
  const { sha256 } = await import('../../src/automation/worker/publication-validation.mjs');
  const canonical = value => value !== null && typeof value === 'object'
    ? Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
      : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
  const fixture = createDraftPrFixture({ checks: value => {
    delete value.runId;
    delete value.runAttempt;
    const check = { ...value.checks[0], checkRunId: 503, checkSuiteId: 603 };
    const reportCheck = { ...value.checks[1], checkRunId: 504, checkSuiteId: 604 };
    value.runs.push({ workflowId: 399609444, runId: 78, runAttempt: 1,
      headSha: COMMIT_SHA, checks: [check, reportCheck],
      diagnostic: structuredClone(value.runs[0].diagnostic) });
    value.checks.push(check, reportCheck);
    return value;
  } });
  const manifest = fixture.request.approvedManifest;
  manifest.requiredWorkflowIdentities.push({ ...manifest.requiredWorkflowIdentities[0], id: 399609444 });
  manifest.requiredChecks.push(
    { context: 'lint', appId: 15368, workflowId: 399609444 },
    { context: 'test-report', appId: 15368, workflowId: 399609444 },
  );
  fixture.request.run.manifestSha256 = sha256(canonical(manifest));
  const result = await ensureDraftPr(fixture.request, fixture.dependencies);
  assert.equal(result.status, 'confirmed');
  assert.match(fixture.state.createdBody.body, /4 required checks across 2 approved push workflows/);
  assert.equal(fixture.state.prWrites, 1);
});

for (const [name, options] of [
  ['foreign signed history', { wrongActor: true }],
  ['unsigned history', { wrongSignature: true }],
  ['unknown PR collection', { prPage: () => new Response('{}') }],
  ['oversized PR response', { prPage: () => new Response('', {
    headers: { 'content-length': String(4 * 1024 * 1024 + 1) },
  }) }],
  ['foreign fence generation', { fenceOverride: { generation: 2 } }],
  ['foreign fence hash', { fenceOverride: { operationHash: '0'.repeat(64) } }],
  ['foreign fence head', { fenceOverride: { expectedHeadSha: BASE_SHA } }],
  ['foreign fence intent', { fenceOverride: { intentId: '0'.repeat(64) } }],
]) {
  test(`${name} cannot authorize PR creation`, async () => {
    const fixture = createDraftPrFixture(options);
    assert.equal((await ensureDraftPr(fixture.request, fixture.dependencies)).status, 'needs_attention');
    assert.equal(fixture.state.prWrites, 0);
  });
}

test('uncertain creation cannot reconcile a foreign actor or an ambiguous remote count', async () => {
  for (const corrupt of [
    pr => { pr.user.id += 1; },
    (pr, fixture) => { fixture.state.prs.push(structuredClone(pr)); },
  ]) {
    const fixture = createDraftPrFixture({ losePrAck: true });
    const fetch = fixture.dependencies.fetch;
    fixture.dependencies.fetch = async (...args) => {
      try { return await fetch(...args); } finally {
        if (fixture.state.prWrites === 1 && !fixture.state.corrupted) {
          fixture.state.corrupted = true;
          corrupt(fixture.state.prs[0], fixture);
        }
      }
    };
    const result = await ensureDraftPr(fixture.request, fixture.dependencies);
    assert.equal(result.status, 'needs_attention');
    assert.equal(fixture.state.prWrites, 1);
    assert.doesNotMatch(JSON.stringify(result), /fixture-token|private/);
  }
});

test('a deadline after an uncertain write stops without repeating creation', async () => {
  const fixture = createDraftPrFixture({ timeoutMs: 25 });
  const fetch = fixture.dependencies.fetch;
  fixture.dependencies.fetch = async (url, init) => {
    if (init.method === 'POST' && new URL(url).pathname.endsWith('/pulls')) {
      fixture.state.prWrites += 1;
      return new Promise(() => {});
    }
    return fetch(url, init);
  };
  const result = await ensureDraftPr(fixture.request, fixture.dependencies);
  assert.equal(result.reason, 'deadline_exceeded');
  assert.equal(fixture.state.prWrites, 1);
});

test('new PR callbacks remain mandatory and cannot fall back to the commit context', async () => {
  for (const missing of ['getPullRequestContext', 'checkInitialChecks', 'checkApproval', 'checkFence']) {
    const fixture = createDraftPrFixture();
    delete fixture.dependencies[missing];
    assert.equal((await ensureDraftPr(fixture.request, fixture.dependencies)).reason, 'callbacks_missing');
    assert.equal(fixture.calls.length, 0);
  }
});

test('synthetic publication context uses one bounded expiry even across clock ticks', t => {
  const now = Date.now();
  let tick = 0;
  t.mock.method(Date, 'now', () => now + tick++);
  const { context } = createPublisherFixture();
  assert.ok(Date.parse(context.signingPreflight.expiresAt) <= Date.parse(context.contextExpiresAt));
});
