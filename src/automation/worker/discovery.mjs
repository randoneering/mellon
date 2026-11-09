import { createRepositoryReadSession } from './repository.mjs';

const SHA1 = /^[a-f0-9]{40}$/;
const BRANCH = /^agent-work\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const positive = value => Number.isSafeInteger(value) && value > 0;
const attention = () => Object.freeze({ status: 'needs_attention', reason: 'workflow_discovery_rejected' });

/** Discover only the approved push workflows at one exact head and owned branch. */
export function createWorkflowDiscovery(configuration = {}) {
  const config = { ...configuration };
  const pageLimit = config.pageLimit ?? 10;
  if (!positive(pageLimit) || pageLimit > 10) throw new TypeError('Workflow discovery configuration rejected.');
  return Object.freeze({
    async discoverWorkflowRuns({ manifest, headSha, branch, deadline, signal }) {
      let session;
      try {
        manifest = structuredClone(manifest);
        if (!SHA1.test(headSha ?? '') || !BRANCH.test(branch ?? '')
          || manifest?.repository?.name !== config.repository || manifest.repository.id !== config.repositoryId
          || !Array.isArray(manifest.requiredWorkflowIdentities) || !manifest.requiredWorkflowIdentities.length
          || manifest.requiredWorkflowIdentities.length > 32
          || new Set(manifest.requiredWorkflowIdentities.map(workflow => workflow.id)).size !== manifest.requiredWorkflowIdentities.length) return attention();
        session = createRepositoryReadSession(config, { deadline, signal });
        await session.verifyRepository();
        const runs = [];
        let waiting = false;
        for (const identity of manifest.requiredWorkflowIdentities) {
          if (!positive(identity.id) || identity.event !== 'push' || identity.path !== '.github/workflows/test.yml') return attention();
          const matching = [];
          let seenCount = 0, expectedCount;
          for (let page = 1; ; page += 1) {
            if (page > pageLimit) return attention();
            const query = new URLSearchParams({ branch, head_sha: headSha, event: 'push', per_page: '100', page: String(page) });
            const { data, hasNext } = await session.get(`/repos/${config.repository}/actions/workflows/${identity.id}/runs?${query}`);
            if (!Number.isSafeInteger(data?.total_count) || data.total_count < 0
              || data.total_count > pageLimit * 100 || !Array.isArray(data.workflow_runs)
              || data.workflow_runs.length > 100 || expectedCount !== undefined && expectedCount !== data.total_count) return attention();
            expectedCount = data.total_count;
            for (const run of data.workflow_runs) {
              if (!positive(run?.id) || run.workflow_id !== identity.id || run.run_attempt !== 1
                || run.head_sha !== headSha || run.head_branch !== branch || run.event !== 'push'
                || run.path !== identity.path || run.repository?.id !== config.repositoryId
                || run.repository.full_name !== config.repository || run.head_repository?.id !== config.repositoryId
                || run.head_repository.full_name !== config.repository) return attention();
              matching.push({ workflowId: identity.id, headSha, branch, runId: run.id, runAttempt: 1 });
            }
            seenCount += data.workflow_runs.length;
            if (seenCount > expectedCount || matching.length > 1) return attention();
            if (seenCount === expectedCount) {
              if (hasNext) return attention();
              break;
            }
            if (data.workflow_runs.length !== 100) return attention();
          }
          if (!matching.length) waiting = true;
          else runs.push(matching[0]);
        }
        if (waiting) return Object.freeze({ status: 'waiting', reason: 'workflow_runs_pending' });
        if (new Set(runs.map(run => run.runId)).size !== runs.length) return attention();
        return Object.freeze({ status: 'discovered', runs: Object.freeze(runs.map(Object.freeze)) });
      } catch { return attention(); } finally { session?.close(); }
    },
  });
}
