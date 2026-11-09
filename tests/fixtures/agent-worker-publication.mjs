import { createHash } from 'node:crypto';
import { DATABASE_SKIP_IDENTITIES } from '../../automation/ci/report-annotations.mjs';

export const RUN_ID = '5f147ca8-9f46-48e8-90b0-49fb8e65a704';
export const BASE_SHA = 'a'.repeat(40);
export const BASE_TREE_SHA = 'b'.repeat(40);
export const COMMIT_SHA = 'c'.repeat(40);
export const COMMIT_TREE_SHA = 'd'.repeat(40);
export const REPOSITORY_ID = 123456;
export const APP_ID = 5150;
export const INSTALLATION_ID = 6160;
export const BOT_ID = 7170;
export const BOT_LOGIN = 'mellon-worker[bot]';
export const TOKEN = 'fixture-token-that-must-not-escape';
export const CHANGE_PATH = 'src/example.txt';
export const CHANGE_CONTENT = 'approved content\n';

const BRANCH = `agent-work/${RUN_ID}`;
const POLICY_REVISION = 'e'.repeat(40);
const INTENT_ID = 'f'.repeat(64);
const FOREIGN_SHA = '9'.repeat(40);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function blobSha(content) {
  const bytes = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function actor() {
  return { databaseId: BOT_ID, login: BOT_LOGIN };
}

function signature(overrides = {}) {
  return {
    isValid: true,
    state: 'VALID',
    wasSignedByGitHub: true,
    ...overrides,
  };
}

function manifest(overrides = {}) {
  return {
    repository: { id: REPOSITORY_ID, name: 'randoneering/mellon' },
    issue: { id: 9001, number: 21, contentSha256: '1'.repeat(64) },
    approver: { id: 42, login: 'maintainer' },
    base: { branch: 'main', revision: BASE_SHA },
    policyRevision: POLICY_REVISION,
    pilotScope: {
      kind: 'bounded-public-issue',
      maxChangedFiles: 10,
      maxFileBytes: 65536,
      maxTotalBytes: 262144,
    },
    allowedPaths: [CHANGE_PATH],
    ...overrides,
  };
}

function treeRows(additions, options) {
  const rows = new Map();
  for (const addition of additions) {
    const parts = addition.path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const path = parts.slice(0, index).join('/');
      rows.set(path, {
        path,
        mode: '040000',
        type: 'tree',
        sha: '8'.repeat(40),
      });
    }
    const content = Buffer.from(addition.contents, 'base64').toString('utf8');
    rows.set(addition.path, {
      path: addition.path,
      mode: options.committedMode ?? '100644',
      type: 'blob',
      sha: blobSha(content),
    });
  }
  if (options.extraPath) {
    rows.set(options.extraPath, {
      path: options.extraPath,
      mode: '100644',
      type: 'blob',
      sha: blobSha('foreign change'),
    });
  }
  return [...rows.values()];
}

