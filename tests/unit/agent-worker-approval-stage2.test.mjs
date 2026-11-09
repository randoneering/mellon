import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { DATABASE_SKIP_POLICY_SHA256 } from '../../automation/ci/report-annotations.mjs';
import { checkApproval } from '../../src/automation/worker/approval.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const json = value => new Response(JSON.stringify(value), { status: 200 });

function manifest() {
  const title = 'Stage two';
  const body = 'Approve the worker policy.';
  return {
    version: 1, approved: true,
    repository: { name: 'randoneering/mellon', id: 123456 },
    issue: { id: 9001, number: 21, contentSha256: hash(JSON.stringify([title, body])) },
    approver: { id: 42, login: 'maintainer' },
    base: { branch: 'main', revision: 'a'.repeat(40) },
    policyRevision: 'b'.repeat(40),
    pilotScope: { kind: 'bounded-public-issue', maxChangedFiles: 10, maxFileBytes: 65536, maxTotalBytes: 262144 },
    allowedPaths: ['scripts/personalized-detection.mjs', 'tests/unit/stage.test.mjs'],
    acceptanceCriteria: ['Check the bounded workflow.'],
    requiredChecks: [
      { context: 'ci/test', appId: 2000, workflowId: 3000 },
      { context: 'test-report', appId: 2000, workflowId: 3000 },
      { context: 'test', appId: 2000, workflowId: 3000 },
    ],
    requiredWorkflowIdentities: [{ id: 3000, path: '.github/workflows/test.yml', sha256: 'd'.repeat(64), appId: 2000, event: 'push', diagnostics: {
      version: 2, skipPolicy: { version: 1, sha256: DATABASE_SKIP_POLICY_SHA256 },
      sources: [
        'automation/ci/guard-command.mjs', 'automation/ci/run-tests.mjs',
        'automation/ci/test-reporter.mjs', 'automation/ci/report-annotations.mjs',
        'scripts/lib/output-guard.mjs', 'package.json',
      ].map((path, index) => ({ path, sha256: String(index + 1).repeat(64) })),
      reporter: { context: 'test-report', revision: 'c'.repeat(40), sha256: '7'.repeat(64) },
    } }],
    model: { id: 'approved-model' },
    qodoIdentities: [{ userId: 4000, appId: 5000, appSlug: 'qodo-code-review', completion: 'github-submitted-review-v1' }],
    limits: {
      nonterminalPilotRuns: 1, modelCallsPerTick: 1, modelCallsPerRun: 20,
      inputTokensPerCall: 8000, outputTokensPerCall: 2000,
      inputTokensPerRun: 100000, outputTokensPerRun: 20000,
      tickDeadlineSeconds: 90, modelCallDeadlineSeconds: 45, leaseSeconds: 180,
      expiredLeaseRecoveries: 2, ciWaitSeconds: 1800, reviewWaitSeconds: 1800,
      runLifetimeSeconds: 7200, repairCycles: 2,
    },
    coordinator: { version: 1, regression: {
      workflowId: 3000, testPathIndex: 1,
      initial: { criterionIndex: 0, testName: 'test bounded behavior' },
      repairTestNames: ['test repair one', 'test repair two'],
    } },
    reviewPolicy: { version: 1, profile: 'worker-command-maintainer-fallback-v1' },
  };
}

function responseFor(url) {
  const path = new URL(url).pathname;
  const responses = new Map([
    ['/repos/randoneering/mellon', { id: 123456, full_name: 'randoneering/mellon', private: false }],
    ['/repos/randoneering/mellon/issues/21', { id: 9001, number: 21,
      repository_url: 'https://api.github.com/repos/randoneering/mellon', state: 'open',
      title: 'Stage two', body: 'Approve the worker policy.',
      user: { id: 7, login: 'contributor', type: 'User' } }],
    ['/repos/randoneering/mellon/issues/21/labels', [{ name: 'AGENT: READY' }]],
    ['/users/maintainer', { id: 42, login: 'maintainer', type: 'User' }],
    ['/repos/randoneering/mellon/collaborators/maintainer/permission',
      { permission: 'write', user: { id: 42, login: 'maintainer', type: 'User' } }],
    ['/repos/randoneering/mellon/branches/main', { name: 'main', commit: { sha: 'a'.repeat(40) } }],
  ]);
  if (!responses.has(path)) throw new Error(`Unexpected fixture request ${path}`);
  return responses.get(path);
}

test('accepts the closed versioned worker review policy only with full coordinator identity', async () => {
  const value = manifest();
  const request = {
    manifest: value,
    expectedManifestSha256: hash(canonical(value)),
    token: 'synthetic-token',
    fetch: async url => json(responseFor(url)),
  };
  const result = await checkApproval(request);
  assert.equal(result.authorized, true, result.reason);
  assert.equal(result.evidence.manifestSha256, request.expectedManifestSha256);
});

test('fails closed on unknown fields in the opt-in review policy', async () => {
  const value = manifest();
  value.reviewPolicy.extra = true;
  const result = await checkApproval({
    manifest: value, expectedManifestSha256: hash(canonical(value)), token: 'synthetic-token',
    fetch: async () => { throw new Error('must not read GitHub'); },
  });
  assert.equal(result.authorized, false);
  assert.equal(result.reason, 'manifest_invalid');
});
