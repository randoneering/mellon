import { readFileSync } from 'node:fs';

export const OBSERVED_SUBMITTED_REVIEW = JSON.parse(readFileSync(
  new URL('./observed-pr20.json', import.meta.url), 'utf8',
));
export const SUBMITTED_IDENTITY = Object.freeze({
  userId: 151058649, appId: 484649, appSlug: 'qodo-code-review',
  completion: 'github-submitted-review-v1',
});

export function submittedReviewApi({ repositoryId = 1234, pullNumber = 8,
  headSha = 'a'.repeat(40), comments = [], mutate } = {}) {
  const calls = [];
  const root = '/repos/randoneering/mellon';
  const pullUrl = `https://api.github.com${root}/pulls/${pullNumber}`;
  const head = () => typeof headSha === 'function' ? headSha() : headSha;
  const fetch = async (url, options) => {
    const path = decodeURIComponent(new URL(url).pathname);
    calls.push({ url: String(url), path, options });
    let data;
    if (path === `${root}/pulls/${pullNumber}`) {
      // The real observation is closed; this open draft is a controlled transport fixture.
      data = { number: pullNumber, state: 'open', draft: true,
        head: { sha: head() }, base: { repo: { id: repositoryId,
          full_name: 'randoneering/mellon' } } };
    } else if (path === `${root}/pulls/${pullNumber}/reviews`) {
      data = [{ ...structuredClone(OBSERVED_SUBMITTED_REVIEW.review),
        id: 81, commit_id: head(), pull_request_url: pullUrl }];
    } else if (path === `${root}/pulls/${pullNumber}/comments`) {
      data = structuredClone(typeof comments === 'function' ? comments() : comments);
    } else if (path === '/apps/qodo-code-review') {
      data = structuredClone(OBSERVED_SUBMITTED_REVIEW.app);
    } else if (path === '/users/qodo-code-review[bot]') {
      data = structuredClone(OBSERVED_SUBMITTED_REVIEW.bot);
    } else throw new Error('Unscripted submitted-review fixture route.');
    if (mutate) data = await mutate({ path, data });
    return data instanceof Response ? data : Response.json(data);
  };
  return { calls, fetch, pullUrl };
}
