import assert from 'node:assert/strict';
import test from 'node:test';
import { checkApproval } from '../../src/automation/worker/approval.mjs';
import { createCoordinator } from '../../src/automation/worker/coordinator.mjs';
import { harness } from '../fixtures/worker-coordinator/harness.mjs';
import { manifest, canonical, hash, HEAD, fakeApi } from '../fixtures/worker-candidates/inputs.mjs';

const SOL = { id: 'gpt-6-1-sol', reasoningEffort: 'high', renderer: 'neon-responses-gpt-6-1-sol-v1' };
const root = '/repos/randoneering/mellon';
function approvalInput(model, inputTokensPerCall = 8000) {
  const approved = manifest();
  approved.model = model;
  approved.limits.inputTokensPerCall = inputTokensPerCall;
  const api = fakeApi({
    [`${root}/issues/22`]: { id: 9001, number: 22, repository_url: 'https://api.github.com' + root,
      state: 'open', title: 'approved title', body: 'approved body' },
    [`${root}/issues/22/labels?per_page=100&page=1`]: [{ name: 'agent: ready' }],
    '/users/maintainer': { id: 42, login: 'maintainer', type: 'User' },
    [`${root}/collaborators/maintainer/permission`]: { permission: 'write',
      user: { id: 42, login: 'maintainer', type: 'User' } },
    [`${root}/branches/main`]: { name: 'main', commit: { sha: HEAD } },
  });
  return { manifest: approved, expectedManifestSha256: hash(canonical(approved)),
    token: 'synthetic-token', fetch: api.fetch };
}

test('approval binds Sol high reasoning and its exact renderer in the external manifest pin', async () => {
  assert.equal((await checkApproval(approvalInput({ ...SOL }))).authorized, true);
});

test('approval permits the raised reservation only with the explicitly approved MVP admission mode', async () => {
  assert.equal((await checkApproval(approvalInput({ ...SOL,
    inputAdmission: 'conservative-bytes-v1' }, 65536))).authorized, true);
  assert.equal((await checkApproval(approvalInput({ ...SOL }, 65536))).authorized, false);
  assert.equal((await checkApproval(approvalInput({ ...SOL,
    inputAdmission: 'conservative-bytes-v1' }, 65537))).authorized, false);
});

test('approval rejects an unknown input admission mode', async () => {
  assert.equal((await checkApproval(approvalInput({ ...SOL,
    inputAdmission: 'guess-the-tokenizer' }))).authorized, false);
});

for (const [name, change] of [
  ['missing effort', model => { delete model.reasoningEffort; }],
  ['wrong effort', model => { model.reasoningEffort = 'medium'; }],
  ['wrong renderer', model => { model.renderer = 'neon-chat-v1'; }],
  ['extra authority', model => { model.fallback = true; }],
]) test(`approval rejects Sol ${name}`, async () => {
  const model = { ...SOL }; change(model);
  assert.equal((await checkApproval(approvalInput(model))).authorized, false);
});

async function dependencies() {
  const h = await harness();
  const value = h.dependencies;
  value.manifest = structuredClone(value.manifest);
  value.manifest.model = { ...SOL };
  value.expectedManifestSha256 = hash(canonical(value.manifest));
  value.model = { ...value.model, config: { ...value.model.config,
    modelId: SOL.id, reasoningEffort: 'high' }, tokenizer: {
    modelId: SOL.id, renderer: SOL.renderer, reasoningEffort: 'high', countRendered: () => 512,
  } };
  return value;
}

test('coordinator accepts MVP admission without a fake counter only when the manifest and config agree', async () => {
  const value = await dependencies();
  value.manifest.model.inputAdmission = 'conservative-bytes-v1';
  value.manifest.limits.inputTokensPerCall = 65536;
  value.expectedManifestSha256 = hash(canonical(value.manifest));
  value.model.config.inputAdmission = 'conservative-bytes-v1';
  delete value.model.tokenizer;
  assert.equal(typeof createCoordinator(value).advanceTick, 'function');
  delete value.model.config.inputAdmission;
  assert.throws(() => createCoordinator(value), /configuration rejected/);
});

test('coordinator accepts an exactly bound Sol model and counter profile', async () => {
  assert.equal(typeof createCoordinator(await dependencies()).advanceTick, 'function');
});

for (const [name, change] of [
  ['effort', value => { value.model.config.reasoningEffort = 'medium'; }],
  ['counter renderer', value => { value.model.tokenizer.renderer = 'neon-chat-v1'; }],
  ['counter model', value => { value.model.tokenizer.modelId = 'another-model'; }],
  ['counter effort', value => { value.model.tokenizer.reasoningEffort = 'medium'; }],
]) test(`coordinator rejects mismatched Sol ${name} before claiming work`, async () => {
  const value = await dependencies(); change(value);
  assert.throws(() => createCoordinator(value), /configuration rejected/);
});
