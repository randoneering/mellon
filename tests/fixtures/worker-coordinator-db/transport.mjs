// Synthetic GitHub/model transport only. No proposed source is executed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createAgentWorker } from '../../../src/automation/worker/agent.mjs';
import { manifest as baseManifest, hash, canonical, blob, HEAD, POLICY, PATH, SOURCE } from '../worker-candidates/inputs.mjs';
import { DATABASE_SKIP_IDENTITIES, DATABASE_SKIP_POLICY_SHA256 } from '../../../automation/ci/report-annotations.mjs';
import { PR_TEMPLATE } from '../agent-worker-publication.mjs';

export { hash, canonical, HEAD, POLICY, PATH };
const ROOT = '/repos/randoneering/mellon';
const actor = { databaseId: 7170, login: 'mellon-worker[bot]' };
const signature = { isValid: true, state: 'VALID', wasSignedByGitHub: true };
const formatterRevision = '6'.repeat(40);
const workflowText = 'name: synthetic trusted workflow\non: push\n';
const formatterText = '// synthetic immutable formatter transport fixture\n';
const producerPaths = ['automation/ci/guard-command.mjs', 'automation/ci/run-tests.mjs',
  'automation/ci/test-reporter.mjs', 'automation/ci/report-annotations.mjs',
  'scripts/lib/output-guard.mjs', 'package.json'];
const producerTexts = new Map(producerPaths.map(path => [path, `synthetic reviewed ${path}\n`]));
const producerSources = producerPaths.map(path => ({ path, sha256: hash(producerTexts.get(path)) }));
const json = (value, status = 200) => Response.json(value, { status });
function content(path, text) {
  return { path, type: 'file', sha: blob(text), encoding: 'base64',
    content: Buffer.from(text).toString('base64'), size: Buffer.byteLength(text) };
}
function tree(files) {
  const entries = new Map();
  for (const [path, text] of files) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const parent = parts.slice(0, i).join('/');
      entries.set(parent, { path: parent, mode: '040000', type: 'tree', sha: '8'.repeat(40) });
    }
    entries.set(path, { path, mode: '100644', type: 'blob', sha: blob(text) });
  }
  return [...entries.values()];
}
export function nativeIdentity(name, path = PATH, line = 4) {
  return hash(canonical({ column: 1, entryFile: path, line, name, nesting: 0, type: 'test' }));
}

