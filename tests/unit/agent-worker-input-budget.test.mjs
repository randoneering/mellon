import assert from 'node:assert/strict';
import test from 'node:test';
import { validateClaimInput } from '../../src/automation/worker/store-validation.mjs';
import { manifest } from '../fixtures/worker-candidates/inputs.mjs';

async function reserve(value) {
  const module = await import('../../src/automation/worker/input-budget.mjs').catch(() => ({}));
  assert.equal(typeof module.reserveRenderedInput, 'function', 'The approved admission planner must exist.');
  return module.reserveRenderedInput(value);
}

test('durable claim accepts the approved reservation ceiling and rejects excess', () => {
  const approved = manifest();
  const value = { invocationId: 'admission-test', manifest: {
    repositoryId: approved.repository.id, repositoryFullName: approved.repository.name,
    issueId: approved.issue.id, issueNumber: approved.issue.number,
    actorId: approved.approver.id, manifestHash: 'a'.repeat(64),
    baseRevision: approved.base.revision, policyRevision: approved.policyRevision,
    limits: { ...approved.limits, inputTokensPerCall: 65536 },
  } };
  assert.equal(validateClaimInput(value).manifest.limits.inputTokensPerCall, 65536);
  value.manifest.limits.inputTokensPerCall = 65537;
  assert.throws(() => validateClaimInput(value));
});

test('input reservation counts complete rendered UTF-8 data plus the approved allowance', async () => {
  const payload = { system: 's', prompt: 'p', toolSchemas: [] };
  const expected = Buffer.byteLength('{"system":"s","prompt":"p","toolSchemas":[]}');
  const result = await reserve(payload);
  assert.equal(result.inputBytes, expected);
  assert.equal(result.inputTokens, expected + 4096);
  assert.equal(result.mode, 'conservative-bytes-v1');
  assert.equal(Object.isFrozen(result), true);
});

test('input admission permits exactly sixty KiB and rejects one byte more', async () => {
  const base = Buffer.byteLength('{"system":"","prompt":"","toolSchemas":[]}');
  const value = { system: 'a'.repeat(60 * 1024 - base), prompt: '', toolSchemas: [] };
  const result = await reserve(value);
  assert.equal(result.inputBytes, 61440);
  assert.equal(result.inputTokens, 65536);
  await assert.rejects(reserve({ ...value, system: value.system + 'a' }),
    { message: 'Rendered input exceeds the approved byte budget.' });
});

test('UTF-8 input and complete nested tool declarations consume the reservation', async () => {
  const small = await reserve({ system: 's', prompt: 'p', toolSchemas: [] });
  const larger = await reserve({ system: 's', prompt: '🍄', toolSchemas: [{
    type: 'function', name: 'readFile', description: 'Bounded read',
    parameters: { type: 'object', properties: { path: { type: 'string', enum: ['a', 'b'] } } },
  }] });
  assert.ok(larger.inputBytes > small.inputBytes + 20);
  assert.equal(larger.inputTokens - larger.inputBytes, 4096);
});

for (const value of [{}, { system: 's', prompt: 'p' },
  { system: 's', prompt: 'p', toolSchemas: [], execute: true }]) {
  test(`input admission rejects missing or extra fields: ${Object.keys(value).join(',')}`, async () => {
    await assert.rejects(reserve(value), { message: 'Rendered input budget is invalid.' });
  });
}
