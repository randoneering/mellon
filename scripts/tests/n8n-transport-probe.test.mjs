import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  createProbeCases, startProbe as actualStartProbe,
  summarizeProbe as actualSummarizeProbe, summarizeBatch,
  createProbeWorkflow, READ_ONLY_QUERY,
} from '../n8n-transport-probe.mjs';

import * as diagnostics from '../n8n-transport-probe.mjs';

const require = createRequire(import.meta.url);
const expected = { baseSha: 'a'.repeat(40), blobSha: 'ce013625030ba8dba906f756967f9e9ca394464a' };
const blob = { sha: expected.blobSha, encoding: 'base64', content: 'aGVsbG8K\n', size: 6 };
const operator = { credential: { id: 'probe-app', name: 'Reviewed GitHub App' }, reportTableId: 'probe-report-table' };

function largeBlob() {
  const data = Buffer.alloc(4_236_577, 'x');
  const sha = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
  return { sha, encoding: 'base64', content: data.toString('base64'), size: data.length };
}

function startProbe(probe, startedAt) {
  return actualStartProbe(probe, startedAt, expected);
}

function summarizeProbe(incoming, startedItem, stoppedAt) {
  return actualSummarizeProbe(incoming, startedItem, stoppedAt, expected);
}

function started() {
  return startProbe(createProbeCases(blob, expected)[1], 1000);
}

function pinnedBaseline() {
  const item = createProbeCases(blob, expected)[0];
  item.base_sha = '24fc799c98040c02b11af5d5831e8e443248b41e';
  item.blob_sha = '912127067f44573328ae5a13e5b0d8e7f6a1a118';
  item.request_body.variables.input.expectedHeadOid = item.base_sha;
  item.request_bytes = Buffer.byteLength(JSON.stringify(item.request_body));
  return item;
}

function response(status = 200) {
  return { statusCode: status, body: '{"data":{"rateLimit":{"limit":5000,"remaining":4999}}}', headers: {
    'x-github-request-id': 'ABCD:1234:5678:90AB:CDEF',
    'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999',
    'x-ratelimit-reset': '1800000000',
  } };
}

test('builds only fixed read-only queries from the pinned Git blob', () => {
  const cases = createProbeCases(blob, expected);
  assert.deepEqual(cases.map(item => item.decoded_bytes), [0, 6]);
  assert.deepEqual(cases.map(item => item.case_id), ['payload-0', 'payload-1']);
  assert.equal(cases[1].request_body.query, 'query ReadOnlyPublicationTransportProbe { rateLimit { limit remaining } }');
  assert.equal(cases[1].request_body.variables.input.branch.branchName, 'n8n/diagnostic-no-writes');
  assert.equal(cases[1].request_body.variables.input.branch.repositoryNameWithOwner, 'randoneering/mellon');
  assert.equal(cases[1].request_body.variables.input.fileChanges.additions[0].path, 'dist/index.mjs');
  assert.equal(cases[1].request_body.variables.input.fileChanges.additions[0].contents, 'aGVsbG8K');
  assert.equal(cases[1].request_bytes, Buffer.byteLength(JSON.stringify(cases[1].request_body)));
});

test('caps real-size diagnostic cases at six bounded file prefixes', () => {
  const input = largeBlob();
  const cases = createProbeCases(input, { baseSha: expected.baseSha, blobSha: input.sha });
  assert.deepEqual(cases.map(item => item.decoded_bytes), [0, 65_536, 262_144, 1_048_576, 2_097_152, 4_236_577]);
  assert.equal(cases.length, 6);
  for (const item of cases) {
    assert.ok(item.request_bytes < 8 * 1024 * 1024);
    assert.equal(item.request_body.query, READ_ONLY_QUERY);
  }
});