export async function controlledTransport(job) {
  const manifest = baseManifest();
  manifest.issue.id = job.issueId; manifest.issue.number = job.issueNumber;
  // The prepared array includes ancestors: regression metadata index differs from allowedPaths index.
  manifest.allowedPaths = ['src/parser.mjs', PATH]; manifest.coordinator.regression.testPathIndex = 1;
  manifest.requiredChecks = [{ context: 'test', appId: 15368, workflowId: 3000 },
    { context: 'test-report', appId: 15368, workflowId: 3000 }];
  manifest.requiredWorkflowIdentities = [{ id: 3000, path: '.github/workflows/test.yml',
    sha256: hash(workflowText), appId: 15368, event: 'push', diagnostics: {
      version: 2, skipPolicy: { version: 1, sha256: DATABASE_SKIP_POLICY_SHA256 },
      sources: producerSources, reporter: { context: 'test-report', revision: formatterRevision,
        sha256: hash(formatterText) },
    } }];
  const bundle = JSON.parse(await readFile(new URL('../../../automation/policy/manifest.json', import.meta.url), 'utf8'));
  const descriptor = source => ({ ...source, hash: source.sha256 });
  const policyManifest = { enabled: true, pilot: { repository: manifest.repository.name,
    issueNumber: manifest.issue.number }, trustedSources: {
      policy: descriptor(bundle.policy), projectRules: descriptor(bundle.projectRules),
      guidance: descriptor(bundle.guidance), skills: bundle.skills.map(skill => ({ ...descriptor(skill),
        references: skill.references.map(descriptor) })),
    } };
  const policyFiles = new Map();
  for (const source of [bundle.policy, bundle.projectRules, bundle.guidance,
    ...bundle.skills.flatMap(skill => [skill, ...skill.references])]) {
    policyFiles.set(source.path, await readFile(new URL(`../../../${source.path}`, import.meta.url), 'utf8'));
  }
  const commits = new Map([[HEAD, { parent: null, treeSha: 'b'.repeat(40), files: new Map() }],
    [POLICY, { parent: null, treeSha: 'e'.repeat(40), files: policyFiles }]]);
  const state = { calls: [], mutations: [], modelCalls: 0, contexts: [], branch: null,
    head: null, prs: [], ci: 'waiting', review: 'waiting', revoked: false,
    loss: null, disposition: 'confirmed', issueOpen: true, runId: null, selected: null,
    producerTamper: null, reportTamper: null, findingIdentity: null };
  const publicationContext = () => {
    const expires = new Date(Date.now() + 60000).toISOString();
    return { token: 'synthetic-app-private', tokenExpiresAt: expires, contextExpiresAt: expires,
      repositoryId: manifest.repository.id, repositoryName: manifest.repository.name,
      appId: 5150, installationId: 6160, actor,
      signingPreflight: { repositoryId: manifest.repository.id, repositoryName: manifest.repository.name,
        appId: 5150, installationId: 6160, expiresAt: expires,
        commit: { oid: '7'.repeat(40), author: actor, committer: { name: 'GitHub', email: 'noreply@github.com' }, signature } } };
  };
  const repository = { id: manifest.repository.id, full_name: manifest.repository.name, name: 'mellon', private: false };
  const run = () => ({ id: 77, run_attempt: 1, workflow_id: 3000,
    repository, head_repository: repository, path: '.github/workflows/test.yml',
    head_sha: state.head, head_branch: state.branch, event: 'push',
    status: state.ci === 'waiting' ? 'in_progress' : 'completed',
    conclusion: state.ci === 'green' ? 'success' : state.ci === 'waiting' ? null : 'failure', check_suite_id: 88 });
  const check = (id, name) => ({ id, name, app: { id: 15368 }, check_suite: { id: 88 },
    head_sha: state.head, status: 'completed', conclusion: name === 'test-report' || state.ci === 'green' ? 'success' : 'failure',
    output: { title: '', summary: '', text: '' }, pull_requests: [] });
  function report() {
    const failed = state.ci !== 'green';
    const identity = state.findingIdentity ?? state.selected?.testIdentitySha256;
    const value = { schemaVersion: 2, complete: true, truncated: false, reason: null,
      context: { repository: manifest.repository.name, headSha: state.head, runId: '77', runAttempt: 1 },
      producerSha256: hash(canonical(producerSources)), skipPolicySha256: DATABASE_SKIP_POLICY_SHA256,
      skippedTestIdentitySha256s: [...DATABASE_SKIP_IDENTITIES],
      counts: { testCount: 63, passedTestCount: failed ? 0 : 1, failedTestCount: failed ? 1 : 0,
        aggregateFailureCount: 0, assertionFailureCount: failed ? 1 : 0, setupFailureCount: 0,
        syntaxFailureCount: 0, otherFailureCount: 0, skippedTestCount: 62, todoTestCount: 0,
        cancelledTestCount: 0, rootFailureCount: 0 },
      failures: failed ? [{ testIdentitySha256: identity, category: 'assertion' }] : [],
      rootFailures: [], processExitCode: failed ? 1 : 0, formatterRevision };
    state.reportTamper?.(value);
    return value;
  }
  function expectedEvidence(reviewId = null) {
    // Independent oracle from the controlled API packets, not the parser or database.
    const packet = run();
    const checks = [check(101, 'test'), check(103, 'test-report')].map(value => ({
      checkRunId: value.id, checkSuiteId: value.check_suite.id, appId: value.app.id,
      status: value.status, conclusion: value.conclusion, headSha: value.head_sha,
    }));
    const workflow = { workflowId: packet.workflow_id, runId: packet.id,
      runAttempt: packet.run_attempt, headSha: packet.head_sha, checks };
    if (state.ci === 'green') {
      const value = report();
      workflow.diagnostic = { schemaVersion: value.schemaVersion, complete: true,
        producerSha256: value.producerSha256, testCount: value.counts.testCount,
        passedTestCount: value.counts.passedTestCount, skippedTestCount: value.counts.skippedTestCount,
        skipPolicySha256: value.skipPolicySha256,
        skippedTestIdentitySha256s: [...value.skippedTestIdentitySha256s],
        processExitCode: value.processExitCode };
    }
    return { headSha: packet.head_sha, workflowId: packet.workflow_id,
      workflowRunId: packet.id, checkRunId: checks[0].checkRunId, reviewId,
      checksSha256: hash(canonical({ repositoryId: packet.repository.id,
        headSha: packet.head_sha, branch: packet.head_branch, event: packet.event,
        runs: [workflow], checks })) };
  }
  function syntheticFutureReview() {
    // This private, future adapter shape is NOT an observed Qodo completion format.
    return { status: 'complete', authenticated: true, repository: manifest.repository.name,
      repositoryId: manifest.repository.id, pullNumber: state.prs[0]?.number,
      headSha: state.head, draft: true, state: 'open', reviewId: 900,
      findings: state.review === 'finding' ? [{ findingSha256: hash(`synthetic finding ${state.head}`),
        assertions: [{ workflowId: 3000, runId: 77, runAttempt: 1, category: 'assertion',
          testIdentitySha256: state.findingIdentity ?? state.selected.testIdentitySha256,
          producerSha256: hash(canonical(producerSources)), formatterRevision,
          reportSha256: hash(canonical(report())) }] }] : [] };
  }
  async function fetch(url, init = {}) {
    const target = new URL(url); const method = init.method ?? 'GET';
    assert.equal(target.origin === 'https://api.github.com', true);
    assert.equal(['manual', 'error'].includes(init.redirect), true);
    assert.equal(Boolean(init.signal), true);
    const path = target.pathname.replace(ROOT, '');
    state.calls.push({ path, method });
    if (state.beforeHTTP) await state.beforeHTTP({ path, method });
    if (path === '' && method === 'GET') return json(repository);
    if (path === `/issues/${job.issueNumber}`) return json({ id: job.issueId, number: job.issueNumber,
      repository_url: `https://api.github.com${ROOT}`, state: state.issueOpen ? 'open' : 'closed',
      title: 'approved title', body: 'approved body' });
    if (path === `/issues/${job.issueNumber}/labels`) return json(state.revoked ? [] : [{ name: 'agent: ready' }]);
    if (target.pathname === '/users/maintainer') return json({ id: 42, login: 'maintainer', type: 'User' });
    if (path === '/collaborators/maintainer/permission') return json({ permission: 'write', user: { id: 42, login: 'maintainer', type: 'User' } });
    if (path === '/branches/main') return json({ name: 'main', commit: { sha: HEAD } });
    if (path.startsWith('/git/ref/heads/')) return state.head ? json({ ref: `refs/heads/${state.branch}`,
      object: { type: 'commit', sha: state.head } }) : json({}, 404);
    if (path === '/git/refs' && method === 'POST') {
      const body = JSON.parse(init.body);
      assert.equal(body.ref === `refs/heads/agent-work/${state.runId}`, true);
      assert.equal(body.sha, HEAD);
      state.branch = `agent-work/${state.runId}`; state.head = HEAD;
      state.mutations.push('branch');
      if (state.afterMutation) await state.afterMutation('branch');
      if (state.loss === 'branch') throw new Error('Synthetic lost HTTP acknowledgment.');
      return json({ ref: body.ref, object: { type: 'commit', sha: HEAD } }, 201);
    }
    if (path.startsWith('/git/commits/')) {
      const sha = path.split('/').at(-1); const value = commits.get(sha);
      assert.equal(Boolean(value), true, 'Fixed immutable commit must exist.');
      return json({ sha, tree: { sha: value.treeSha }, parents: value.parent ? [{ sha: value.parent }] : [] });
    }
    if (path.startsWith('/git/trees/')) {
      const sha = path.split('/').at(-1); const value = [...commits.values()].find(commit => commit.treeSha === sha);
      assert.equal(Boolean(value), true, 'Fixed immutable tree must exist.');
      return json({ sha, truncated: false, tree: tree(value.files) });
    }
    if (path.startsWith('/git/blobs/')) {
      const sha = path.split('/').at(-1);
      const text = [...commits.values()].flatMap(commit => [...commit.files.values()]).find(text => blob(text) === sha);
      assert.equal(typeof text, 'string'); return json({ ...content('', text), sha });
    }
    if (target.pathname === '/graphql') {
      const body = JSON.parse(init.body);
      if (body.query.includes('mutation AgentWorkerCreateCommit')) {
        const input = body.variables.input;
        assert.equal(input.expectedHeadOid === state.head, true);
        assert.equal(input.branch.branchName === state.branch, true);
        const files = new Map(commits.get(state.head).files);
        for (const change of input.fileChanges.additions) {
          assert.equal(manifest.allowedPaths.includes(change.path), true);
          files.set(change.path, Buffer.from(change.contents, 'base64').toString('utf8'));
        }
        assert.equal(input.fileChanges.deletions === undefined, true);
        const sha = createHash('sha1').update(`synthetic commit ${commits.size}`).digest('hex');
        commits.set(sha, { parent: state.head, files, treeSha: createHash('sha1').update(`tree ${sha}`).digest('hex') });
        state.head = sha; state.mutations.push('commit');
        if (state.afterMutation) await state.afterMutation('commit');
        if (state.loss === 'commit') throw new Error('Synthetic lost HTTP acknowledgment.');
        return json({ data: { createCommitOnBranch: { commit: { oid: sha }, ref: {
          name: state.branch, prefix: 'refs/heads/', target: { oid: sha } } } } });
      }
      assert.equal(body.query.includes('query AgentWorkerCommitProof'), true);
      const sha = body.variables.oid; const value = commits.get(sha);
      return json({ data: { repository: { databaseId: manifest.repository.id, nameWithOwner: manifest.repository.name,
        object: { oid: sha, tree: { oid: value.treeSha }, parents: { nodes: value.parent ? [{ oid: value.parent }] : [] },
          author: { user: actor }, committer: { name: 'GitHub', email: 'noreply@github.com', user: null }, signature },
        ref: { name: state.branch, prefix: 'refs/heads/', target: { oid: state.head } } } } });
    }
    if (path === '/contents/.github/PULL_REQUEST_TEMPLATE.md') return json(content('.github/PULL_REQUEST_TEMPLATE.md', PR_TEMPLATE));
    if (path.startsWith('/contents/')) {
      const file = path.slice('/contents/'.length);
      let text = file === '.github/workflows/test.yml' ? workflowText
        : file === 'automation/ci/report-annotations.mjs' && target.searchParams.get('ref') === formatterRevision ? formatterText : producerTexts.get(file);
      if (state.producerTamper === file) text += 'tampered';
      assert.equal(typeof text, 'string'); return json(content(file, text));
    }
    if (path === '/actions/workflows/3000/runs') return json({ total_count: 1, workflow_runs: [run()] });
    if (path === '/actions/runs/77') return json(run());
    if (path === '/check-suites/88/check-runs') return json({ total_count: 2, check_runs: [check(101, 'test'), check(103, 'test-report')] });
    if (path === '/actions/runs/77/attempts/1/jobs') return json({ total_count: 2, jobs: [
      { id: 99, run_id: 77, run_attempt: 1, check_run_url: `https://api.github.com${ROOT}/check-runs/101`,
        head_sha: state.head, status: 'completed', conclusion: state.ci === 'green' ? 'success' : 'failure',
        steps: [{ name: 'Install dependencies', status: 'completed', conclusion: 'success' },
          { name: 'Run JavaScript tests', status: 'completed', conclusion: state.ci === 'green' ? 'success' : 'failure' }] },
      { id: 199, run_id: 77, run_attempt: 1, check_run_url: `https://api.github.com${ROOT}/check-runs/103`,
        head_sha: state.head, status: 'completed', conclusion: 'success', steps: [
          { name: 'Format bounded untrusted test report', status: 'completed', conclusion: 'success' }] },
    ] });
    if (path === '/check-runs/103/annotations') return json([{ annotation_level: 'notice', title: 'Mellon CI evidence',
      message: `MELLON_CI_REPORT_V2:${Buffer.from(JSON.stringify(report())).toString('base64url')}`,
      path: '.github/workflows/test.yml', start_line: 1, end_line: 1 }]);
    if (path === '/pulls' && method === 'POST') {
      const body = JSON.parse(init.body); assert.equal(body.draft, true);
      const pr = { id: 8001, number: 31, state: 'open', draft: true, merged_at: null,
        title: body.title, body: body.body, user: { id: actor.databaseId, login: actor.login, type: 'Bot' },
        head: { ref: state.branch, sha: state.head, label: `randoneering:${state.branch}`,
          repo: { ...repository, owner: { login: 'randoneering' } } },
        base: { ref: 'main', sha: HEAD, repo: { ...repository, owner: { login: 'randoneering' } } } };
      state.prs.push(pr); state.mutations.push('draft');
      if (state.afterMutation) await state.afterMutation('draft');
      if (state.loss === 'draft') throw new Error('Synthetic lost HTTP acknowledgment.');
      return json(pr, 201);
    }
    if (path === '/pulls') return json(state.prs.map(pr => ({ ...pr, head: { ...pr.head, sha: state.head } })));
    if (path === '/pulls/31') return json({ ...state.prs[0],
      ...(state.reviewResponseDraft === false ? { draft: false } : {}), head: { ...state.prs[0].head, sha: state.head } });
    if (path === '/pulls/31/reviews') return json(state.reviewObjects ?? []);
    if (path === '/pulls/31/comments') return json([]);
    if (path.startsWith('/check-runs/') && path.endsWith('/annotations')) return json([]);
    throw new Error('Unregistered synthetic fixed API resource.');
  }
  const model = { config: { gateway: { baseURL: 'https://gateway.example', apiKey: 'synthetic-model-private' }, modelId: manifest.model.id },
    tokenizer: { modelId: manifest.model.id, renderer: 'neon-chat-v1', countRendered: () => 500 },
    sdk: { model: {}, async generateText(options) {
      state.modelCalls += 1;
      if (state.beforeModel) await state.beforeModel();
      if (state.modelFailure) throw new Error('Synthetic provider uncertainty.');
      const context = state.contexts.at(-1); const phase = state.phase;
      const testing = phase.purpose.endsWith('_tests');
      const path = testing ? PATH : 'src/parser.mjs';
      const file = context.files.find(file => file.path === path);
      const name = phase.repairCycle ? manifest.coordinator.regression.repairTestNames[phase.repairCycle - 1]
        : manifest.coordinator.regression.initial.testName;
      const source = testing ? SOURCE.replace('approved regression location', name) : `export const fixed = ${phase.repairCycle + 1};`;
      const changes = [{ operation: file.mode === null ? 'create' : 'modify', path, content: source,
        ...(file.mode === null ? {} : { expectedBlobSha: file.blobSha }) }];
      const investigation = context.investigation;
      const assessment = investigation && { disposition: state.disposition, findingSha256: investigation.findingSha256,
        ...investigation.criteria[0], references: investigation.references };
      const receipt = await options.tools.proposeChanges.execute({ baseSha: context.repository.baseSha,
        manifestHash: context.manifest.hash, changes: assessment && assessment.disposition !== 'confirmed' ? [] : changes,
        ...(assessment ? { assessment } : {}) });
      assert.equal(['proposed', 'assessed'].includes(receipt.status), true);
      return { text: '', steps: [], usage: { inputTokens: 100, outputTokens: 20 },
        response: { body: { usage: { prompt_tokens: 100, completion_tokens: 20 } } }, finishReason: 'stop' };
    } } };
  const controlledFetch = async (url, init) => {
    const response = await fetch(url, init);
    return state.transformHTTP ? state.transformHTTP(new URL(url).pathname.replace(ROOT, ''), response) : response;
  };
  return { manifest, policyManifest, state, commits, actor, fetch: controlledFetch, model, syntheticFutureReview, expectedEvidence,
    // Captures the real factory's context without substituting its validation or execution.
    createAgentWorker(options) { return createAgentWorker({ ...options,
      loadContext: async () => { const context = await options.loadContext(); state.contexts.push(context); return context; } }); },
    publicationDependencies: { fetch: controlledFetch, timeoutMs: 10000, getPublicationContext: async () => publicationContext(),
      getPullRequestContext: async () => { const publication = publicationContext(); return { publicationContext: publication,
        installationToken: { repositoryId: publication.repositoryId, repositoryName: publication.repositoryName,
          appId: publication.appId, installationId: publication.installationId, tokenExpiresAt: publication.tokenExpiresAt,
          tokenSha256: hash(publication.token), permissions: { metadata: 'read', contents: 'write', pull_requests: 'write' } } }; } } };
}
