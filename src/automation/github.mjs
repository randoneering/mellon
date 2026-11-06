import { positiveId, readBytes, validRepository } from './http.mjs';

const SAFE_ERROR = 'GitHub eligibility check unavailable.';
const LOGIN = /^[a-z\d](?:[a-z\d-]{0,38})$/i;
const PERMISSIONS = new Set(['admin', 'maintain', 'write', 'triage', 'read', 'none']);

export function createGitHubReader({ token, repository, fetchImpl = fetch, timeoutMs = 10000 }) {
  if (typeof token !== 'string' || !token || !validRepository(repository) ||
      typeof fetchImpl !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Invalid GitHub intake configuration.');
  }
  const root = `https://api.github.com/repos/${repository.fullName}`;
  async function read(suffix) {
    const controller = new AbortController();
    const deadline = Date.now() + timeoutMs;
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error(SAFE_ERROR)); }, timeoutMs);
    });
    let response;
    try {
      response = await Promise.race([
        fetchImpl(`${root}${suffix}`, {
          method: 'GET', redirect: 'manual', signal: controller.signal,
          headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
        }),
        expired,
      ]);
      if (response.status !== 200) throw new Error(SAFE_ERROR);
      const bytes = await Promise.race([
        readBytes(response.body, 256 * 1024, Math.max(1, deadline - Date.now())), expired,
      ]);
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
      throw new Error(SAFE_ERROR);
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    async authorizeSender(sender) {
      if (!positiveId(sender?.id) || sender.type !== 'User' || !LOGIN.test(sender.login ?? '')) throw new Error(SAFE_ERROR);
      const data = await read(`/collaborators/${encodeURIComponent(sender.login)}/permission`);
      if (!data || !PERMISSIONS.has(data.permission) || data.user?.id !== sender.id ||
          data.user?.type !== 'User' || typeof data.user?.login !== 'string' ||
          data.user.login.toLowerCase() !== sender.login.toLowerCase()) throw new Error(SAFE_ERROR);
      return ['admin', 'maintain', 'write'].includes(data.permission);
    },
    async readIssue(number) {
      if (!positiveId(number)) throw new Error(SAFE_ERROR);
      const issue = await read(`/issues/${number}`);
      if (!issue || !positiveId(issue.id) || issue.number !== number ||
          typeof issue.repository_url !== 'string' || issue.repository_url.toLowerCase() !== root.toLowerCase() ||
          !['open', 'closed'].includes(issue.state) || !Array.isArray(issue.labels) ||
          !issue.labels.every(label => label && typeof label.name === 'string')) throw new Error(SAFE_ERROR);
      return issue;
    },
  };
}