for (const [name, change] of [
  ['wrong blob SHA', { sha: 'b'.repeat(40) }],
  ['wrong encoding', { encoding: 'utf8' }],
  ['wrong declared size', { size: 5 }],
  ['noncanonical base64', { content: 'aGVsbG8K=' }],
  ['invalid base64 character', { content: 'aGVsbG8K!' }],
  ['embedded space', { content: 'aGVs bG8K' }],
  ['changed content', { content: 'c2VjcmV0', size: 6 }],
  ['empty blob', { content: '', size: 0 }],
  ['oversize declaration', { size: 20 * 1024 * 1024 }],
]) {
  test(`rejects ${name} without exposing source or credentials`, () => {
    assert.throws(() => createProbeCases({ ...blob, ...change }, expected), error => {
      assert.match(error.message, /validation/i);
      assert.doesNotMatch(error.message, /aGVs|c2Vj|secret|Bearer/);
      return true;
    });
  });
}

test('rejects invalid pinned metadata before requests can be prepared', () => {
  for (const pin of [{ ...expected, baseSha: 'main' }, { ...expected, blobSha: '../other' }, null]) {
    assert.throws(() => createProbeCases(blob, pin), /validation/i);
  }
});

test('rejects a self-consistent oversized request instead of extending the budget', () => {
  const data = Buffer.alloc(7 * 1024 * 1024, 'x');
  const sha = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
  assert.throws(() => createProbeCases({ sha, size: data.length, encoding: 'base64', content: data.toString('base64') },
    { baseSha: expected.baseSha, blobSha: sha }), /validation/i);
});

test('start guard refuses mutation, moved target, and altered request metadata', () => {
  const probe = createProbeCases(blob, expected)[0];
  for (const altered of [
    { ...probe, request_body: { ...probe.request_body, query: 'mutation { createCommitOnBranch { commit { oid } } }' } },
    { ...probe, request_bytes: probe.request_bytes + 1 },
    { ...probe, case_id: 'private-body' },
    { ...probe, request_body: { query: READ_ONLY_QUERY, variables: { input: { branch: { branchName: 'main' } } } } },
  ]) assert.throws(() => startProbe(altered, 1000), /validation/i);
  assert.throws(() => startProbe(probe, NaN), /validation/i);
});

test('reports whitelisted transport measurements, not response bodies or arbitrary headers', () => {
  const incoming = response();
  incoming.body = '{"data":{"rateLimit":{"limit":5000,"remaining":4999}},"private":"source-text-token-canary"}';
  incoming.headers.authorization = 'Bearer token-canary';
  incoming.headers['set-cookie'] = 'private-cookie-canary';
  incoming.extra = 'raw-response-canary';
  const result = summarizeProbe(incoming, started(), 1123);
  assert.deepEqual(result, {
    base_sha: expected.baseSha, blob_sha: expected.blobSha,
    case_id: 'payload-1', decoded_bytes: 6, request_bytes: started().request_bytes,
    status: 200, node_error_code: null, category: 'ok', duration_ms: 123,
    github_request_id: 'ABCD:1234:5678:90AB:CDEF',
    rate_limit_limit: 5000, rate_limit_remaining: 4999, rate_limit_reset: 1800000000,
    retry_after_seconds: null,
  });
  assert.doesNotMatch(JSON.stringify(result), /canary|Bearer|cookie|source-text|headers|body/);
});

test('marks empty, malformed and unusable HTTP200 bodies as invalid responses', () => {
  for (const body of ['', 'private-canary', '<html>private-canary</html>', '{}',
    '{"data":null}', '{"data":{"rateLimit":{"limit":5000}}}',
    '{"data":{"rateLimit":{"remaining":1}}}',
    '{"data":{"rateLimit":{"limit":5000,"remaining":-1}}}',
    '{"data":{"rateLimit":{"limit":3,"remaining":4}}}',
    '{"data":{"rateLimit":{"limit":"5000","remaining":4}}}',
    '{"errors":{},"data":{"rateLimit":{"limit":5000,"remaining":4}}}']) {
    const result = summarizeProbe({ ...response(), body }, started(), 1100);
    assert.equal(result.status, 200);
    assert.equal(result.category, 'invalid_response');
    assert.doesNotMatch(JSON.stringify(result), /private-canary|<html>/);
  }
});

