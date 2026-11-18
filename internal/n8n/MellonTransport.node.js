// n8n loads custom node files as CommonJS. This diagnostic has two fixed routes.
const BLOB_SHA = '912127067f44573328ae5a13e5b0d8e7f6a1a118';
const QUERY = 'query ReadOnlyPublicationTransportProbe { rateLimit { limit remaining } }';

class MellonTransport {
  description = {
    displayName: 'Mellon transport diagnostic', name: 'mellonTransport', group: ['transform'],
    version: 1, description: 'Read the pinned diagnostic blob or measure a read-only quota request',
    defaults: { name: 'Mellon transport diagnostic' }, inputs: ['main'], outputs: ['main'],
    credentials: [{ name: 'githubAppApi', required: true }],
    properties: [
      { displayName: 'Operation', name: 'operation', type: 'options', default: 'blob',
        options: [{ name: 'Read Pinned Blob', value: 'blob' }, { name: 'Read Quota', value: 'quota' }] },
      { displayName: 'Request Body', name: 'requestBody', type: 'string', default: '',
        displayOptions: { show: { operation: ['quota'] } } },
    ],
  };

  async execute() {
    const operation = this.getNodeParameter('operation', 0);
    if (!['blob', 'quota'].includes(operation)) throw new Error('Unknown diagnostic operation.');
    const blob = operation === 'blob';
    const options = {
      method: blob ? 'GET' : 'POST',
      url: blob ? 'https://api.github.com/repos/randoneering/mellon/git/blobs/' + BLOB_SHA : 'https://api.github.com/graphql',
      maxResponseBodyBytes: blob ? 16 * 1024 * 1024 : 64 * 1024,
      disableFollowRedirect: true, returnFullResponse: true, encoding: 'text', timeout: 20000,
      ignoreHttpStatusErrors: !blob,
    };
    if (!blob) {
      const raw = this.getNodeParameter('requestBody', 0);
      if (typeof raw !== 'string' || Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new Error('Invalid probe size.');
      const body = JSON.parse(raw);
      if (body?.query !== QUERY || Object.keys(body).some(key => !['query', 'variables'].includes(key))) throw new Error('Invalid diagnostic query.');
      options.body = raw;
      options.headers = { 'content-type': 'application/json' };
    }
    try {
      const { statusCode, headers, body } = await this.helpers.httpRequestWithAuthentication('githubAppApi', options);
      const diagnosticHeaders = {};
      for (const key of ['x-github-request-id', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after']) {
        if (typeof headers?.[key] === 'string') diagnosticHeaders[key] = headers[key];
      }
      return [[{ json: { statusCode, headers: diagnosticHeaders, body }, pairedItem: { item: 0 } }]];
    } catch (error) {
      const code = Number(error.httpCode ?? error.response?.status);
      const message = String(error.message ?? '').slice(0, 512).toLowerCase();
      const category = /credential.*(domain|hostname)|(domain|hostname).*credential/.test(message) ? 'credential domain not allowed'
        : /credential|installation token|private key|jwt/.test(message) ? 'credential error'
        : /timeout|timed out/.test(message) ? 'timeout' : 'request failed';
      return [[{ json: { error: { message: category, ...(Number.isInteger(code) && code >= 100 && code <= 599 ? { httpCode: code } : {}) } }, pairedItem: { item: 0 } }]];
    }
  }
}
module.exports = { MellonTransport, QUERY, BLOB_SHA };
