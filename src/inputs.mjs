const DEFAULT_RESPONSE = "AI-assisted code is welcome. Please describe your work in your own words. This automated review can make mistakes. If this submission does not meet the repository's contribution policy, maintainers may close it. Contact a maintainer if you need help.";
const EVENT_LIMIT = 4 * 1024 * 1024;
const RESPONSE_LIMIT = 32 * 1024;
const ACCOUNT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?(?:\[bot\])?$/i;

function invalidInput() {
  return new Error('Invalid Action input or event payload.');
}

function validText(value) {
  return typeof value === 'string' && value.trim().length > 0 && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}

function payloadBytes(payload, eventBytes) {
  let bytes;
  if (eventBytes !== undefined) {
    bytes = Buffer.isBuffer(eventBytes) || eventBytes instanceof Uint8Array
      ? Buffer.from(eventBytes)
      : Buffer.from(String(eventBytes));
  } else {
    try {
      bytes = Buffer.from(JSON.stringify(payload), 'utf8');
    } catch {
      throw invalidInput();
    }
  }
  if (bytes.length > EVENT_LIMIT) throw invalidInput();
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw invalidInput();
  }
}

function exactRepo(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

export function parseEvent({ eventName, repository, payload, eventBytes } = {}) {
  if (eventName !== 'issues' && eventName !== 'pull_request_target') return { kind: 'skip' };
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload) ||
      typeof payload.action !== 'string' || payload.action.length === 0) throw invalidInput();
  if (payload.action !== 'opened') return { kind: 'skip' };
  payloadBytes(payload, eventBytes);
  if (!exactRepo(repository) || payload.repository?.full_name !== repository) throw invalidInput();

  const pullRequest = eventName === 'pull_request_target';
  if (!pullRequest && Object.hasOwn(payload, 'pull_request')) throw invalidInput();
  const item = pullRequest ? payload.pull_request : payload.issue;
  if (!item || !Number.isSafeInteger(item.number) || item.number <= 0 ||
      !validText(item.title) || typeof item.body !== 'string' && item.body !== null && item.body !== undefined ||
      !validText(item.user?.login) || item.user.login.length > 39) throw invalidInput();

  return {
    kind: pullRequest ? 'pull_request' : 'issue',
    repository,
    number: item.number,
    title: item.title,
    body: item.body ?? null,
    author: item.user.login,
  };
}

export function parsePolicy(inputs = {}) {
  let allowlist = [];
  if (inputs.allowlist !== undefined) {
    if (typeof inputs.allowlist !== 'string') throw invalidInput();
    try {
      allowlist = JSON.parse(inputs.allowlist);
    } catch {
      throw invalidInput();
    }
  }
  if (!Array.isArray(allowlist) || allowlist.some((account) =>
    typeof account !== 'string' || !ACCOUNT_PATTERN.test(account))) throw invalidInput();

  const response = inputs.response === undefined ? DEFAULT_RESPONSE : inputs.response;
  const mode = inputs.mode === undefined ? 'enforce' : inputs.mode;
  const autoClose = inputs.autoClose === undefined || inputs.autoClose === ''
    ? true
    : inputs.autoClose === 'true' ? true : inputs.autoClose === 'false' ? false : null;
  const reviewLabel = inputs.reviewLabel === undefined || inputs.reviewLabel === ''
    ? true
    : inputs.reviewLabel === 'true' ? true : inputs.reviewLabel === 'false' ? false : null;
  if (typeof response !== 'string' || !validText(response) || Buffer.byteLength(response, 'utf8') > RESPONSE_LIMIT ||
      mode !== 'enforce' && mode !== 'observe' || autoClose === null || reviewLabel === null) throw invalidInput();
  if (Object.keys(inputs).some((key) => !['allowlist', 'response', 'mode', 'autoClose', 'reviewLabel'].includes(key))) throw invalidInput();
  return { allowlist, response, cutoff: 0.8, mode, autoClose, reviewLabel };
}

export function createEligibleContinuation({ getContext, getInputs }) {
  return async function run(continueEligible) {
    const context = parseEvent(getContext());
    if (context.kind === 'skip') return { outcome: 'skipped' };
    const policy = parsePolicy(getInputs());
    if (policy.allowlist.some((name) => name.toLowerCase() === context.author.toLowerCase())) return { outcome: 'skipped' };
    if (typeof continueEligible !== 'function') throw new TypeError('An eligible continuation is required.');
    return continueEligible(context, policy);
  };
}
