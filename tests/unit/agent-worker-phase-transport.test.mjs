import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAgentWorker } from '../../src/automation/worker/agent.mjs';
import { normalizeModelCallOutcome } from '../../src/automation/worker/budgets.mjs';

mock.method(globalThis, 'fetch', async () => { throw new Error('Uncontrolled network is forbidden.'); });

const text = 'export {};';
const sha256 = createHash('sha256').update(text).digest('hex');
const blobSha = createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0${text}`).digest('hex');
const baseSha = 'a'.repeat(40);
const manifestHash = 'b'.repeat(64);
const config = { gateway: { baseURL: 'https://gateway.example', apiKey: 'synthetic-secret' }, modelId: 'gpt-6-1-sol', reasoningEffort: 'high' };
const reservation = () => ({ status: 'reserved', canExecute: true, operationId: 'op-1', inputTokens: 8000, outputTokens: 2000, deadlineAt: new Date(Date.now() + 20000).toISOString() });
const basicContext = () => ({
  policy: { system: 'Reviewed rules.' }, skills: [], issue: { title: 'Issue', body: 'Untrusted' },
  repository: { owner: 'mellon', name: 'mellon', baseSha, revision: baseSha },
  manifest: { repository: 'mellon/mellon', baseSha, hash: manifestHash,
    files: ['src/example.mjs'], patchManifest: { allowedPaths: ['src/example.mjs'],
      pilotScope: { kind: 'bounded-public-issue', maxChangedFiles: 2, maxFileBytes: 4096, maxTotalBytes: 8192 } },
    coordinator: { regression: { testPathIndex: 0, initial: { testName: 'adds example', criterionIndex: 0 }, repairTestNames: ['repairs example'] } },
    acceptanceCriteria: ['Adds example'] },
  files: [{ path: 'src', mode: '040000', blobSha: null },
    { path: 'src/example.mjs', mode: '100644', blobSha, sha256, text }],
  phaseInstructions: { purpose: 'initial_tests', repairCycle: 0, regressionPath: 'src/example.mjs',
    testName: 'adds example', criterionIndex: 0, criterion: 'Adds example' },
});
function makeWorker({ context = basicContext(), response, reserve = async () => reservation(), validateChanges, readFile } = {}) {
  const requests = [], outcomes = [];
  let reservations = 0;
  const worker = createAgentWorker({ config, loadContext: async () => context,
    authorization: { recheck: async () => true, reserveModelCall: async input => { reservations += 1; return reserve(input); },
      recordModelCallOutcome: async (_reservation, outcome) => {
        outcomes.push(outcome);
        const normalized = normalizeModelCallOutcome(outcome);
        return { status: normalized.blockerCode ? 'needs_attention' : 'recorded', ...normalized };
      } },
    tokenizer: { modelId: config.modelId, renderer: 'neon-responses-gpt-6-1-sol-v1', reasoningEffort: 'high', countRendered: () => 512 },
    ...(validateChanges ? { validateChanges } : {}),
    ...(readFile ? { readFile } : {}),
    sdk: { fetch: async (url, init) => {
      const request = { url: String(url), method: init.method, body: JSON.parse(init.body) };
      requests.push(request);
      const output = typeof response === 'function' ? response(request.body) : response;
      return Response.json({ id: 'resp_1', object: 'response', model: config.modelId, output: Array.isArray(output) ? output : [output],
        usage: { input_tokens: 512, output_tokens: 25, total_tokens: 537, output_tokens_details: { reasoning_tokens: 17 } } });
    } },
  });
  return { worker, requests, outcomes, reservations: () => reservations };
}
const toolCall = (name, args) => ({ id: 'fc_1', type: 'function_call', call_id: 'call_1', name, arguments: JSON.stringify(args), status: 'completed' });

test('complete coordinator phase forces a single proposal-only SDK request and accepts its bounded proposal', async () => {
  const proposal = { baseSha, manifestHash, changes: [{ operation: 'modify', path: 'src/example.mjs', content: 'export const value = 1;', expectedBlobSha: blobSha }] };
  const harness = makeWorker({ response: body => body.tool_choice === 'auto'
    ? toolCall('listFiles', {}) : toolCall('proposeChanges', proposal) });
  const result = await harness.worker.run({});
  assert.equal(result.status, 'completed', result.blockerCode);
  assert.equal(result.proposal, true, JSON.stringify(result));
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].content, proposal.changes[0].content);
  assert.deepEqual({ ...result.diagnostics.toolCounts }, { proposeChanges: 1 });
  assert.deepEqual(harness.outcomes, [{ outcome: 'success', actualInputTokens: 512, actualOutputTokens: 25 }]);
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].method, 'POST');
  assert.equal(harness.requests[0].url, 'https://gateway.example/openai/v1/responses');
  const { body } = harness.requests[0];
  assert.deepEqual(body.tools.map(item => item.name), ['proposeChanges']);
  assert.deepEqual(body.tool_choice, { type: 'function', name: 'proposeChanges' });
  assert.equal(body.max_output_tokens, 2000);
  assert.equal(body.store, false);
  assert.equal(Object.hasOwn(body, 'temperature'), false);
  assert.equal(Object.hasOwn(body, 'top_p'), false);
  assert.equal(harness.reservations(), 1);
});

test('explicit new-file representation remains eligible for a proposal', async () => {
  const context = basicContext();
  context.manifest.files = ['src/new-example.mjs'];
  context.manifest.patchManifest.allowedPaths = ['src/new-example.mjs'];
  context.phaseInstructions.regressionPath = 'src/new-example.mjs';
  context.files = [{ path: 'src', mode: '040000', blobSha: null },
    { path: 'src/new-example.mjs', mode: null, blobSha: null }];
  const proposal = { baseSha, manifestHash, changes: [{ operation: 'create', path: 'src/new-example.mjs', content: 'export {};'}] };
  const harness = makeWorker({ context, response: toolCall('proposeChanges', proposal) });
  const result = await harness.worker.run({});
  assert.equal(result.status, 'completed', result.blockerCode);
  assert.equal(result.proposal, true, JSON.stringify(result));
});

test('incomplete coordinator file representation stops before reservation and transport', async () => {
  const context = basicContext();
  context.files = [{ path: 'src/example.mjs', mode: '040000', blobSha: null }];
  const harness = makeWorker({ context, response: toolCall('proposeChanges', {}) });
  const result = await harness.worker.run({});
  assert.equal(result.blockerCode, 'context_invalid');
  assert.equal(harness.reservations(), 0);
  assert.equal(harness.requests.length, 0);
});

test('proposal-only SDK response rejects ignored tool calls without another request', async () => {
  const harness = makeWorker({ response: toolCall('listFiles', { revision: baseSha }) });
  const result = await harness.worker.run({});
  assert.equal(result.status, 'stopped');
  assert.equal(result.proposal, undefined);
  assert.equal(harness.requests.length, 1);
  assert.deepEqual(harness.requests[0].body.tools.map(item => item.name), ['proposeChanges']);
});

test('generic context keeps read and list tools with automatic selection', async () => {
  const context = basicContext();
  delete context.phaseInstructions;
  const harness = makeWorker({ context, response: toolCall('listFiles', { revision: baseSha }) });
  const result = await harness.worker.run({});
  assert.equal(result.status, 'completed', result.blockerCode);
  assert.equal(result.proposal, false);
  assert.equal(result.diagnostics.proposalCategory, 'read_only');
  assert.deepEqual({ ...result.diagnostics.toolCounts }, { listFiles: 1 });
  assert.equal(harness.requests.length, 1);
  assert.deepEqual(harness.requests[0].body.tools.map(item => item.name), ['readFile', 'listFiles', 'proposeChanges']);
  assert.equal(harness.requests[0].body.tool_choice, 'auto');
});

for (const bounds of ['path-only', 'numeric']) {
  test(`generic ${bounds} adapter executes verified SDK reads`, async () => {
    const context = basicContext();
    delete context.phaseInstructions;
    if (bounds === 'path-only') delete context.manifest.patchManifest.pilotScope;
    let reads = 0;
    const harness = makeWorker({ context, response: toolCall('readFile', { path: 'src/example.mjs', revision: baseSha }),
      readFile: async request => {
        reads += 1;
        assert.equal(request.expectedBlobSha, blobSha);
        assert.equal(request.revision, baseSha);
        return { revision: baseSha, path: request.path, blobSha, text };
      } });
    const result = await harness.worker.run({});
    assert.equal(result.status, 'completed');
    assert.equal(result.proposal, false);
    assert.equal(reads, 1);
    assert.deepEqual({ ...result.diagnostics.toolCounts }, { readFile: 1 });
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0].body.tool_choice, 'auto');
  });
}

for (const purpose of ['initial_implementation', 'repair_tests', 'repair_implementation']) {
  test(`complete ${purpose} phase keeps one forced SDK proposal`, async () => {
    const context = basicContext();
    const repair = purpose.startsWith('repair_');
    context.phaseInstructions = { purpose, repairCycle: repair ? 1 : 0,
      regressionPath: 'src/example.mjs', testName: repair ? 'repairs example' : 'adds example',
      ...(repair ? {} : { criterionIndex: 0, criterion: 'Adds example' }) };
    const harness = makeWorker({ context, response: toolCall('proposeChanges', { baseSha, manifestHash,
      changes: [{ operation: 'modify', path: 'src/example.mjs', content: 'export const value = 1;', expectedBlobSha: blobSha }] }) });
    const result = await harness.worker.run({});
    assert.equal(result.proposal, true);
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.reservations(), 1);
    assert.deepEqual(harness.requests[0].body.tool_choice, { type: 'function', name: 'proposeChanges' });
    assert.deepEqual(harness.requests[0].body.tools.map(item => item.name), ['proposeChanges']);
  });
}

for (const [name, response] of [
  ['prose', { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'No proposal.', annotations: [] }] }],
  ['unknown tool', toolCall('unsupported', {})],
  ['malformed arguments', { ...toolCall('proposeChanges', {}), arguments: '{' }],
  ['invalid schema', toolCall('proposeChanges', {})],
  ['invalid binding', toolCall('proposeChanges', { baseSha, manifestHash: 'c'.repeat(64),
    changes: [{ operation: 'modify', path: 'src/example.mjs', content: 'export {};', expectedBlobSha: blobSha }] })],
  ['invalid blob binding', toolCall('proposeChanges', { baseSha, manifestHash,
    changes: [{ operation: 'modify', path: 'src/example.mjs', content: 'export {};', expectedBlobSha: 'c'.repeat(40) }] })],
  ['over byte bound', toolCall('proposeChanges', { baseSha, manifestHash,
    changes: [{ operation: 'modify', path: 'src/example.mjs', content: 'x'.repeat(4097), expectedBlobSha: blobSha }] })],
]) {
  test(`forced proposal SDK ${name} cannot yield a publishable proposal or another request`, async () => {
    const harness = makeWorker({ response });
    const result = await harness.worker.run({});
    assert.notEqual(result.proposal, true);
    assert.ok(!result.changes?.length);
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.reservations(), 1);
    assert.equal(harness.outcomes.length, 1);
  });
}

for (const [name, mutate] of [
  ['missing approved file', context => { context.files.pop(); }],
  ['invalid text hash', context => { context.files[1].sha256 = 'c'.repeat(64); }],
  ['malformed phase', context => { context.phaseInstructions = null; }],
  ['unapproved test name', context => { context.phaseInstructions.testName = 'unapproved'; }],
]) {
  test(`coordinator ${name} stops before SDK and reservation`, async () => {
    const context = basicContext();
    mutate(context);
    const harness = makeWorker({ context, response: toolCall('proposeChanges', {}) });
    assert.equal((await harness.worker.run({})).blockerCode, 'context_invalid');
    assert.equal(harness.requests.length, 0);
    assert.equal(harness.reservations(), 0);
  });
}

test('proposal-only repair SDK accepts assessment-only human stop without forcing confirmation', async () => {
  const context = basicContext();
  const regressionPath = 'tests/unit/example.test.mjs';
  context.manifest.files.push(regressionPath);
  context.manifest.patchManifest.allowedPaths.push(regressionPath);
  context.manifest.coordinator.regression.testPathIndex = 1;
  context.files.push({ path: regressionPath, mode: null, blobSha: null });
  context.phaseInstructions = { purpose: 'repair_tests', repairCycle: 1,
    regressionPath, testName: 'repairs example' };
  const criterion = { criterionIndex: 0, criterionSha256: 'c'.repeat(64) };
  const references = [{ fileIndex: 1, blobSha, testIdentitySha256: null }];
  context.investigation = { version: 1, findingSha256: 'd'.repeat(64), headSha: baseSha,
    criteria: [criterion], references, regressionFileIndex: 2 };
  const assessment = { disposition: 'suspected_false_positive', findingSha256: 'd'.repeat(64),
    ...criterion, references };
  const harness = makeWorker({ context, response: toolCall('proposeChanges', { baseSha, manifestHash, changes: [], assessment }) });
  const result = await harness.worker.run({});
  assert.equal(result.blockerCode, 'investigation_human_stop');
  assert.equal(result.proposal, false);
  assert.deepEqual([...result.changes], []);
  assert.equal(result.assessment.disposition, 'suspected_false_positive');
  assert.equal(result.diagnostics.proposalCategory, 'assessment_only');
  assert.equal(harness.requests.length, 1);
  assert.deepEqual(harness.requests[0].body.tools.map(item => item.name), ['proposeChanges']);
});
