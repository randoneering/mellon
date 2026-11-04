const API_ROOT = 'https://api.github.com';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_PAGES = 100;
const REVIEW_LABEL = 'mellon: review';
export const OUTCOME_LABELS = Object.freeze([
  Object.freeze({ name: 'mellon: reviewed-human', color: '0e8a16', description: 'Maintainer assessed the submission text as human-like.' }),
  Object.freeze({ name: 'mellon: reviewed-ai', color: 'd73a4a', description: 'Maintainer assessed the submission text as AI-like.' }),
  Object.freeze({ name: 'mellon: reviewed-unsure', color: 'fbca04', description: 'Maintainer could not confidently assess the submission text.' }),
]);

function safeError(status) {
  const error = new Error('GitHub API request failed safely.');
  if (Number.isInteger(status)) Object.defineProperty(error, 'status', { value: status });
  return error;
}

function resource(repository, number, suffix = '') {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      !Number.isSafeInteger(number) || number <= 0) throw safeError();
  return `${API_ROOT}/repos/${repository}/issues/${number}${suffix}`;
}

function parseLinkNext(header, current) {
  if (!header) return null;
  const next = header.split(',').map((part) => {
    const match = part.match(/^\s*<([^>]+)>\s*;\s*rel="([^"]+)"\s*$/);
    if (!match) throw safeError();
    if (match[2].split(/\s+/).includes('next')) return match[1];
    return null;
  }).find(Boolean);
  if (!next) return null;
  let candidate;
  try {
    candidate = new URL(next, current);
  } catch {
    throw safeError();
  }
  const expected = new URL(current);
  if (candidate.origin !== API_ROOT || candidate.username || candidate.password ||
      candidate.pathname !== expected.pathname || candidate.hash || !candidate.searchParams.has('page')) {
    throw safeError();
  }
  if (candidate.searchParams.getAll('page').length !== 1 || !/^\d+$/.test(candidate.searchParams.get('page')) ||
      candidate.searchParams.getAll('per_page').length > 1 || candidate.searchParams.has('per_page') && candidate.searchParams.get('per_page') !== '100' ||
      [...candidate.searchParams.keys()].some((key) => !['page', 'per_page'].includes(key))) throw safeError();
  return candidate.href;
}

async function readBounded(response, maxBodyBytes) {
  if (!response.body) throw safeError();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBodyBytes) {
        await reader.cancel();
        throw safeError();
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    try { await reader.cancel(); } catch { /* response is already cancelled */ }
    throw safeError();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw safeError();
  }
}

function validateItem(value) {
  if (!value || typeof value !== 'object' || !['open', 'closed'].includes(value.state) ||
      typeof value.title !== 'string' || value.body !== null && typeof value.body !== 'string' ||
      value.merged !== undefined && typeof value.merged !== 'boolean') throw safeError();
  return { state: value.state, title: value.title, body: value.body, merged: value.merged === true };
}

function validateComments(value) {
  if (!Array.isArray(value) || value.some((comment) => !comment || typeof comment !== 'object' ||
      !Number.isSafeInteger(comment.id) || comment.id <= 0 || typeof comment.body !== 'string' ||
      !comment.user || typeof comment.user.login !== 'string' || typeof comment.user.type !== 'string')) throw safeError();
  return value.map((comment) => ({ id: comment.id, body: comment.body, user: { login: comment.user.login, type: comment.user.type } }));
}

function validateLabels(value) {
  if (!Array.isArray(value) || value.some((label) => !label || typeof label !== 'object' ||
      typeof label.name !== 'string')) throw safeError();
  return value.map((label) => ({ name: label.name }));
}

function labelName(value) {
  if (!value || typeof value !== 'object' || typeof value.name !== 'string') throw safeError();
  return value.name;
}

function outcomeLabel(name) {
  const label = OUTCOME_LABELS.find((candidate) => candidate.name === name);
  if (!label) throw safeError();
  return label;
}

