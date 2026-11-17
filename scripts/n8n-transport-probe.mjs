import { createHash } from 'node:crypto';

export const READ_ONLY_QUERY = 'query ReadOnlyPublicationTransportProbe { rateLimit { limit remaining } }';
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_CHARACTERS = 16 * 1024 * 1024;
const SAFE_ERROR = 'Transport probe input failed validation.';
const PINNED = {
  baseSha: '24fc799c98040c02b11af5d5831e8e443248b41e',
  blobSha: '912127067f44573328ae5a13e5b0d8e7f6a1a118',
  caseCount: 6,
};
const CATEGORIES = ['ok', 'http_499', 'http_error', 'graphql_error', 'invalid_response', 'transport_error', 'rate_limited'];

function validPins(expected) {
  return expected && /^[a-f0-9]{40}$/.test(expected.baseSha)
    && /^[a-f0-9]{40}$/.test(expected.blobSha);
}

export function createProbeCases(blob, expected) {
  if (!validPins(expected) || !blob || blob.sha !== expected.blobSha
      || blob.encoding !== 'base64' || typeof blob.content !== 'string'
      || !Number.isSafeInteger(blob.size) || blob.size <= 0 || blob.size > MAX_REQUEST_BYTES
      || blob.content.length > Math.ceil(MAX_REQUEST_BYTES / 3) * 4 + 300_000
      || !/^[A-Za-z0-9+/=\r\n]+$/.test(blob.content)) throw new Error(SAFE_ERROR);
  const compact = blob.content.replace(/[\r\n]/g, '');
  const data = Buffer.from(compact, 'base64');
  if (data.length !== blob.size || data.toString('base64') !== compact) throw new Error(SAFE_ERROR);
  const hash = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
  if (hash !== expected.blobSha) throw new Error(SAFE_ERROR);
  const sizes = [...new Set([0, 65_536, 262_144, 1_048_576, 2_097_152, data.length])]
    .filter(size => size <= data.length).sort((a, b) => a - b);
  return sizes.map((size, index) => {
    const requestBody = {
      query: READ_ONLY_QUERY,
      variables: { input: {
        branch: { repositoryNameWithOwner: 'randoneering/mellon', branchName: 'n8n/diagnostic-no-writes' },
        expectedHeadOid: expected.baseSha,
        message: { headline: 'Read-only transport diagnostic; no commit requested' },
        fileChanges: { additions: [{ path: 'dist/index.mjs', contents: data.subarray(0, size).toString('base64') }] },
      } },
    };
    const requestBytes = Buffer.byteLength(JSON.stringify(requestBody));
    if (requestBytes > MAX_REQUEST_BYTES) throw new Error(SAFE_ERROR);
    return { base_sha: expected.baseSha, blob_sha: expected.blobSha,
      case_id: `payload-${index}`, decoded_bytes: size, request_bytes: requestBytes, request_body: requestBody };
  });
}

function validateProbe(probe, expected = PINNED) {
  const input = probe?.request_body?.variables?.input;
  const additions = input?.fileChanges?.additions;
  if (!probe || !validPins(expected) || probe.base_sha !== expected.baseSha
      || probe.blob_sha !== expected.blobSha || !/^payload-[0-5]$/.test(probe.case_id)
      || !Number.isSafeInteger(probe.decoded_bytes) || probe.decoded_bytes < 0
      || !Number.isSafeInteger(probe.request_bytes) || probe.request_bytes <= 0
      || probe.request_bytes > MAX_REQUEST_BYTES || probe.request_body?.query !== READ_ONLY_QUERY
      || input?.branch?.repositoryNameWithOwner !== 'randoneering/mellon'
      || input?.branch?.branchName !== 'n8n/diagnostic-no-writes'
      || input?.expectedHeadOid !== expected.baseSha
      || !Array.isArray(additions) || additions.length !== 1
      || additions[0]?.path !== 'dist/index.mjs' || typeof additions[0]?.contents !== 'string'
      || Buffer.byteLength(JSON.stringify(probe.request_body)) !== probe.request_bytes) throw new Error(SAFE_ERROR);
  const encoded = additions[0].contents;
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length !== probe.decoded_bytes || decoded.toString('base64') !== encoded) throw new Error(SAFE_ERROR);
}