test('rejects a changed valid head despite recomputed byte counts', () => {
  const item = createProbeCases(blob, expected)[0];
  item.request_body.variables.input.expectedHeadOid = 'b'.repeat(40);
  item.request_bytes = Buffer.byteLength(JSON.stringify(item.request_body));
  assert.throws(() => startProbe(item, 1000), /validation/i);
  assert.throws(() => actualStartProbe(createProbeCases(blob, expected)[0], 1000), /validation/i);
  assert.throws(() => actualStartProbe(createProbeCases(blob, expected)[0], 1000,
    { ...expected, baseSha: 'main' }), /validation/i);
});

test('refuses measurements from a different trusted pin instead of misattributing them', () => {
  const other = { ...expected, baseSha: 'b'.repeat(40) };
  const item = actualStartProbe(createProbeCases(blob, other)[0], 1000, other);
  const measurement = actualSummarizeProbe(response(), item, 1100, other);
  assert.throws(() => summarizeBatch([measurement], { ...expected, caseCount: 1 }), /validation/i);
});

test('preserves empty HTTP499 and sanitized transport failures', () => {
  assert.equal(summarizeProbe({ statusCode: 499, body: '', headers: {} }, started(), 1100).category, 'http_499');
  const result = summarizeProbe({ error: { message: 'Bearer secret-source-token', response: { body: 'private' } } }, started(), 1100);
  assert.equal(result.status, null);
  assert.equal(result.category, 'transport_error');
  assert.doesNotMatch(JSON.stringify(result), /secret|private|Bearer/);
});

test('reports GraphQL rejection independently from HTTP success', () => {
  assert.equal(summarizeProbe({ ...response(), body: '{"errors":[{"message":"private-details"}]}' }, started(), 1100).category, 'graphql_error');
});

test('handles rate-limit and retry headers without inventing a failure cause', () => {
  const limited = response(429);
  limited.headers['retry-after'] = '60';
  const result = summarizeProbe(limited, started(), 1200);
  assert.equal(result.category, 'rate_limited');
  assert.equal(result.retry_after_seconds, 60);
  assert.equal(summarizeProbe(response(403), started(), 1200).category, 'http_error');
});

test('drops malformed or credential-like diagnostic header values', () => {
  const incoming = response();
  incoming.headers = { 'X-GitHub-Request-Id': 'Bearer-private-token',
    'x-ratelimit-limit': 'secret', 'x-ratelimit-remaining': '-1',
    'x-ratelimit-reset': '1e9', 'retry-after': 'private response' };
  const result = summarizeProbe(incoming, started(), 1100);
  assert.equal(result.github_request_id, null);
  assert.equal(result.rate_limit_limit, null);
  assert.equal(result.rate_limit_remaining, null);
  assert.equal(result.rate_limit_reset, null);
  assert.equal(result.retry_after_seconds, null);
  assert.doesNotMatch(JSON.stringify(result), /Bearer|private|secret/);
});

test('rejects missing or invalid timing rather than reporting misleading durations', () => {
  assert.throws(() => summarizeProbe(response(), { ...started(), started_at_ms: undefined }, 1100), /validation/i);
  assert.throws(() => summarizeProbe(response(), started(), 999), /validation/i);
});