export function createPublisherFixture(options = {}) {
  const calls = [];
  const state = {
    branchHead: options.initialBranchHead ?? null,
    branchWrites: 0,
    commitWrites: 0,
    approvalCalls: 0,
    fenceCalls: [],
    contextCalls: 0,
    commitTree: [],
  };
  const approvedManifest = manifest(options.manifest ?? {});
  const request = {
    run: {
      id: RUN_ID,
      repositoryId: REPOSITORY_ID,
      issueId: approvedManifest.issue.id,
      issueNumber: approvedManifest.issue.number,
      approverId: approvedManifest.approver.id,
      manifestSha256: sha256(canonical(approvedManifest)),
      baseSha: approvedManifest.base.revision,
      expectedHeadSha: options.expectedHeadSha ?? approvedManifest.base.revision,
      generation: 1,
    },
    intent: { id: INTENT_ID },
    approvedManifest,
    proposedChanges: options.proposedChanges ?? [
      { operation: 'create', path: CHANGE_PATH, content: CHANGE_CONTENT },
    ],
  };
  if (state.branchHead === COMMIT_SHA) {
    state.commitTree = treeRows([{
      path: CHANGE_PATH,
      contents: Buffer.from(CHANGE_CONTENT, 'utf8').toString('base64'),
    }], options);
  }
  const contextExpiresAt = new Date(Date.now() + 60_000).toISOString();
  const context = {
    token: TOKEN,
    tokenExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    contextExpiresAt,
    repositoryId: REPOSITORY_ID,
    repositoryName: 'randoneering/mellon',
    appId: APP_ID,
    installationId: INSTALLATION_ID,
    actor: actor(),
    signingPreflight: {
      repositoryId: REPOSITORY_ID,
      repositoryName: 'randoneering/mellon',
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      expiresAt: contextExpiresAt,
      commit: {
        oid: '7'.repeat(40),
        author: actor(),
        committer: { name: 'GitHub', email: 'noreply@github.com' },
        signature: signature(),
      },
    },
  };

  function commitProof(oid) {
    const actualActor = options.wrongActor
      ? { databaseId: 8888, login: 'some-human' }
      : actor();
    const tree = oid === COMMIT_SHA ? COMMIT_TREE_SHA : BASE_TREE_SHA;
    return {
      repository: {
        databaseId: REPOSITORY_ID,
        nameWithOwner: 'randoneering/mellon',
        object: {
          oid,
          tree: { oid: tree },
          parents: { nodes: [{ oid: options.wrongParent ? FOREIGN_SHA : BASE_SHA }] },
          author: { user: actualActor },
          committer: { name: 'GitHub', email: 'noreply@github.com' },
          signature: signature(options.wrongSignature
            ? { isValid: false, state: 'UNKNOWN', wasSignedByGitHub: false }
            : {}),
        },
        ref: {
          name: BRANCH,
          prefix: 'refs/heads/',
          target: { oid: state.branchHead },
        },
      },
    };
  }

  const fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    const call = {
      url: parsed.href,
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body,
      redirect: init.redirect,
    };
    calls.push(call);
    if (parsed.origin !== 'https://api.github.com') throw new Error(`secret ${TOKEN}`);
    if (init.redirect !== 'manual') throw new Error('redirect mode missing');
    if (options.redirectPath === parsed.pathname) {
      return new Response('', { status: 302, headers: { location: 'https://evil.invalid/' } });
    }
    if (options.hangPath === parsed.pathname) return new Promise(() => {});

    if (parsed.pathname === '/repos/randoneering/mellon' && call.method === 'GET') {
      return jsonResponse({
        id: REPOSITORY_ID,
        full_name: 'randoneering/mellon',
        name: 'mellon',
      });
    }
    if (parsed.pathname.endsWith(`/git/ref/heads/${BRANCH}`) && call.method === 'GET') {
      if (state.branchHead === null) return jsonResponse({ message: 'private 404' }, 404);
      return jsonResponse({
        ref: `refs/heads/${BRANCH}`,
        object: { type: 'commit', sha: state.branchHead },
      });
    }
    if (parsed.pathname === '/repos/randoneering/mellon/git/refs' && call.method === 'POST') {
      state.branchWrites += 1;
      const body = JSON.parse(init.body);
      if (body.ref !== `refs/heads/${BRANCH}` || body.sha !== BASE_SHA) {
        throw new Error('wrong fixed branch request');
      }
      if (state.branchHead === null && !options.branchCreateDoesNotApply) state.branchHead = BASE_SHA;
      if (options.loseBranchAck) throw new Error(`private token ${TOKEN}`);
      if (options.branchCreateDoesNotApply) throw new Error('private response body');
      return jsonResponse({
        ref: body.ref,
        object: { type: 'commit', sha: body.sha },
      }, 201);
    }
    if (parsed.pathname === `/repos/randoneering/mellon/git/commits/${BASE_SHA}`
      && call.method === 'GET') {
      return jsonResponse({
        sha: BASE_SHA,
        tree: { sha: BASE_TREE_SHA },
        parents: options.baseParents ?? [],
      });
    }
    if (parsed.pathname === `/repos/randoneering/mellon/git/commits/${COMMIT_SHA}`
      && call.method === 'GET') {
      return jsonResponse({
        sha: COMMIT_SHA,
        tree: { sha: COMMIT_TREE_SHA },
        parents: [{ sha: BASE_SHA }],
      });
    }
    if (parsed.pathname === `/repos/randoneering/mellon/git/trees/${BASE_TREE_SHA}`
      && call.method === 'GET') {
      if (options.oversizedTree) {
        return new Response('', {
          status: 200,
          headers: { 'content-length': String(4 * 1024 * 1024 + 1) },
        });
      }
      return jsonResponse({
        sha: BASE_TREE_SHA,
        truncated: options.truncatedBaseTree === true,
        tree: options.baseTree ?? [],
      });
    }
    if (parsed.pathname === `/repos/randoneering/mellon/git/trees/${COMMIT_TREE_SHA}`
      && call.method === 'GET') {
      return jsonResponse({
        sha: COMMIT_TREE_SHA,
        truncated: options.truncatedTree === true,
        tree: state.commitTree,
      });
    }
    if (parsed.pathname === '/graphql' && call.method === 'POST') {
      const body = JSON.parse(init.body);
      if (body.query.includes('mutation AgentWorkerCreateCommit')) {
        state.commitWrites += 1;
        const input = body.variables.input;
        if (options.moveBeforeCommit) state.branchHead = FOREIGN_SHA;
        if (input.expectedHeadOid !== BASE_SHA || state.branchHead !== BASE_SHA) {
          return jsonResponse({ errors: [{ message: `private ${TOKEN}` }], data: null });
        }
        if (input.branch.repositoryNameWithOwner !== 'randoneering/mellon'
          || input.branch.branchName !== BRANCH
          || input.fileChanges.deletions !== undefined
          || input.message.headline !== 'Apply approved agent changes') {
          throw new Error('mutation variables are not fixed');
        }
        state.commitTree = treeRows(input.fileChanges.additions, options);
        if (!options.commitDoesNotApply) state.branchHead = COMMIT_SHA;
        if (options.loseCommitAck) throw new Error(`private token ${TOKEN}`);
        const data = {
          data: {
            createCommitOnBranch: {
              commit: { oid: COMMIT_SHA },
              ref: {
                name: BRANCH,
                prefix: 'refs/heads/',
                target: { oid: COMMIT_SHA },
              },
            },
          },
        };
        if (options.partialGraphqlSuccess) {
          data.errors = [{ message: `private response ${TOKEN}` }];
        }
        return jsonResponse(data);
      }
      if (body.query.includes('query AgentWorkerCommitProof')) {
        const oid = body.variables.oid;
        if (options.proofErrors) {
          return jsonResponse({
            data: commitProof(oid),
            errors: [{ message: `private details ${TOKEN}` }],
          });
        }
        return jsonResponse({ data: commitProof(oid) });
      }
      throw new Error('unknown GraphQL document');
    }
    return jsonResponse({ message: 'private not found' }, 404);
  };

  const dependencies = {
    fetch,
    timeoutMs: options.timeoutMs ?? 1000,
    getPublicationContext: async () => {
      state.contextCalls += 1;
      if (options.hangContext) return new Promise(() => {});
      return options.context === undefined
        ? context
        : typeof options.context === 'function' ? options.context(context) : options.context;
    },
    checkApproval: async ({ run, approvedManifest: manifestInput }) => {
      state.approvalCalls += 1;
      if (options.hangApproval) return new Promise(() => {});
      return options.approvalDenied
        ? { authorized: false, reason: 'approval_denied' }
        : {
        authorized: true,
        reason: 'approved',
        evidence: {
          repositoryId: run.repositoryId,
          issueId: run.issueId,
          issueNumber: run.issueNumber,
          approverId: run.approverId,
          manifestSha256: run.manifestSha256,
          baseRevision: run.baseSha,
          policyRevision: manifestInput.policyRevision,
        },
      };
    },
    checkFence: async args => {
      state.fenceCalls.push(args.phase);
      if (options.hangFencePhase === args.phase) return new Promise(() => {});
      return {
      decision: options.fenceDecisions?.[args.phase] ?? 'execute',
      runId: args.runId,
      generation: args.generation,
      intentId: args.intentId,
      operationHash: args.operationHash,
      expectedHeadSha: args.expectedHeadSha,
      phase: args.phase,
      };
    },
  };
  return { request, dependencies, calls, state, context, branch: BRANCH };
}

