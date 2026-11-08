import assert from 'node:assert/strict';
import test from 'node:test';
import { createCoordinator } from '../../src/automation/worker/coordinator.mjs';
import { harness, delivery } from '../fixtures/worker-coordinator/harness.mjs';
import { hash, canonical } from '../fixtures/worker-candidates/inputs.mjs';

// Reservation totals remain spent even when reported usage is smaller.
test('full relevant guidance permits both initial model phases within the approved run reservation', async () => {
  const h = await harness();
  h.manifest.model = { id: 'gpt-6-1-sol', reasoningEffort: 'high',
    renderer: 'neon-responses-gpt-6-1-sol-v1', inputAdmission: 'conservative-bytes-v1' };
  h.manifest.limits.inputTokensPerCall = 65536;
  const digest = hash(canonical(h.manifest));
  h.state.run.manifestHash = digest;
  h.state.run.limits = { ...h.manifest.limits };
  h.dependencies.expectedManifestSha256 = digest;
  h.model.config.modelId = 'gpt-6-1-sol';
  h.model.config.reasoningEffort = 'high';
  h.model.config.inputAdmission = 'conservative-bytes-v1';
  delete h.model.tokenizer;
  const generate = h.model.sdk.generateText;
  h.model.sdk.generateText = async options => {
    const result = await generate(options);
    result.response.body.usage = { input_tokens: 100, output_tokens: 20 };
    return result;
  };
  let reserved = 0;
  const reserve = h.store.reserveModelCall;
  h.store.reserveModelCall = async (...args) => {
    const next = reserved + args[1].inputTokens;
    if (next > h.manifest.limits.inputTokensPerRun) return { status: 'needs_attention',
      canExecute: false, blockerCode: 'model_token_budget_exhausted' };
    reserved = next;
    return reserve(...args);
  };
  const coordinator = createCoordinator(h.dependencies);
  for (let i = 0; h.state.run.state !== 'waiting_ci' && i < 10; i += 1) {
    h.state.checkStatus = h.state.run.state === 'waiting_red_ci' ? 'intended_red' : 'success';
    const result = await coordinator.advanceTick(delivery());
    assert.equal(result.status, 'advanced', result.reason);
  }
  assert.equal(h.state.run.state, 'waiting_ci');
  assert.equal(h.state.modelRequests, 2);
  assert.ok(reserved <= 100000);
  for (const context of h.state.contexts) {
    assert.ok(context.skills.some(value => value.includes('name: test-driven-development')));
    assert.ok(context.skills.some(value => value.includes('name: verification-before-completion')));
    assert.ok(!context.skills.some(value => value.includes('name: systematic-debugging')));
  }
});