export function createGitHubClient({ token, fetchImpl = fetch, timeoutMs = 30_000, signal, maxBodyBytes = MAX_BODY_BYTES } = {}) {
  if (typeof token !== 'string' || !token || typeof fetchImpl !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new TypeError('A token, fetch implementation, and positive limits are required.');
  }
  function requestError(status) {
    const error = safeError();
    Object.defineProperty(error, 'status', { value: status });
    return error;
  }
  async function request(url, { method = 'GET', body } = {}) {
    let parsedURL;
    try { parsedURL = new URL(url); } catch { throw safeError(); }
    if (parsedURL.origin !== API_ROOT || parsedURL.username || parsedURL.password) throw safeError();
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) controller.abort(signal.reason);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method, redirect: 'manual', signal: controller.signal,
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status >= 300 && response.status < 400 || !response.ok) {
        throw requestError(response.status);
      }
      return { value: await readBounded(response, maxBodyBytes), link: response.headers.get('link') };
    } catch (error) {
      if (Number.isInteger(error?.status)) throw error;
      throw safeError();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  async function listLabels(context) {
    const base = resource(context.repository, context.number, '/labels') + '?per_page=100';
    let url = base;
    const labels = [];
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const result = await request(url);
      labels.push(...validateLabels(result.value));
      url = parseLinkNext(result.link, url);
    }
    if (url) throw safeError();
    return labels;
  }
  return {
    async getReviewLabel({ repository }) {
      if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw safeError();
      const url = `${API_ROOT}/repos/${repository}/labels/${encodeURIComponent(REVIEW_LABEL)}`;
      try {
        const { value } = await request(url);
        if (labelName(value) !== REVIEW_LABEL) throw safeError();
        return { exists: true };
      } catch (error) {
        if (error?.status === 404) return { exists: false };
        throw safeError();
      }
    },
    async createReviewLabel({ repository }) {
      if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw safeError();
      const url = `${API_ROOT}/repos/${repository}/labels`;
      const body = { name: REVIEW_LABEL, color: 'fbca04', description: 'Flagged by Mellon for maintainer review.' };
      const { value } = await request(url, { method: 'POST', body });
      if (labelName(value) !== REVIEW_LABEL) throw safeError();
      return { confirmed: true };
    },
    async getOutcomeLabel({ repository, name }) {
      const label = outcomeLabel(name);
      if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw safeError();
      const url = `${API_ROOT}/repos/${repository}/labels/${encodeURIComponent(label.name)}`;
      try {
        const { value } = await request(url);
        if (labelName(value).toLowerCase() !== label.name) throw safeError();
        return { exists: true };
      } catch (error) {
        if (error?.status === 404) return { exists: false };
        throw safeError();
      }
    },
    async createOutcomeLabel({ repository, name }) {
      const label = outcomeLabel(name);
      if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw safeError();
      const url = `${API_ROOT}/repos/${repository}/labels`;
      const { value } = await request(url, { method: 'POST', body: label });
      if (labelName(value).toLowerCase() !== label.name) throw safeError();
      return { confirmed: true };
    },
    async getItemLabels(context) {
      return listLabels(context);
    },
    async addLabel({ repository, number }) {
      const url = resource(repository, number, '/labels');
      const { value } = await request(url, { method: 'POST', body: { labels: [REVIEW_LABEL] } });
      const labels = validateLabels(value);
      if (!labels.some(label => label.name === REVIEW_LABEL)) throw safeError();
      return { confirmed: true };
    },
    async getItem({ repository, number, kind }) {
      if (kind !== 'issue' && kind !== 'pull_request') throw safeError();
      const issueURL = resource(repository, number);
      const url = kind === 'pull_request' ? issueURL.replace(`/issues/${number}`, `/pulls/${number}`) : issueURL;
      const result = await request(url);
      if (kind === 'pull_request' && typeof result.value?.merged !== 'boolean') throw safeError();
      return validateItem(result.value);
    },
    async listComments({ repository, number }) {
      const base = resource(repository, number, '/comments') + '?per_page=100';
      let url = base;
      const comments = [];
      for (let page = 0; url && page < MAX_PAGES; page++) {
        const result = await request(url);
        comments.push(...validateComments(result.value));
        url = parseLinkNext(result.link, url);
      }
      if (url) throw safeError();
      return comments;
    },
    async createComment({ repository, number, body }) {
      if (typeof body !== 'string' || !body) throw safeError();
      const { value } = await request(resource(repository, number, '/comments'), { method: 'POST', body: { body } });
      const [comment] = validateComments([value]);
      if (comment.user.login !== 'github-actions[bot]' || comment.user.type !== 'Bot' || comment.body !== body) throw safeError();
      return comment;
    },
    async closeItem({ repository, number, kind }) {
      if (kind !== 'issue' && kind !== 'pull_request') throw safeError();
      const issueURL = resource(repository, number);
      const url = kind === 'pull_request'
        ? issueURL.replace(`/issues/${number}`, `/pulls/${number}`)
        : issueURL;
      const { value } = await request(url, { method: 'PATCH', body: { state: 'closed' } });
      if (!value || value.state !== 'closed') throw safeError();
      return { state: 'closed' };
    },
  };
}