test('batch report binds measurements to pins without claiming factory readiness', () => {
  const cases = createProbeCases(blob, expected);
  const measurements = cases.map(item => summarizeProbe(response(), startProbe(item, 1000), 1100));
  const result = summarizeBatch(measurements, { ...expected, caseCount: 2 });
  assert.equal(result.base_sha, expected.baseSha);
  assert.equal(result.blob_sha, expected.blobSha);
  assert.equal(result.read_only, true);
  assert.equal(result.factory_ready, false);
  assert.deepEqual(result.measurements.map(item => item.case_id), ['payload-0', 'payload-1']);
  assert.equal(Object.hasOwn(result.measurements[0], 'base_sha'), false);
  assert.equal(Object.hasOwn(result.measurements[0], 'blob_sha'), false);
  for (const invalid of [[], [measurements[0], measurements[0]], [{ ...measurements[0], category: 'Bearer private' }, measurements[1]]]) {
    assert.throws(() => summarizeBatch(invalid, { ...expected, caseCount: 2 }), /validation/i);
  }
});

test('rejects missing request bodies with the fixed validation error', () => {
  const probe = createProbeCases(blob, expected)[0];
  for (const request_body of [undefined, null]) {
    assert.throws(() => startProbe({ ...probe, request_body }, 1000), /input failed validation/);
  }
});

test('batch report revalidates every diagnostic header and status category', () => {
  const result = summarizeProbe(response(), startProbe(createProbeCases(blob, expected)[0], 1000), 1100);
  for (const change of [
    { github_request_id: 'Bearer-private-token' }, { rate_limit_remaining: 'private' },
    { rate_limit_limit: -1 }, { retry_after_seconds: 100_000 },
    { category: 'transport_error', status: 200 }, { category: 'ok', status: null },
    { node_error_code: 'private' }, { node_error_code: 600 }, { node_error_code: 403 },
  ]) assert.throws(() => summarizeBatch([{ ...result, ...change }], { ...expected, caseCount: 1 }), /validation/i);
  const clean = summarizeBatch([{ ...result, body: 'private-canary', headers: { authorization: 'Bearer private' } }],
    { ...expected, caseCount: 1 });
  assert.doesNotMatch(JSON.stringify(clean), /canary|Bearer|headers|body/);
});

function storedReport(node, value, synthetic = false) {
  const expression = node.parameters.columns.value.report.slice(3, -2);
  const encoded = new Function('$json', '$', `return ${expression};`)({ ...value, synthetic },
    () => ({ first: () => ({ json: { synthetic } }) }));
  return JSON.parse(encoded);
}

test('blob stage reports only safe metadata, not node errors or API bodies', () => {
  const incoming = { ...response(403), body: { message: 'private-body-canary' },
    extra: 'private-extra-canary' };
  incoming.headers.authorization = 'Bearer private-token-canary';
  const result = diagnostics.summarizeBlobFetch(incoming, expected, true);
  assert.equal(result.phase, 'blob_response');
  assert.equal(result.synthetic, true);
  assert.equal(result.status, 403);
  assert.equal(result.category, 'http_error');
  assert.equal(result.source_hash_verified, false);
  assert.equal(result.base_sha, expected.baseSha);
  assert.doesNotMatch(JSON.stringify(result), /canary|Bearer|authorization|message|body/);
});

test('blob stage distinguishes a local credential-policy error from a confirmed HTTP response', () => {
  const result = diagnostics.summarizeBlobFetch({ error: {
    message: 'Credential not allowed for this domain: private-token-canary', httpCode: '403',
  } }, expected);
  assert.equal(result.status, null);
  assert.equal(result.node_error_code, 403);
  assert.equal(result.category, 'credential_domain_policy');
  assert.doesNotMatch(JSON.stringify(result), /private-token|domain:/);
});

test('blob stage rejects successful-status responses with unusable blob metadata', () => {
  const invalid = diagnostics.summarizeBlobFetch({ statusCode: 200, body: { private: 'private-canary' } }, expected);
  assert.equal(invalid.category, 'invalid_response');
  const valid = diagnostics.summarizeBlobFetch({ statusCode: 200, body: blob, headers: {} }, expected);
  assert.equal(valid.category, 'ok');
  assert.equal(valid.source_hash_verified, false);
  assert.equal(diagnostics.summarizeBlobFetch({}, expected).category, 'unsupported_envelope');
  assert.throws(() => diagnostics.summarizeBlobFetch({}, null), /validation/i);
  assert.doesNotMatch(JSON.stringify(invalid), /canary/);
});