export const fixtureTokens = Object.freeze({ TOKEN, FOREIGN_SHA, INTENT_ID });

export const PR_TEMPLATE = '## What does this PR contain?\n\n## Related issue\n\nLink the issue if there is one.\n\n## How was this tested?\n';

export function createDraftPrFixture(options = {}) {
  const fixture = createPublisherFixture({ initialBranchHead: COMMIT_SHA,
    expectedHeadSha: COMMIT_SHA, ...options });
  const { state, request, context, dependencies, branch, calls } = fixture;
  const diagnostics = {
    version: 2,
    sources: [
      'automation/ci/guard-command.mjs',
      'automation/ci/run-tests.mjs',
      'automation/ci/test-reporter.mjs',
      'automation/ci/report-annotations.mjs',
      'scripts/lib/output-guard.mjs',
      'package.json',
    ].map(path => ({ path, sha256: sha256(`synthetic reviewed ${path}\n`) })),
    reporter: { context: 'test-report', revision: '6'.repeat(40),
      sha256: sha256('synthetic reviewed immutable formatter\n') },
    skipPolicy: { version: 1,
      sha256: 'bc69e450cbe6f7bb10dfeeaf4ba71d3393cd2047563fd7af53ad32506b212eab' },
  };
  request.approvedManifest.requiredChecks = [
    { context: 'test', appId: 15368, workflowId: 399609443 },
    { context: 'test-report', appId: 15368, workflowId: 399609443 },
  ];
  request.approvedManifest.requiredWorkflowIdentities = [{ id: 399609443,
    path: '.github/workflows/test.yml', sha256: '2'.repeat(64), appId: 15368, event: 'push',
    diagnostics }];
  request.run.manifestSha256 = sha256(canonical(request.approvedManifest));
  request.intent.kind = 'pr_create';
  delete request.proposedChanges;
  state.prWrites = 0;
  state.prs = [];
  state.events = [];
  const check = { checkRunId: 501, checkSuiteId: 601, appId: 15368,
    status: 'completed', conclusion: 'success', headSha: COMMIT_SHA };
  const reportCheck = { ...check, checkRunId: 502, checkSuiteId: 602 };
  const diagnostic = { schemaVersion: 2, complete: true,
    producerSha256: sha256(canonical(diagnostics.sources)),
    testCount: 63, passedTestCount: 1, skippedTestCount: 62,
    skipPolicySha256: diagnostics.skipPolicy.sha256,
    skippedTestIdentitySha256s: [...DATABASE_SKIP_IDENTITIES], processExitCode: 0 };
  const green = { status: 'success', repositoryId: REPOSITORY_ID, headSha: COMMIT_SHA,
    branch, event: 'push', runs: [{ workflowId: 399609443, runId: 77, runAttempt: 1,
      headSha: COMMIT_SHA, checks: [check, reportCheck], diagnostic }],
    checks: [check, reportCheck], runId: 77, runAttempt: 1 };
  const issuance = { repositoryId: context.repositoryId, repositoryName: context.repositoryName,
    appId: context.appId, installationId: context.installationId,
    tokenExpiresAt: context.tokenExpiresAt, tokenSha256: sha256(context.token),
    permissions: { metadata: 'read', contents: 'write', pull_requests: 'write' } };
  dependencies.getPullRequestContext = async args => {
    state.events.push('context');
    if (options.hangPrContext) return new Promise(() => {});
    const value = { publicationContext: structuredClone(context),
      installationToken: structuredClone(issuance) };
    return options.prContext ? options.prContext(value, args) : value;
  };
  dependencies.checkInitialChecks = async args => {
    state.events.push('checks');
    state.checkArgs = args;
    if (options.hangChecks) return new Promise(() => {});
    const value = structuredClone(green);
    return options.checks ? options.checks(value) : value;
  };
  const originalApproval = dependencies.checkApproval;
  dependencies.checkApproval = async args => {
    state.events.push('approval');
    if (options.revokeBeforeWrite && state.approvalCalls > 0) {
      return { authorized: false, reason: 'approval_denied' };
    }
    return originalApproval(args);
  };
  const originalFence = dependencies.checkFence;
  dependencies.checkFence = async args => {
    state.events.push(`fence:${args.phase}`);
    state.lastFence = args;
    return { ...await originalFence(args), kind: args.kind,
      ...(options.fenceOverride ?? {}) };
  };
  fixture.makePr = (body, overrides = {}) => ({
    id: 8001, number: 31, state: 'open', draft: true, merged_at: null,
    title: body.title, body: body.body,
    user: { id: BOT_ID, login: BOT_LOGIN, type: 'Bot' },
    head: { ref: branch, sha: COMMIT_SHA, label: `randoneering:${branch}`,
      repo: { id: REPOSITORY_ID, full_name: 'randoneering/mellon',
        owner: { login: 'randoneering' } } },
    base: { ref: 'main', sha: BASE_SHA,
      repo: { id: REPOSITORY_ID, full_name: 'randoneering/mellon',
        owner: { login: 'randoneering' } } },
    ...overrides,
  });
  const originalFetch = dependencies.fetch;
  dependencies.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = init.method ?? 'GET';
    const isPr = parsed.pathname === '/repos/randoneering/mellon/pulls';
    const isTemplate = parsed.pathname === '/repos/randoneering/mellon/contents/.github/PULL_REQUEST_TEMPLATE.md';
    if (!isPr && !isTemplate) {
      if (parsed.pathname.includes('/git/ref/heads/')) {
        state.events.push('head');
        if (options.moveAfterChecks && state.events.includes('checks')) state.branchHead = FOREIGN_SHA;
      }
      return originalFetch(url, init);
    }
    calls.push({ url: parsed.href, method, headers: init.headers, body: init.body,
      redirect: init.redirect });
    if (options.prRedirect) return new Response('', { status: 302 });
    if (isTemplate) {
      state.events.push('template');
      const content = options.template ?? PR_TEMPLATE;
      return jsonResponse({ type: 'file', path: '.github/PULL_REQUEST_TEMPLATE.md',
        sha: blobSha(content), encoding: 'base64', size: Buffer.byteLength(content),
        content: Buffer.from(content).toString('base64') });
    }
    if (method === 'GET') {
      state.events.push('list');
      if (options.hangPrList) return new Promise(() => {});
      if (options.listFailure) throw new Error(`private ${TOKEN}`);
      if (options.prPage) return options.prPage(parsed, state);
      return jsonResponse(state.prs);
    }
    state.events.push('create');
    state.prWrites += 1;
    const body = JSON.parse(init.body);
    state.createdBody = body;
    const pr = fixture.makePr(body);
    if (!options.prDoesNotApply) state.prs.push(options.createdPr ? options.createdPr(pr) : pr);
    if (options.losePrAck) throw new Error(`private ${TOKEN}`);
    return jsonResponse(options.responsePr ? options.responsePr(pr) : pr, 201);
  };
  return fixture;
}

