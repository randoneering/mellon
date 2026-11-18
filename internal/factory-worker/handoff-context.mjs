// Trusted stage context is separate from issue text and review findings.
export function sourceStageContext(job) {
  const rebuild = job.requiresRebuild === true;
  return [
    'Stage: source-candidate, before build and publication.',
    `Approved edit paths: ${JSON.stringify(job.allowedPaths)}.`,
    'The isolated runner owns generated dist/ output; the coding worker must never edit dist/ or expand the approved paths.',
    rebuild
      ? 'This job requires a rebuild. After source review and owner approval, n8n must create the signed source commit, invoke the isolated runner on that exact commit, validate its artifacts, and publish the required generated files before opening the draft PR.'
      : 'This job declares no rebuild. If its actual changes need generated output, flag the declaration mismatch and stop; do not assume a later build will fix it.',
    'A planned later step is not evidence that it succeeded. Final publication still requires the applicable build, artifact, signature and head checks.',
  ].join('\n');
}

export function workerStageContext(job) {
  return sourceStageContext(job) + '\n'
    + 'Implement or repair only the approved source/test/doc paths. Do not expand scope because a reviewer names another file. '
    + 'If a finding asks for a runner-owned rebuild or an out-of-scope edit, explain the conflict instead of making that edit. '
    + 'Do not claim build, review or final gate success. No commits, pushes, publication or PR comments from the worker.';
}

export function reviewerStageContext(job) {
  return sourceStageContext(job) + '\n'
    + (job.requiresRebuild === true
      ? 'Unchanged dist/ at this source-candidate stage is expected, not by itself a missing implementation. Do not request that the worker rebuild it. '
      : '')
    + 'Continue reporting source defects, missing tests, incompatible generated interfaces, and missing or contradictory rebuild requirements. '
    + 'Do not ignore dist/ globally or claim final artifact correctness from source review. '
    + 'Report real documentation gaps even outside the edit scope, identifying them as scope conflicts for the owner; do not authorize additional paths. '
    + 'Keep reported severity separate from action level; never guess severity. Low findings stay unchanged, unclassified findings require owner assessment.';
}
