import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { normalizeModelCallOutcome } from '../../src/automation/worker/budgets.mjs';
import { createAgentWorker } from '../../src/automation/worker/agent.mjs';

mock.method(globalThis, 'fetch', async () => { throw new Error('Uncontrolled network is forbidden.'); });

const fileText = 'export {};';
const sha256 = createHash('sha256').update(fileText).digest('hex');
const blobSha = createHash('sha1').update(`blob ${Buffer.byteLength(fileText)}\0${fileText}`).digest('hex');
const context = Object.freeze({
  policy: Object.freeze({ system: 'Reviewed rules.' }), skills: Object.freeze([]),
  issue: Object.freeze({ title: 'Issue', body: 'Untrusted content' }),
  repository: Object.freeze({ owner: 'mellon', name: 'mellon', baseSha: 'a'.repeat(40), revision: 'a'.repeat(40) }),
  manifest: Object.freeze({ repository: 'mellon/mellon', baseSha: 'a'.repeat(40), hash: 'b'.repeat(64), files: Object.freeze(['src/example.mjs']), patchManifest: Object.freeze({ allowedPaths: ['src/example.mjs'] }) }),
  files: Object.freeze([Object.freeze({ path: 'src/example.mjs', mode: '100644', blobSha, sha256, text: fileText })]),
});
const config = Object.freeze({ gateway: Object.freeze({ baseURL: 'https://gateway.example', apiKey: 'synthetic-secret' }), modelId: 'gpt-6-1-sol', reasoningEffort: 'high' });
const tokenizer = Object.freeze({ modelId: config.modelId, renderer: 'neon-responses-gpt-6-1-sol-v1', reasoningEffort: 'high', countRendered: () => 512 });
const reservation = { status: 'reserved', canExecute: true, operationId: 'op-1', inputTokens: 8000, outputTokens: 2000, deadlineAt: new Date(Date.now() + 20_000).toISOString() };
const authorization = {
  recheck: async () => true,
  reserveModelCall: async () => reservation,
  recordModelCallOutcome: async (_reservation, outcome) => {
    const normalized = normalizeModelCallOutcome(outcome);
    return { status: normalized.blockerCode ? 'needs_attention' : 'recorded', outcome: normalized.outcome, blockerCode: normalized.blockerCode };
  },
};

function worker(fetch, authorizationOverride = {}, options = {}) {
  return createAgentWorker({ config, authorization: { ...authorization, ...authorizationOverride }, loadContext: async () => context, tokenizer, sdk: { fetch }, ...options });
}

for (const reasoningEffort of [undefined, 'medium', 'none']) {
  test(`Sol rejects unapproved reasoning effort ${String(reasoningEffort)}`, () => {
    const modelConfig = { ...config };
    if (reasoningEffort === undefined) delete modelConfig.reasoningEffort;
    else modelConfig.reasoningEffort = reasoningEffort;
    assert.throws(() => createAgentWorker({ config: modelConfig, authorization,
      loadContext: async () => context, tokenizer }), /configuration is invalid/);
  });
}

test('approved MVP admission reserves large reviewed input without inventing a tokenizer', async () => {
  let reserved;
  const result = await worker(async () => Response.json({
    id: 'resp_byte_budget', object: 'response', model: config.modelId,
    output: [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'Synthetic response.', annotations: [] }] }],
    usage: { input_tokens: 12000, output_tokens: 25,
      output_tokens_details: { reasoning_tokens: 17 } },
  }), { reserveModelCall: async request => {
    reserved = request;
    return { ...reservation, inputTokens: request.inputTokens };
  } }, {
    config: { ...config, inputAdmission: 'conservative-bytes-v1' }, tokenizer: undefined,
    loadContext: async () => ({ ...context, policy: { system: 's'.repeat(50000) } }),
  }).run({});
  assert.equal(result.status, 'completed', result.blockerCode);
  assert.ok(reserved.inputTokens > 50000 && reserved.inputTokens <= 65536);
  assert.equal(reserved.outputTokens, 2000);
});

for (const reasoningTokens of [26, -1]) {
  test(`Sol rejects reasoning usage inconsistent with the total: ${reasoningTokens}`, async () => {
    const result = await worker(async () => Response.json({
      id: 'resp_invalid_usage', object: 'response', model: config.modelId,
      output: [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'Synthetic response.', annotations: [] }] }],
      usage: { input_tokens: 512, output_tokens: 25,
        output_tokens_details: { reasoning_tokens: reasoningTokens } },
    })).run({});
    assert.equal(result.status, 'stopped');
    assert.equal(result.blockerCode, 'model_usage_invalid');
  });
}

test('uses Neon Responses GPT-6.1 Sol high reasoning and validates native usage', async () => {
  let request;
  let requestedReservation;
  const result = await worker(async (url, init) => {
    request = { url: String(url), body: JSON.parse(init.body) };
    return new Response(JSON.stringify({
      id: 'resp_1', object: 'response', model: config.modelId,
      output: [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done.', annotations: [] }] }],
      usage: { input_tokens: 512, output_tokens: 25, total_tokens: 537, output_tokens_details: { reasoning_tokens: 17 } },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }, { reserveModelCall: async request => {
    requestedReservation = request;
    return reservation;
  } }).run({});
  assert.equal(requestedReservation.outputTokens, 2000);
  assert.equal(result.status, 'completed', result.blockerCode);
  assert.match(request.url, /openai\/v1\/responses/);
  assert.equal(request.body.reasoning.effort, 'high');
  assert.equal(request.body.store, false);
  assert.equal(request.body.max_output_tokens, 2000);
  assert.equal(Object.hasOwn(request.body, 'temperature'), false);
  assert.equal(Object.hasOwn(request.body, 'top_p'), false);
  assert.notEqual(result.blockerCode, 'input_budget_unverified');
});
