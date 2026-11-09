import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAgentWorker } from '../../src/automation/worker/agent.mjs';
import { normalizeModelCallOutcome } from '../../src/automation/worker/budgets.mjs';

mock.method(globalThis, 'fetch', async () => { throw new Error('Uncontrolled network is forbidden.'); });
const revision = 'a'.repeat(40);
const text = 'export {};';
const blobSha = createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0${text}`).digest('hex');
const manifestHash = 'b'.repeat(64);
const change = () => ({ operation: 'modify', path: 'src/parser.mjs', expectedBlobSha: blobSha, content: 'export const parsed = true;' });
const context = () => ({
  policy: { system: 'Reviewed policy.' }, skills: ['Reviewed tests-first skill.'], issue: { title: 'Parser', body: 'Untrusted.' },
  repository: { owner: 'mellon', name: 'mellon', baseSha: revision, revision },
  manifest: { repository: 'mellon/mellon', baseSha: revision, hash: manifestHash, files: ['src/parser.mjs'], patchManifest: { allowedPaths: ['src/parser.mjs'], pilotScope: { kind: 'bounded-public-issue', maxChangedFiles: 10, maxFileBytes: 65536, maxTotalBytes: 262144 } } },
  files: [{ path: 'src', mode: '040000', blobSha: null }, { path: 'src/parser.mjs', mode: '100644', blobSha, sha256: createHash('sha256').update(text).digest('hex'), text }],
});
const result = () => ({ text: '', finishReason: 'stop', steps: [], usage: { inputTokens: 100, outputTokens: 2 }, response: { body: { usage: { prompt_tokens: 100, completion_tokens: 2 } } } });
function setup(overrides = {}) {
  const calls = [], outcomes = [], reservations = [];
  const options = {
    config: { gateway: { baseURL: 'https://gateway.example', apiKey: 'synthetic-secret' }, modelId: 'neon/test-model' },
    authorization: {
      recheck: async () => true,
      reserveModelCall: async request => { reservations.push(request); return { status: 'reserved', canExecute: true, operationId: 'one', inputTokens: request.inputTokens, outputTokens: 512, deadlineAt: new Date(Date.now() + 20000).toISOString() }; },
      recordModelCallOutcome: async (_reservation, outcome) => { outcomes.push(outcome); const normalized = normalizeModelCallOutcome(outcome); return { status: normalized.blockerCode ? 'needs_attention' : 'recorded', outcome: normalized.outcome, blockerCode: normalized.blockerCode }; },
    },
    loadContext: async () => context(),
    tokenizer: { modelId: 'neon/test-model', renderer: 'neon-chat-v1', countRendered: () => 512 },
    sdk: { generateText: async input => { calls.push(input); return result(); } }, ...overrides,
  };
  return { options, calls, outcomes, reservations, run: () => createAgentWorker(options).run({}) };
}
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const chat = (extra = {}) => ({ id: 'synthetic', object: 'chat.completion', created: 1, model: 'neon/test-model', choices: [{ index: 0, message: { role: 'assistant', content: 'private transcript' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102 }, ...extra });

test('installed SDK executes one validated proposal, never makes a continuation request', async () => {
  const requests = [];
  const h = setup({ sdk: { fetch: async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    return response(chat({ choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'proposal-one', type: 'function', function: { name: 'proposeChanges', arguments: JSON.stringify({ baseSha: revision, manifestHash, changes: [change()] }) } }] }, finish_reason: 'tool_calls' }] }));
  } } });
  const output = await h.run();
  assert.equal(output.status, 'completed');
  assert.equal(output.proposal, true);
  assert.equal(output.changes[0].expectedBlobSha, blobSha);
  assert.equal(output.changes[0].content, 'export const parsed = true;');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://gateway.example/v1/chat/completions');
  assert.equal(requests[0].body.max_tokens, 512);
  assert.deepEqual(h.outcomes, [{ outcome: 'success', actualInputTokens: 100, actualOutputTokens: 2 }]);
});

test('installed SDK missing usage remains unreported, never synthesized as zero', async () => {
  const body = chat(); delete body.usage;
  const h = setup({ sdk: { fetch: async () => response(body) } });
  assert.equal((await h.run()).blockerCode, 'model_usage_unreported');
  assert.deepEqual(h.outcomes, [{ outcome: 'usage_unreported' }]);
});

for (const [name, usage] of [
  ['empty', {}],
  ['input only', { prompt_tokens: 100 }],
  ['output only', { completion_tokens: 2 }],
  ['both null', { prompt_tokens: null, completion_tokens: null }],
  ['null output', { prompt_tokens: 100, completion_tokens: null }],
  ['null input', { prompt_tokens: null, completion_tokens: 2 }],
]) test(`installed SDK ${name} raw usage stops and withholds a validated proposal`, async () => {
  let requests = 0;
  const body = chat({ usage, choices: [{ index: 0, message: {
    role: 'assistant', content: null, tool_calls: [{ id: 'proposal-one', type: 'function',
      function: { name: 'proposeChanges', arguments: JSON.stringify({
        baseSha: revision, manifestHash, changes: [change()],
      }) } }],
  }, finish_reason: 'tool_calls' }] });
  const h = setup({ sdk: { fetch: async () => { requests++; return response(body); } } });
  const output = await h.run();
  assert.deepEqual(JSON.parse(JSON.stringify(output)), { status: 'stopped', blockerCode: 'model_usage_unreported',
    diagnostics: { proposalCategory: 'valid_proposal', toolCounts: { proposeChanges: 1 } } });
  assert.deepEqual(h.outcomes, [{ outcome: 'usage_unreported' }]);
  assert.equal(requests, 1);
  assert.equal(Object.hasOwn(output, 'changes'), false);
});

test('installed SDK preserves explicitly reported zero usage', async () => {
  const h = setup({ sdk: { fetch: async () => response(chat({
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  })) } });
  assert.equal((await h.run()).status, 'completed');
  assert.deepEqual(h.outcomes, [{ outcome: 'success', actualInputTokens: 0, actualOutputTokens: 0 }]);
});

test('installed SDK unknown charge/network failure is uncertain without retries or details', async () => {
  let count = 0;
  const h = setup({ sdk: { fetch: async () => { count++; throw new Error('private synthetic-secret network error'); } } });
  const output = await h.run();
  assert.equal(output.blockerCode, 'model_outcome_uncertain');
  assert.equal(count, 1);
  assert.doesNotMatch(JSON.stringify(output), /synthetic-secret|private|network/);
});

test('trusted reader receives the request abort signal and cannot outlive its authority', async () => {
  let signal;
  const h = setup({ timeoutMs: 15, readFile: async input => { signal = input.abortSignal; return new Promise(() => {}); }, sdk: { generateText: async ({ tools }) => { await tools.readFile.execute({ path: 'src/parser.mjs' }); return result(); } } });
  assert.equal((await h.run()).blockerCode, 'model_call_deadline');
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, true);
});

test('input above the hard 8000-token limit stops before reserving', async () => {
  const h = setup({ tokenizer: { modelId: 'neon/test-model', renderer: 'neon-chat-v1', countRendered: () => 8001 } });
  assert.equal((await h.run()).blockerCode, 'model_input_token_limit');
  assert.equal(h.reservations.length, 0);
  assert.equal(h.calls.length, 0);
});

test('authoritative database deadline downgrade stays typed rather than uncertain', async () => {
  const h = setup();
  h.options.authorization.recordModelCallOutcome = async () => ({ status: 'needs_attention', outcome: 'deadline', blockerCode: 'model_tick_deadline' });
  assert.equal((await h.run()).blockerCode, 'model_tick_deadline');
});

test('hanging outcome persistence is bounded and cannot return success', async () => {
  const h = setup({ timeoutMs: 15 });
  h.options.authorization.recordModelCallOutcome = async () => new Promise(() => {});
  let timer;
  try {
    const output = await Promise.race([h.run(), new Promise(resolve => { timer = setTimeout(() => resolve({ blockerCode: 'test_timeout' }), 150); })]);
    assert.equal(output.blockerCode, 'model_outcome_uncertain');
  } finally { clearTimeout(timer); }
});

test('oversized SDK tool output contract cannot be reported as successful work', async () => {
  const h = setup({ sdk: { generateText: async () => ({ ...result(), steps: [{ toolCalls: Array.from({ length: 17 }, () => ({ toolName: 'listFiles', input: {} })) }] }) } });
  assert.equal((await h.run()).blockerCode, 'model_contract_unknown');
  assert.deepEqual(h.outcomes, [{ outcome: 'unknown_contract' }]);
});

test('unknown or malformed SDK tool calls fail closed even without execution', async () => {
  for (const call of [{ toolName: 'shell', input: { command: 'id' } }, { toolName: 'listFiles', input: { command: 'id' } }]) {
    const h = setup({ sdk: { generateText: async () => ({ ...result(), toolCalls: [call] }) } });
    assert.equal((await h.run()).blockerCode, 'model_contract_unknown');
    assert.deepEqual(h.outcomes, [{ outcome: 'unknown_contract' }]);
  }
});

test('a tokenizer exception leaves input admission unverified without a reservation', async () => {
  const h = setup({ tokenizer: { modelId: 'neon/test-model', renderer: 'neon-chat-v1', countRendered: () => { throw new Error('private tokenizer error'); } } });
  assert.equal((await h.run()).blockerCode, 'input_budget_unverified');
  assert.equal(h.reservations.length, 0);
});

test('tool response control sequences are escaped before display', async () => {
  const value = context();
  const controlledText = 'export {};\u001b[2J';
  const file = value.files[1];
  file.text = controlledText;
  file.sha256 = createHash('sha256').update(controlledText).digest('hex');
  file.blobSha = createHash('sha1').update(`blob ${Buffer.byteLength(controlledText)}\0${controlledText}`).digest('hex');
  let toolResult;
  const h = setup({ loadContext: async () => value, readFile: async () => ({ path: file.path, revision, blobSha: file.blobSha, text: controlledText }), sdk: { generateText: async ({ tools }) => { toolResult = await tools.readFile.execute({ path: file.path }); return result(); } } });
  assert.equal((await h.run()).status, 'completed');
  assert.equal(toolResult.status, 'ok');
  assert.doesNotMatch(toolResult.text, /\u001b/u);
  assert.match(toolResult.text, /\\u001b/);
});

for (const [name, receipt] of [
  ['missing receipt', null],
  ['empty receipt', {}],
  ['stale lease', { status: 'stale' }],
  ['unrecognized success blocker', { status: 'recorded', outcome: 'success', blockerCode: 'private synthetic-secret' }],
]) test(`invalid persistence receipt never authorizes publication: ${name}`, async () => {
  const h = setup(); h.options.authorization.recordModelCallOutcome = async () => receipt;
  assert.deepEqual(JSON.parse(JSON.stringify(await h.run())), { status: 'stopped', blockerCode: 'model_outcome_uncertain',
    diagnostics: { proposalCategory: 'prose_only', toolCounts: {} } });
});

test('revocation between reservation and call prevents SDK execution', async () => {
  const h = setup(); let checks = 0;
  h.options.authorization.recheck = async () => ++checks === 1;
  assert.equal((await h.run()).status, 'stopped');
  assert.equal(h.calls.length, 0);
  assert.equal(h.outcomes.length, 1);
});

test('configuration and rendered snapshot remain unchanged during reservation await', async () => {
  const h = setup();
  const input = context(); h.options.loadContext = async () => input;
  const reserve = h.options.authorization.reserveModelCall;
  h.options.authorization.reserveModelCall = async request => { input.policy.system = 'mutated'; input.skills.push('mutated'); input.manifest.files.push('README.md'); h.options.config.gateway.apiKey = 'changed-secret'; return reserve(request); };
  assert.equal((await h.run()).status, 'completed');
  assert.doesNotMatch(h.calls[0].system, /mutated|changed-secret/);
  assert.equal(h.reservations[0].inputHash.length, 64);
});