test('node error codes do not become invented upstream HTTP statuses', () => {
  const result = summarizeProbe({ error: { message: 'private-canary', httpCode: '499' } }, started(), 1100);
  assert.equal(result.status, null);
  assert.equal(result.node_error_code, 499);
  assert.equal(result.category, 'transport_error');
  assert.doesNotMatch(JSON.stringify(result), /canary/);
});

test('progress storage drops arbitrary inputs and marks synthetic records', () => {
  const workflow = createProbeWorkflow(operator);
  const named = name => workflow.nodes.find(node => node.name === name);
  const initial = storedReport(named('Record diagnostic start'), { secret: 'private-canary' }, true);
  assert.equal(initial.phase, 'started');
  assert.equal(initial.synthetic, true);
  assert.equal(initial.factory_ready, false);
  assert.doesNotMatch(JSON.stringify(initial), /canary|secret/);
  const prepared = storedReport(named('Record prepared request'), { ...started(), secret: 'private-canary' }, true);
  assert.equal(prepared.phase, 'request_prepared');
  assert.equal(prepared.synthetic, true);
  assert.equal(prepared.request_bytes, started().request_bytes);
  assert.doesNotMatch(JSON.stringify(prepared), /canary|request_body|fileChanges|contents/);
  const measurement = summarizeProbe(response(), started(), 1100);
  const record = storedReport(named('Record probe measurement'), { ...measurement, secret: 'private-canary' }, true);
  assert.equal(record.phase, 'measurement');
  assert.equal(record.synthetic, true);
  assert.equal(record.measurement.case_id, 'payload-1');
  assert.doesNotMatch(JSON.stringify(record), /canary|secret|request_body/);
});

test('initial journal does not require the trigger to appear in execution history', () => {
  const workflow = createProbeWorkflow(operator);
  const expression = workflow.nodes.find(node => node.name === 'Record diagnostic start')
    .parameters.columns.value.report.slice(3, -2);
  const encoded = new Function('$json', '$', `return ${expression};`)({ synthetic: true },
    () => { throw new Error('Trigger-history lookup is unavailable.'); });
  assert.equal(JSON.parse(encoded).synthetic, true);
});

test('journal steps precede risky work and every measurement is stored before continuing', () => {
  const workflow = createProbeWorkflow(operator);
  const next = (name, output = 0) => workflow.connections[name].main[output][0].node;
  assert.equal(next('Manual transport diagnostic'), 'Record diagnostic start');
  assert.equal(next('Record diagnostic start'), 'Read pinned public blob');
  assert.equal(next('Read pinned public blob'), 'Sanitize blob status');
  assert.equal(next('Sanitize blob status'), 'Record blob status');
  assert.equal(next('Record blob status'), 'Prepare bounded probes');
  assert.equal(next('Start probe'), 'Record prepared request');
  assert.equal(next('Record prepared request'), 'Read-only GraphQL request');
  assert.equal(next('Sanitize probe result'), 'Record probe measurement');
  assert.equal(next('Record probe measurement'), 'Rate limit reached');
  assert.equal(next('Rate limit reached', 0), 'Stop after rate limit');
  assert.equal(next('Rate limit reached', 1), 'One probe at a time');
});

test('preparatory GET permits native credential refresh without enabling payload resends', () => {
  const workflow = createProbeWorkflow(operator);
  const get = workflow.nodes.find(node => node.name === 'Read pinned public blob');
  const post = workflow.nodes.find(node => node.name === 'Read-only GraphQL request');
  assert.equal(get.parameters.options.response.response.neverError, false);
  assert.equal(get.onError, 'continueRegularOutput');
  assert.equal(post.parameters.options.response.response.neverError, true);
  assert.notEqual(get.retryOnFail, true);
  assert.notEqual(post.retryOnFail, true);
});

