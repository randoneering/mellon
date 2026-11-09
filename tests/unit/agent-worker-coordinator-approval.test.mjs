import assert from 'node:assert/strict';
import test from 'node:test';
import { checkApproval } from '../../src/automation/worker/approval.mjs';
import { manifest, canonical, hash, HEAD, fakeApi } from '../fixtures/worker-candidates/inputs.mjs';
const root = '/repos/randoneering/mellon';
function request(approved) {
  const api = fakeApi({
    [`${root}/issues/22`]: { id: 9001, number: 22, repository_url: 'https://api.github.com' + root, state: 'open', title: 'approved title', body: 'approved body' },
    [`${root}/issues/22/labels?per_page=100&page=1`]: [{ name: 'agent: ready' }],
    '/users/maintainer': { id: 42, login: 'maintainer', type: 'User' },
    [`${root}/collaborators/maintainer/permission`]: { permission: 'write', user: { id: 42, login: 'maintainer', type: 'User' } },
    [`${root}/branches/main`]: { name: 'main', commit: { sha: HEAD } },
  });
  return { manifest: approved, expectedManifestSha256: hash(canonical(approved)), token: 'synthetic-token', fetch: api.fetch };
}
test('approval accepts an externally pinned closed coordinator selection', async () => {
  assert.equal((await checkApproval(request(manifest()))).authorized, true);
});
test('approval accepts an explicitly pinned GitHub submitted-review identity profile', async () => {
  const approved = manifest();
  approved.qodoIdentities = [{ userId: 151058649, appId: 484649,
    appSlug: 'qodo-code-review', completion: 'github-submitted-review-v1' }];
  assert.equal((await checkApproval(request(approved))).authorized, true);
});

for (const [name, changes] of [
  ['wrong profile', { completion: 'silence-is-clean' }],
  ['wrong App slug', { appSlug: 'another-app' }],
  ['extra authority', { allowUnknown: true }],
]) test(`approval rejects submitted-review ${name}`, async () => {
  const approved = manifest();
  approved.qodoIdentities = [{ userId: 151058649, appId: 484649,
    appSlug: 'qodo-code-review', completion: 'github-submitted-review-v1', ...changes }];
  assert.equal((await checkApproval(request(approved))).authorized, false);
});

test('approval still accepts foundation manifests with no coordinator block', async () => {
  const approved = manifest(); delete approved.coordinator;
  assert.equal((await checkApproval(request(approved))).authorized, true);
});
for (const [name, mutate] of Object.entries({
  'extra coordinator field': m => { m.coordinator.extra = true; },
  'extra selection field': m => { m.coordinator.regression.claim = 'model'; },
  'extra initial field': m => { m.coordinator.regression.initial.hash = 'f'.repeat(64); },
  'unknown version': m => { m.coordinator.version = 2; },
  'negative criterion index': m => { m.coordinator.regression.initial.criterionIndex = -1; },
  'criterion out of bounds': m => { m.coordinator.regression.initial.criterionIndex = 1; },
  'test index out of bounds': m => { m.coordinator.regression.testPathIndex = 2; },
  'non test path': m => { m.coordinator.regression.testPathIndex = 1; },
  'protected test path': m => { m.allowedPaths[0] = 'automation/hidden.test.mjs'; },
  'unapproved workflow': m => { m.coordinator.regression.workflowId = 99; },
  'missing native test check': m => { m.requiredChecks[0].context = 'ci/test'; },
  'missing mandatory reporter': m => { m.requiredChecks.pop(); },
  'duplicate pinned names': m => { m.coordinator.regression.repairTestNames[0] = m.coordinator.regression.initial.testName; },
  'missing reserved name': m => { m.coordinator.regression.repairTestNames.pop(); },
  'control name': m => { m.coordinator.regression.initial.testName += '\n'; },
  'annotation marker name': m => { m.coordinator.regression.initial.testName += '::notice::'; },
  'excess literal name': m => { m.coordinator.regression.initial.testName = 'x'.repeat(501); },
})) test(`approval rejects coordinator ${name}`, async () => {
  const approved = manifest(); mutate(approved);
  assert.equal((await checkApproval(request(approved))).authorized, false);
});
test('approval coordinator config cannot change beneath external manifest pin', async () => {
  const input = request(manifest()); input.manifest.coordinator.regression.initial.testName = 'new name';
  assert.equal((await checkApproval(input)).authorized, false);
});