// Synthetic signed ancestry for the complete initial-plus-two-repairs lifecycle.
export function createOwnedHistoryFixture(length, options = {}) {
  if (!Number.isInteger(length) || length < 1 || length > 7) {
    throw new Error('Invalid owned-history fixture length.');
  }
  const shas = Array.from({ length }, (_, index) => (index + 1).toString(16).repeat(40));
  const head = shas.at(-1);
  const setup = { ...options, initialBranchHead: head, expectedHeadSha: head,
    checks(value) {
      value.headSha = head;
      for (const run of value.runs) {
        run.headSha = head;
        for (const check of run.checks) check.headSha = head;
      }
      for (const check of value.checks) check.headSha = head;
      return value;
    } };
  const fixture = (options.draftPr ? createDraftPrFixture : createPublisherFixture)(setup);
  const { state, branch } = fixture;
  const history = new Map(shas.map((sha, index) => [sha, {
    sha, parentSha: index === 0 ? BASE_SHA : shas[index - 1], treeSha: BASE_TREE_SHA,
    foreign: index === options.foreignDepth,
  }]));
  const created = { sha: COMMIT_SHA, parentSha: head, treeSha: COMMIT_TREE_SHA };
  if (options.draftPr) {
    const makePr = fixture.makePr;
    fixture.makePr = (...args) => {
      const pr = makePr(...args);
      return { ...pr, head: { ...pr.head, sha: head } };
    };
  }
  const originalFetch = fixture.dependencies.fetch;
  fixture.dependencies.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    const sha = parsed.pathname.split('/').at(-1);
    const restNode = history.get(sha) ?? (sha === COMMIT_SHA ? created : null);
    const proofNode = history.get(body?.variables?.oid)
      ?? (body?.variables?.oid === COMMIT_SHA ? created : null);
    const commitRead = parsed.pathname.includes('/git/commits/') && restNode;
    const proofRead = parsed.pathname === '/graphql'
      && body?.query?.includes('query AgentWorkerCommitProof') && proofNode;
    const mutation = parsed.pathname === '/graphql'
      && body?.query?.includes('mutation AgentWorkerCreateCommit');
    if (parsed.origin !== 'https://api.github.com' || !commitRead && !proofRead && !mutation) {
      return originalFetch(url, init);
    }
    if (init.redirect !== 'manual') throw new Error('Redirect mode missing.');
    fixture.calls.push({ url: parsed.href, method: init.method ?? 'GET',
      headers: init.headers ?? {}, body: init.body, redirect: init.redirect });
    if (commitRead) return jsonResponse({ sha: restNode.sha,
      tree: { sha: restNode.treeSha }, parents: [{ sha: restNode.parentSha }] });
    if (proofRead) {
      const proofActor = proofNode.foreign ? { databaseId: 8888, login: 'foreign' } : actor();
      return jsonResponse({ data: { repository: {
        databaseId: REPOSITORY_ID, nameWithOwner: 'randoneering/mellon',
        object: { oid: proofNode.sha, tree: { oid: proofNode.treeSha },
          parents: { nodes: [{ oid: proofNode.parentSha }] },
          author: { user: proofActor }, committer: { name: 'GitHub', email: 'noreply@github.com' },
          signature: signature() },
        ref: { name: branch, prefix: 'refs/heads/', target: { oid: state.branchHead } },
      } } });
    }
    state.commitWrites += 1;
    const input = body.variables.input;
    if (input.expectedHeadOid !== head || state.branchHead !== head
      || input.branch.branchName !== branch) {
      return jsonResponse({ data: null, errors: [{ message: 'Expected head mismatch.' }] });
    }
    state.commitTree = treeRows(input.fileChanges.additions, options);
    state.branchHead = COMMIT_SHA;
    if (options.loseCommitAck) throw new Error('Synthetic lost commit acknowledgment.');
    return jsonResponse({ data: { createCommitOnBranch: { commit: { oid: COMMIT_SHA },
      ref: { name: branch, prefix: 'refs/heads/', target: { oid: COMMIT_SHA } } } } });
  };
  return fixture;
}