test('generated response correlation does not depend on an error item retaining paired data', () => {
  const workflow = createProbeWorkflow(operator);
  const code = workflow.nodes.find(node => node.name === 'Sanitize probe result').parameters.jsCode;
  const probe = actualStartProbe(pinnedBaseline(), 1000);
  const selected = [];
  const result = new Function('$json', '$', '$runIndex', code)(response(499), () => ({
    first: (branch, run) => { selected.push([branch, run]); return { json: probe }; },
  }), 2);
  assert.deepEqual(selected, [[0, 2]]);
  assert.equal(result.json.category, 'http_499');
});

test('rate-limit routing stops only after the measurement journal', () => {
  const workflow = createProbeWorkflow(operator);
  const gate = workflow.nodes.find(node => node.name === 'Rate limit reached');
  const expression = gate.parameters.conditions.conditions[0].leftValue.slice(3, -2);
  const evaluate = new Function('$', '$runIndex', `return ${expression};`);
  assert.equal(evaluate(() => ({ first: (_branch, index) => ({ json: { category: index === 0 ? 'rate_limited' : 'ok' } }) }), 0), true);
  assert.equal(evaluate(() => ({ first: () => ({ json: { category: 'ok' } }) }), 1), false);
  assert.equal(evaluate(() => ({ first: () => ({ json: { category: 'transport_error', node_error_code: 429 } }) }), 0), true);
  assert.equal(workflow.nodes.find(node => node.name === 'Stop after rate limit').parameters.errorType, 'errorMessage');
});

test('generated final aggregation reads indexed sanitized history rather than storage echoes', () => {
  const workflow = createProbeWorkflow(operator);
  const code = workflow.nodes.find(node => node.name === 'Sanitized diagnostic report').parameters.jsCode;
  const sizes = [0, 65_536, 262_144, 1_048_576, 2_097_152, 4_236_577];
  const history = sizes.map((size, index) => ({
    base_sha: '24fc799c98040c02b11af5d5831e8e443248b41e',
    blob_sha: '912127067f44573328ae5a13e5b0d8e7f6a1a118',
    case_id: `payload-${index}`, decoded_bytes: size, request_bytes: 416 + Math.ceil(size / 3) * 4,
    status: 200, node_error_code: null, category: 'ok', duration_ms: 100,
    github_request_id: null, rate_limit_limit: null, rate_limit_remaining: null,
    rate_limit_reset: null, retry_after_seconds: null, synthetic: true,
  }));
  const selected = [];
  const result = new Function('$', code)(name => name === 'Record diagnostic start'
    ? { first: () => ({ json: { report: JSON.stringify({ phase: 'started', synthetic: true,
      base_sha: '24fc799c98040c02b11af5d5831e8e443248b41e',
      blob_sha: '912127067f44573328ae5a13e5b0d8e7f6a1a118' }) } }) }
    : { first: (branch, run) => { selected.push([branch, run]); return { json: history[run] }; } });
  assert.deepEqual(selected, [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5]]);
  assert.equal(result[0].json.phase, 'complete');
  assert.equal(result[0].json.synthetic, true);
  assert.equal(result[0].json.factory_ready, false);
  assert.equal(result[0].json.measurements.length, 6);
});

test('requires explicit static operator-selected resources', () => {
  for (const options of [undefined, null, {}, { ...operator, reportTableId: '={{ $json.secret }}' },
    { ...operator, credential: { id: 'bad/token', name: 'App' } },
    { ...operator, credential: { name: 'App' } },
    { ...operator, credential: { id: 123, name: 'App' } }]) {
    assert.throws(() => createProbeWorkflow(options), /validation/i);
  }
});

