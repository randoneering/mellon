const API_ROOT = 'https://api.github.com';
const SAFE_ERROR = 'GitHub submission request failed safely.';
const REQUEST_TIMEOUT_MS = 5000;

export function parseSubmissionUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Unsupported GitHub submission URL.');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('Unsupported GitHub submission URL.');
  }
  const match = url.pathname.match(/^\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/(issues|pull)\/(\d+)\/?$/);
  if (!match || !Number.isSafeInteger(Number(match[4])) || Number(match[4]) <= 0) {
    throw new Error('Unsupported GitHub submission URL.');
  }
  const [, owner, repo, pathKind, rawNumber] = match;
  const kind = pathKind === 'issues' ? 'issue' : 'pull_request';
  const number = Number(rawNumber);
  return { owner, repo, kind, number, canonicalUrl: `https://github.com/${owner}/${repo}/${pathKind}/${number}` };
}

export function parseRepository(value) {
  if (typeof value !== 'string') throw new Error('Enter owner/repo or an HTTPS GitHub repository URL.');
  const match = value.match(/^(?:https:\/\/github\.com\/)?([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/?$/);
  if (!match || ['.', '..'].includes(match[2])) {
    throw new Error('Enter owner/repo or an HTTPS GitHub repository URL.');
  }
  return { owner: match[1], repo: match[2] };
}

export async function discoverRepositoryUrls(repository, { issues, pullRequests }, token, fetchImpl = fetch) {
  const { owner, repo } = parseRepository(repository);
  if (![issues, pullRequests].every(count => Number.isInteger(count) && count >= 0 && count <= 100)
      || issues + pullRequests === 0) {
    throw new Error('Issue and PR counts must be integers from 0 to 100, with at least one positive count.');
  }
  if (typeof token !== 'string' || !token || typeof fetchImpl !== 'function') {
    throw new Error('Set GH_TOKEN or GITHUB_TOKEN for read-only GitHub access.');
  }
  const urls = [];
  const seen = new Set();
  for (const [endpoint, kind, limit] of [['issues', 'issues', issues], ['pulls', 'pull', pullRequests]]) {
    let selected = 0;
    for (let page = 1; selected < limit && page <= 10; page++) {
      let items;
      try {
        const url = `${API_ROOT}/repos/${owner}/${repo}/${endpoint}?state=all&sort=created&direction=desc&per_page=100&page=${page}`;
        const response = await fetchImpl(url, {
          method: 'GET', redirect: 'manual',
          headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok || response.status >= 300 && response.status < 400) throw new Error();
        items = await response.json();
        if (!Array.isArray(items) || items.length > 100) throw new Error();
        for (const item of items) {
          if (!item || !Number.isSafeInteger(item.number) || item.number <= 0) throw new Error();
          if (endpoint === 'issues' && Object.hasOwn(item, 'pull_request')) continue;
          const canonicalUrl = `https://github.com/${owner}/${repo}/${kind}/${item.number}`;
          if (seen.has(canonicalUrl)) continue;
          seen.add(canonicalUrl);
          urls.push(canonicalUrl);
          selected++;
          if (selected === limit) break;
        }
      } catch {
        throw new Error('Repository discovery failed. Check repository access and GitHub rate limits, then retry.');
      }
      if (items.length < 100 || selected === limit) break;
      if (page === 10) {
        throw new Error('Repository discovery reached its scan limit. Choose fewer issues or PRs and retry.');
      }
    }
  }
  return urls;
}

export async function fetchSubmission(parsed, token, fetchImpl = fetch) {
  if (!parsed || typeof parsed.owner !== 'string' || !/^[A-Za-z0-9-]+$/.test(parsed.owner) ||
      typeof parsed.repo !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(parsed.repo) ||
      !['issue', 'pull_request'].includes(parsed.kind) || !Number.isSafeInteger(parsed.number) || parsed.number <= 0 ||
      typeof token !== 'string' || !token || typeof fetchImpl !== 'function') {
    throw new Error(SAFE_ERROR);
  }
  let canonical;
  try {
    canonical = parseSubmissionUrl(parsed.canonicalUrl);
  } catch {
    throw new Error(SAFE_ERROR);
  }
  if (['owner', 'repo', 'kind', 'number'].some(key => canonical[key] !== parsed[key])) {
    throw new Error(SAFE_ERROR);
  }
  const endpoint = `${API_ROOT}/repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}`;
  try {
    const response = await fetchImpl(endpoint, {
      method: 'GET', redirect: 'manual',
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok || response.status >= 300 && response.status < 400) throw new Error(SAFE_ERROR);
    const data = await response.json();
    if (!data || typeof data.title !== 'string' || data.body !== null && typeof data.body !== 'string') {
      throw new Error(SAFE_ERROR);
    }
    return { title: data.title, body: data.body ?? '' };
  } catch {
    throw new Error(SAFE_ERROR);
  }
}
