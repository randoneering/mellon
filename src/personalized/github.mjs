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