export function startProbe(probe, startedAt = Date.now(), expected = PINNED) {
  validateProbe(probe, expected);
  if (!Number.isSafeInteger(startedAt) || startedAt < 0) throw new Error(SAFE_ERROR);
  return { ...probe, started_at_ms: startedAt };
}

function numericHeader(headers, key, max = Number.MAX_SAFE_INTEGER) {
  const value = headers[key];
  if (typeof value !== 'string' || !/^\d{1,16}$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number <= max ? number : null;
}

function validDiagnosticId(value) {
  return value === null || typeof value === 'string' && value.length <= 100
    && /^[A-Fa-f0-9]+(?::[A-Fa-f0-9]+){3,5}$/.test(value);
}

function validDiagnosticNumber(value, max = Number.MAX_SAFE_INTEGER) {
  return value === null || Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function validQuotaResponse(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || body.errors !== undefined && !Array.isArray(body.errors)) return false;
  const quota = body.data?.rateLimit;
  return quota && typeof quota === 'object' && !Array.isArray(quota)
    && Number.isSafeInteger(quota.limit) && quota.limit >= 0
    && Number.isSafeInteger(quota.remaining) && quota.remaining >= 0
    && quota.remaining <= quota.limit;
}

function normalizeStatusCode(value) {
  const number = typeof value === 'string' && /^\d{3}$/.test(value) ? Number(value) : value;
  return Number.isInteger(number) && number >= 100 && number <= 599 ? number : null;
}

function hasNodeError(response) {
  return response !== null && typeof response === 'object' && Object.hasOwn(response, 'error')
    && response.error !== null && response.error !== undefined;
}

function confirmedStatus(response) {
  return hasNodeError(response) ? null : normalizeStatusCode(response?.statusCode);
}

function nodeErrorCode(response) {
  if (!hasNodeError(response)) return null;
  for (const value of [response.error?.httpCode, response.error?.statusCode, response.error?.status, response.statusCode]) {
    const code = normalizeStatusCode(value);
    if (code !== null) return code;
  }
  return null;
}

function jsonResponseBody(response) {
  const body = response?.body;
  if (typeof body !== 'string') return body;
  if (body.length > MAX_RESPONSE_CHARACTERS) return null;
  try { return JSON.parse(body); } catch { return null; }
}

function diagnosticHeaderFields(response) {
  const headers = Object.fromEntries(Object.entries(response?.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  const requestId = headers['x-github-request-id'];
  return {
    github_request_id: validDiagnosticId(requestId) ? requestId : null,
    rate_limit_limit: numericHeader(headers, 'x-ratelimit-limit'),
    rate_limit_remaining: numericHeader(headers, 'x-ratelimit-remaining'),
    rate_limit_reset: numericHeader(headers, 'x-ratelimit-reset'),
    retry_after_seconds: numericHeader(headers, 'retry-after', 86_400),
  };
}

export function summarizeBlobFetch(response, expected = PINNED, synthetic = false) {
  if (!validPins(expected) || typeof synthetic !== 'boolean') throw new Error(SAFE_ERROR);
  const status = confirmedStatus(response);
  const headers = diagnosticHeaderFields(response);
  const body = jsonResponseBody(response);
  let category = 'ok';
  if (hasNodeError(response)) {
    const error = response.error;
    const message = (typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : '')
      .slice(0, 512).toLowerCase();
    if (message.includes('credential') && (message.includes('domain') || message.includes('hostname'))
        && (message.includes('allow') || message.includes('permit'))) category = 'credential_domain_policy';
    else if (['credential', 'authentication', 'private key', 'installation token', 'jwt'].some(part => message.includes(part))) category = 'credential_error';
    else if (message.includes('json parameter')) category = 'request_configuration_error';
    else if (message.includes('json') || message.includes('parse')) category = 'response_decoding_error';
    else if (['timeout', 'timed out', 'econn', 'socket', 'enotfound'].some(part => message.includes(part))) category = 'transport_error';
    else category = 'node_error';
  } else if (status === null) category = 'unsupported_envelope';
  else if (status === 499) category = 'http_499';
  else if (status === 429 || status === 403 && headers.rate_limit_remaining === 0) category = 'rate_limited';
  else if (status !== 200) category = 'http_error';
  else if (!body || body.sha !== expected.blobSha || body.encoding !== 'base64'
      || !Number.isSafeInteger(body.size) || body.size <= 0 || body.size > MAX_REQUEST_BYTES
      || typeof body.content !== 'string') category = 'invalid_response';
  return { purpose: 'Read-only GitHub transport diagnostic', phase: 'blob_response', synthetic,
    base_sha: expected.baseSha, blob_sha: expected.blobSha, read_only: true, factory_ready: false,
    source_hash_verified: false, status, node_error_code: nodeErrorCode(response), category, ...headers };
}

export function summarizeProbe(response, started, stoppedAt = Date.now(), expected = PINNED) {
  validateProbe(started, expected);
  if (!Number.isSafeInteger(started.started_at_ms) || !Number.isSafeInteger(stoppedAt)
      || stoppedAt < started.started_at_ms) throw new Error(SAFE_ERROR);
  const status = confirmedStatus(response);
  const headers = diagnosticHeaderFields(response);
  const body = jsonResponseBody(response);
  const remaining = headers.rate_limit_remaining;
  let category = 'ok';
  if (status === null) category = 'transport_error';
  else if (status === 499) category = 'http_499';
  else if (status === 429 || status === 403 && remaining === 0) category = 'rate_limited';
  else if (status < 200 || status >= 300) category = 'http_error';
  else if (Array.isArray(body?.errors) && body.errors.length) category = 'graphql_error';
  else if (!validQuotaResponse(body)) category = 'invalid_response';
  return {
    base_sha: expected.baseSha,
    blob_sha: expected.blobSha,
    case_id: started.case_id,
    decoded_bytes: started.decoded_bytes,
    request_bytes: started.request_bytes,
    status,
    node_error_code: nodeErrorCode(response),
    category,
    duration_ms: stoppedAt - started.started_at_ms,
    ...headers,
  };
}

export function summarizeBatch(results, expected) {
  if (!validPins(expected) || !Number.isInteger(expected.caseCount) || expected.caseCount < 1
      || expected.caseCount > 6 || !Array.isArray(results) || results.length !== expected.caseCount) {
    throw new Error(SAFE_ERROR);
  }
  const measurements = results.map((result, index) => {
    if (result?.case_id !== `payload-${index}` || result.base_sha !== expected.baseSha
        || result.blob_sha !== expected.blobSha || !CATEGORIES.includes(result.category)
        || !Number.isSafeInteger(result.decoded_bytes) || result.decoded_bytes < 0
        || !Number.isSafeInteger(result.request_bytes) || result.request_bytes <= 0
        || result.request_bytes > MAX_REQUEST_BYTES || !Number.isSafeInteger(result.duration_ms)
        || result.duration_ms < 0 || result.status !== null
        && (!Number.isInteger(result.status) || result.status < 100 || result.status > 599)
        || result.node_error_code !== null && normalizeStatusCode(result.node_error_code) !== result.node_error_code
        || result.status !== null && result.node_error_code !== null
        || !validDiagnosticId(result.github_request_id)
        || !['rate_limit_limit', 'rate_limit_remaining', 'rate_limit_reset'].every(key => validDiagnosticNumber(result[key]))
        || !validDiagnosticNumber(result.retry_after_seconds, 86_400)) throw new Error(SAFE_ERROR);
    const validCategory = result.status === null ? result.category === 'transport_error'
      : result.status === 499 ? result.category === 'http_499'
        : result.status === 429 || result.status === 403 && result.rate_limit_remaining === 0 ? result.category === 'rate_limited'
          : result.status < 200 || result.status >= 300 ? result.category === 'http_error'
            : ['ok', 'graphql_error', 'invalid_response'].includes(result.category);
    if (!validCategory) throw new Error(SAFE_ERROR);
    const clean = {};
    for (const key of ['case_id', 'decoded_bytes', 'request_bytes', 'status', 'node_error_code', 'category', 'duration_ms',
      'github_request_id', 'rate_limit_limit', 'rate_limit_remaining', 'rate_limit_reset', 'retry_after_seconds']) {
      clean[key] = result[key];
    }
    return clean;
  });
  return { purpose: 'Read-only GitHub transport diagnostic', base_sha: expected.baseSha,
    blob_sha: expected.blobSha, read_only: true, factory_ready: false, measurements };
}

function syntheticMarker(row, expected = PINNED) {
  if (!validPins(expected) || typeof row?.report !== 'string' || row.report.length > 4096) throw new Error(SAFE_ERROR);
  let record;
  try { record = JSON.parse(row.report); } catch { throw new Error(SAFE_ERROR); }
  if (record?.phase !== 'started' || record.base_sha !== expected.baseSha
      || record.blob_sha !== expected.blobSha || typeof record.synthetic !== 'boolean') throw new Error(SAFE_ERROR);
  return record.synthetic;
}

export function createProbeWorkflow(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error(SAFE_ERROR);
  const { credential, reportTableId } = options;
  if (!credential || typeof credential.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(credential.id)
      || typeof credential.name !== 'string' || !/^[^\u0000-\u001f\u007f-\u009f]{1,100}$/.test(credential.name)
      || typeof reportTableId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(reportTableId)) throw new Error(SAFE_ERROR);
  const pins = JSON.stringify(PINNED);
  const constants = `const PINNED = ${pins};\nconst READ_ONLY_QUERY = ${JSON.stringify(READ_ONLY_QUERY)};\nconst MAX_REQUEST_BYTES = ${MAX_REQUEST_BYTES};\nconst MAX_RESPONSE_CHARACTERS = ${MAX_RESPONSE_CHARACTERS};\nconst SAFE_ERROR = ${JSON.stringify(SAFE_ERROR)};`;
  const responseOptions = (neverError = true) => ({
    timeout: 20_000, redirect: { redirect: { followRedirects: false } },
    response: { response: { fullResponse: true, neverError, responseFormat: 'text', outputPropertyName: 'body' } },
  });
  const credentials = { githubAppApi: { id: credential.id, name: credential.name } };
  const synthetic = "syntheticMarker($('Record diagnostic start').first().json)";
  const encodeReport = value => `={{ JSON.stringify(${value}) }}`;
  const context = `base_sha: ${JSON.stringify(PINNED.baseSha)}, blob_sha: ${JSON.stringify(PINNED.blobSha)}`;
  const shared = [validPins, normalizeStatusCode, hasNodeError, confirmedStatus, nodeErrorCode,
    jsonResponseBody, numericHeader, validDiagnosticId, diagnosticHeaderFields, syntheticMarker].map(fn => fn.toString()).join('\n');
  const store = (id, name, position, report) => ({
    id, name, type: 'n8n-nodes-base.dataTable', typeVersion: 1.1, position,
    parameters: { resource: 'row', operation: 'insert', dataTableId: { __rl: true, mode: 'id', value: reportTableId },
      columns: { mappingMode: 'defineBelow', value: { execution_id: '={{ $execution.id }}', report },
        matchingColumns: [], schema: ['execution_id', 'report'].map(key => ({ id: key, displayName: key,
          type: 'string', required: false, defaultMatch: false, display: true, readOnly: false, removed: false })),
        attemptToConvertTypes: false, convertFieldsToString: false }, options: { optimizeBulk: false } },
  });
  const fields = ['base_sha', 'blob_sha', 'case_id', 'decoded_bytes', 'request_bytes', 'status',
    'node_error_code', 'category', 'duration_ms', 'github_request_id', 'rate_limit_limit',
    'rate_limit_remaining', 'rate_limit_reset', 'retry_after_seconds'];
  const nodes = [
    { id: 'probe-start', name: 'Manual transport diagnostic', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    store('probe-record-start', 'Record diagnostic start', [224, 0],
      encodeReport(`{ phase: 'started', ${context}, synthetic: $json.synthetic === true, read_only: true, factory_ready: false }`)),
    // Swallowing a GET 401 can skip n8n's native credential refresh.
    { id: 'probe-blob', name: 'Read pinned public blob', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.5, position: [448, 0], credentials, onError: 'continueRegularOutput', alwaysOutputData: true,
      parameters: { method: 'GET', url: `https://api.github.com/repos/randoneering/mellon/git/blobs/${PINNED.blobSha}`,
        authentication: 'predefinedCredentialType', nodeCredentialType: 'githubAppApi', options: responseOptions(false) } },
    { id: 'probe-blob-status', name: 'Sanitize blob status', type: 'n8n-nodes-base.code', typeVersion: 2, position: [672, 0],
      parameters: { mode: 'runOnceForEachItem', language: 'javaScript', jsCode:
        `${constants}\n${shared}\n${summarizeBlobFetch.toString()}\nreturn { json: summarizeBlobFetch($json, PINNED, ${synthetic}) };` } },
    store('probe-record-blob', 'Record blob status', [896, 0], encodeReport('$json')),
    { id: 'probe-prepare', name: 'Prepare bounded probes', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1120, 0],
      parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode:
        `${constants}\nconst { createHash } = require('crypto');\n${shared}\n${createProbeCases.toString()}\nconst response = $('Read pinned public blob').first().json;\nif (confirmedStatus(response) !== 200) throw new Error(SAFE_ERROR);\nreturn createProbeCases(jsonResponseBody(response), PINNED).map(json => ({ json: { ...json, synthetic: ${synthetic} } }));` } },
    { id: 'probe-loop', name: 'One probe at a time', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position: [1344, 0], parameters: { batchSize: 1, options: {} } },
    { id: 'probe-clock', name: 'Start probe', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1568, 160],
      parameters: { mode: 'runOnceForEachItem', language: 'javaScript', jsCode:
        `${constants}\n${validPins.toString()}\n${validateProbe.toString()}\n${startProbe.toString()}\nreturn { json: startProbe($json, Date.now()) };` } },
    store('probe-record-prepared', 'Record prepared request', [1792, 160],
      encodeReport(`{ phase: 'request_prepared', ${context}, synthetic: $json.synthetic === true, case_id: $json.case_id,
        decoded_bytes: $json.decoded_bytes, request_bytes: $json.request_bytes, started_at_ms: $json.started_at_ms }`)),
    { id: 'probe-http', name: 'Read-only GraphQL request', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.5, position: [2016, 160], credentials, onError: 'continueRegularOutput', alwaysOutputData: true,
      parameters: { method: 'POST', url: 'https://api.github.com/graphql', authentication: 'predefinedCredentialType', nodeCredentialType: 'githubAppApi',
        sendBody: true, specifyBody: 'json', jsonBody: "={{ JSON.stringify($('Start probe').first(0, $runIndex).json.request_body) }}", options: responseOptions() } },
    { id: 'probe-sanitize', name: 'Sanitize probe result', type: 'n8n-nodes-base.code', typeVersion: 2, position: [2240, 160],
      parameters: { mode: 'runOnceForEachItem', language: 'javaScript', jsCode:
        `${constants}\n${shared}\n${validateProbe.toString()}\n${validQuotaResponse.toString()}\n${summarizeProbe.toString()}\nconst request = $('Start probe').first(0, $runIndex).json;\nreturn { json: { ...summarizeProbe($json, request, Date.now()), synthetic: request.synthetic === true } };` } },
    store('probe-record-measurement', 'Record probe measurement', [2464, 160],
      encodeReport(`{ phase: 'measurement', synthetic: $json.synthetic === true, measurement: { ${fields.map(key => `${key}: $json.${key}`).join(', ')} } }`)),
    { id: 'probe-rate-check', name: 'Rate limit reached', type: 'n8n-nodes-base.if', typeVersion: 2.4, position: [2688, 160],
      parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ id: 'probe-rate-limit', leftValue: "={{ $('Sanitize probe result').first(0, $runIndex).json.category === 'rate_limited' || $('Sanitize probe result').first(0, $runIndex).json.node_error_code === 429 }}",
          rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} } },
    { id: 'probe-rate-stop', name: 'Stop after rate limit', type: 'n8n-nodes-base.stopAndError', typeVersion: 1, position: [2912, 320],
      parameters: { errorType: 'errorMessage', errorMessage: 'Transport probe stopped after a rate-limit signal; sanitized progress is recorded.' } },
    { id: 'probe-report', name: 'Sanitized diagnostic report', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1568, -160],
      parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode:
        `${constants}\nconst CATEGORIES = ${JSON.stringify(CATEGORIES)};\n${shared}\n${validDiagnosticNumber.toString()}\n${summarizeBatch.toString()}\nconst results = Array.from({ length: PINNED.caseCount }, (_, index) => $('Sanitize probe result').first(0, index).json);\nconst synthetic = ${synthetic};\nif (!results.every(result => result.synthetic === synthetic)) throw new Error(SAFE_ERROR);\nconst report = summarizeBatch(results, PINNED);\nreturn [{ json: { ...report, phase: 'complete', synthetic } }];` } },
    store('probe-store', 'Store sanitized report', [1792, -160], encodeReport('$json')),
  ];
  const edge = node => ({ node, type: 'main', index: 0 });
  return {
    name: 'mellon: manual read-only publication transport diagnostic', active: false, nodes,
    connections: {
      'Manual transport diagnostic': { main: [[edge('Record diagnostic start')]] },
      'Record diagnostic start': { main: [[edge('Read pinned public blob')]] },
      'Read pinned public blob': { main: [[edge('Sanitize blob status')]] },
      'Sanitize blob status': { main: [[edge('Record blob status')]] },
      'Record blob status': { main: [[edge('Prepare bounded probes')]] },
      'Prepare bounded probes': { main: [[edge('One probe at a time')]] },
      'One probe at a time': { main: [[edge('Sanitized diagnostic report')], [edge('Start probe')]] },
      'Start probe': { main: [[edge('Record prepared request')]] },
      'Record prepared request': { main: [[edge('Read-only GraphQL request')]] },
      'Read-only GraphQL request': { main: [[edge('Sanitize probe result')]] },
      'Sanitize probe result': { main: [[edge('Record probe measurement')]] },
      'Record probe measurement': { main: [[edge('Rate limit reached')]] },
      'Rate limit reached': { main: [[edge('Stop after rate limit')], [edge('One probe at a time')]] },
      'Sanitized diagnostic report': { main: [[edge('Store sanitized report')]] },
    },
    settings: { executionOrder: 'v1', saveDataSuccessExecution: 'none', saveDataErrorExecution: 'none',
      saveExecutionProgress: false, saveManualExecutions: false, executionTimeout: 180, availableInMCP: true },
  };
}