test('workflow remains manual and inactive with no retained execution data', () => {
  const workflow = createProbeWorkflow(operator);
  assert.equal(workflow.active, false);
  assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
  assert.equal(workflow.settings.saveDataErrorExecution, 'none');
  assert.equal(workflow.settings.saveExecutionProgress, false);
  assert.equal(workflow.settings.saveManualExecutions, false);
  assert.equal(workflow.settings.executionTimeout, 180);
  assert.equal(workflow.nodes.filter(node => node.type.includes('Trigger')).length, 1);
  assert.equal(workflow.nodes.find(node => node.type.includes('Trigger')).type, 'n8n-nodes-base.manualTrigger');
  const http = workflow.nodes.filter(node => node.type === 'n8n-nodes-base.httpRequest');
  assert.equal(http.length, 2);
  for (const node of http) {
    assert.ok(node.parameters.url.startsWith('https://api.github.com/'));
    assert.equal(node.parameters.options.redirect.redirect.followRedirects, false);
    assert.equal(node.parameters.options.timeout, 20000);
    assert.equal(node.credentials.githubAppApi.id, 'probe-app');
    assert.notEqual(node.retryOnFail, true);
    assert.equal(node.onError, 'continueRegularOutput');
    assert.equal(node.continueOnFail, undefined);
    assert.equal(node.alwaysOutputData, true);
    assert.equal(node.parameters.options.response.response.responseFormat, 'text');
    assert.equal(node.parameters.options.response.response.outputPropertyName, 'body');
  }
  assert.equal(http.find(node => node.parameters.method === 'POST').parameters.url, 'https://api.github.com/graphql');
  assert.equal(http.find(node => node.parameters.method === 'POST').parameters.options.response.response.responseFormat, 'text');
  assert.equal(workflow.nodes.find(node => node.type === 'n8n-nodes-base.splitInBatches').parameters.batchSize, 1);
});

test('persists only the sanitized final report, never the raw execution', () => {
  const workflow = createProbeWorkflow(operator);
  const persist = workflow.nodes.find(node => node.name === 'Store sanitized report');
  assert.equal(persist.type, 'n8n-nodes-base.dataTable');
  assert.equal(persist.parameters.operation, 'insert');
  assert.equal(persist.parameters.dataTableId.value, 'probe-report-table');
  assert.deepEqual(persist.parameters.columns.value, {
    execution_id: '={{ $execution.id }}', report: '={{ JSON.stringify($json) }}',
  });
  assert.deepEqual(workflow.connections['Sanitized diagnostic report'].main[0], [
    { node: 'Store sanitized report', type: 'main', index: 0 },
  ]);
});

test('generated start and response nodes enforce the same safe behavior', () => {
  const workflow = createProbeWorkflow(operator);
  const start = workflow.nodes.find(node => node.name === 'Start probe').parameters.jsCode;
  const startedItem = new Function('$json', start)(pinnedBaseline());
  assert.equal(startedItem.json.request_body.query, READ_ONLY_QUERY);
  const summarize = workflow.nodes.find(node => node.name === 'Sanitize probe result').parameters.jsCode;
  const execute = new Function('$json', '$', '$runIndex', summarize);
  const result = execute({ ...response(499), body: '' }, () => ({ first: () => ({ json: startedItem.json }) }), 0);
  assert.equal(result.json.category, 'http_499');
  assert.doesNotMatch(JSON.stringify(result), /request_body|fileChanges|contents|headers/);
});

test('generated blob preparation checks the actual pinned object before making requests', () => {
  const workflow = createProbeWorkflow(operator);
  const prepare = workflow.nodes.find(node => node.name === 'Prepare bounded probes').parameters.jsCode;
  const execute = new Function('$', 'require', prepare);
  assert.throws(() => execute(() => ({ first: () => ({ json: { statusCode: 200, body: blob } }) }), require), /validation/i);
  assert.throws(() => execute(() => ({ first: () => ({ json: { statusCode: 404, body: 'private' } }) }), require), /validation/i);
});
