import { createHash } from 'node:crypto';
import { DATABASE_SKIP_POLICY_SHA256 } from '../../../automation/ci/report-annotations.mjs';
export const hash = text => createHash('sha256').update(text).digest('hex');
export const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
export const blob = text => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
export const HEAD = 'a'.repeat(40);
export const POLICY = 'b'.repeat(40);
export const RUN_ID = '12345678-1234-4123-8123-123456789abc';
export const PATH = 'tests/fixtures/worker-candidates/location.test.mjs';
export const SOURCE = "import test from 'node:test';\nimport assert from 'node:assert/strict';\n\ntest('approved regression location', () => {\n  assert.equal(1, 2);\n});\n";
export function manifest() {
  return {
    version: 1, approved: true, repository: { name: 'randoneering/mellon', id: 123456 },
    issue: { id: 9001, number: 22, contentSha256: hash(JSON.stringify(['approved title', 'approved body'])) },
    approver: { id: 42, login: 'maintainer' }, base: { branch: 'main', revision: HEAD }, policyRevision: POLICY,
    pilotScope: { kind: 'bounded-public-issue', maxChangedFiles: 10, maxFileBytes: 65536, maxTotalBytes: 262144 },
    allowedPaths: [PATH, 'src/parser.mjs'], acceptanceCriteria: ['Exact approved criterion.'],
    requiredChecks: [{ context: 'test', appId: 2000, workflowId: 3000 }, { context: 'test-report', appId: 2000, workflowId: 3000 }],
    requiredWorkflowIdentities: [{ id: 3000, path: '.github/workflows/test.yml', sha256: 'd'.repeat(64), appId: 2000, event: 'push', diagnostics: {
      version: 2, skipPolicy: { version: 1, sha256: DATABASE_SKIP_POLICY_SHA256 },
      sources: ['automation/ci/guard-command.mjs', 'automation/ci/run-tests.mjs', 'automation/ci/test-reporter.mjs', 'automation/ci/report-annotations.mjs', 'scripts/lib/output-guard.mjs', 'package.json'].map((path, i) => ({ path, sha256: String(i + 1).repeat(64) })),
      reporter: { context: 'test-report', revision: 'c'.repeat(40), sha256: '7'.repeat(64) },
    } }],
    model: { id: 'approved-model' }, qodoIdentities: [{ userId: 4000 }],
    limits: { nonterminalPilotRuns: 1, modelCallsPerTick: 1, modelCallsPerRun: 20, inputTokensPerCall: 8000, outputTokensPerCall: 2000, inputTokensPerRun: 100000, outputTokensPerRun: 20000, tickDeadlineSeconds: 90, modelCallDeadlineSeconds: 45, leaseSeconds: 180, expiredLeaseRecoveries: 2, ciWaitSeconds: 1800, reviewWaitSeconds: 1800, runLifetimeSeconds: 7200, repairCycles: 2 },
    coordinator: { version: 1, regression: { workflowId: 3000, testPathIndex: 0, initial: { criterionIndex: 0, testName: 'approved regression location' }, repairTestNames: ['approved repair one', 'approved repair two'] } },
  };
}
export function phaseFor(run, purpose = 'initial_tests', repairCycle = 0, findingSha256 = null) {
  const values = { version: 1, runId: run.id, manifestSha256: run.manifestSha256, purpose, repairCycle, headSha: run.expectedHeadSha, findingSha256 };
  return { version: 1, key: hash(canonical(values)), purpose, repairCycle, headSha: run.expectedHeadSha, findingSha256 };
}
export function candidateInput() {
  const approvedManifest = manifest();
  const publicationRun = { id: RUN_ID, repositoryId: 123456, issueId: 9001, issueNumber: 22, approverId: 42, manifestSha256: hash(canonical(approvedManifest)), baseSha: HEAD, expectedHeadSha: HEAD, generation: 1 };
  return {
    publicationRun,
    phase: phaseFor(publicationRun),
    approvedManifest, modelOperationId: '11111111-1111-4111-8111-111111111111',
    changes: [{ operation: 'create', path: PATH, content: SOURCE }],
    baseFiles: [{ path: 'tests', mode: '040000', blobSha: null }, { path: 'tests/fixtures', mode: '040000', blobSha: null }, { path: 'tests/fixtures/worker-candidates', mode: '040000', blobSha: null }, { path: PATH, mode: null, blobSha: null }, { path: 'src', mode: '040000', blobSha: null }, { path: 'src/parser.mjs', mode: null, blobSha: null }],
  };
}
export function fakeApi(routes, mutate) {
  const calls = [];
  const fetch = async (url, options) => {
    const parsed = new URL(url);
    assertRequest(parsed, options);
    calls.push(parsed.pathname + parsed.search);
    const key = parsed.pathname + parsed.search;
    let result = key === '/repos/randoneering/mellon' ? { id: 123456, full_name: 'randoneering/mellon', private: false } : routes[key];
    if (mutate) result = mutate(key, result);
    if (result instanceof Response) return result;
    if (result === undefined) throw new Error('Unexpected fixed resource');
    return new Response(JSON.stringify(result));
  };
  return { fetch, calls };
}
function assertRequest(url, options) {
  if (url.origin !== 'https://api.github.com' || options.redirect !== 'manual'
    || !options.signal || !['GET', 'POST'].includes(options.method)) throw new Error('Unsafe request');
}
export function repositoryConfig(api) {
  return { token: 'synthetic-token', repository: 'randoneering/mellon', repositoryId: 123456, policyRevision: POLICY, trustedPaths: [], fetch: api.fetch };
}
