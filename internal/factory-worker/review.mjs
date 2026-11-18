import { runBoundedProcess } from './process.mjs';
import { lstat, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { validateCandidate } from './candidate.mjs';

const ERROR = 'Factory review evidence rejected.';

export function executeReviewProcess(command, args, options = {}) {
  return runBoundedProcess(command, args, options);
}

// Qodo keys its finding inventory to a branch; at a detached HEAD it reports
// checkpoint_unavailable and no inventory, so the candidate gets a local branch.
export function candidateCheckoutCommands(root, baseSha, digest) {
  if (!/^[a-f0-9]{40}$/.test(baseSha ?? '') || !/^[a-f0-9]{64}$/.test(digest ?? '')) throw new Error(ERROR);
  const git = ['-C', root, '-c', 'core.hooksPath=/dev/null'];
  return [[...git, 'checkout', '--detach', baseSha], [...git, 'switch', '--create', `factory-candidate-${digest.slice(0, 16)}`]];
}

export function evaluateCandidateReview(value, expected) {
  const snapshot = value?.meta?.run?.snapshot;
  if (value?.meta?.coverage?.complete !== true || value.finding_state?.complete !== true
      || !Array.isArray(value.meta.skipped_files) || value.meta.skipped_files.length
      || snapshot?.base_sha !== expected.baseSha || snapshot.commit_sha !== expected.baseSha
      || snapshot.tree_sha !== expected.treeSha || typeof value.meta.run.id !== 'string') throw new Error(ERROR);
  // Every reported finding must sit in exactly one state list, and every listed
  // id must name a reported finding; anything unaccounted blocks approval.
  if (!Array.isArray(value.findings)) throw new Error(ERROR);
  const ids = new Set();
  for (const f of value.findings) {
    if (typeof f?.id !== 'string' || !f.id || ids.has(f.id)) throw new Error(ERROR);
    ids.add(f.id);
  }
  const states = new Map();
  for (const key of ['introduced', 'still_open', 'resolved', 'dismissed']) {
    const list = value.finding_state[key] ?? [];
    if (!Array.isArray(list)) throw new Error(ERROR);
    for (const entry of list) {
      const id = typeof entry === 'string' ? entry : entry?.id;
      if (typeof id !== 'string' || states.has(id)) throw new Error(ERROR);
      states.set(id, key);
    }
  }
  if (states.size !== ids.size || [...ids].some(id => !states.has(id))) throw new Error(ERROR);
  const open = [...states].filter(([, key]) => key === 'introduced' || key === 'still_open').map(([id]) => id);
  const findings = open.map(id => {
    const f = value.findings.find(finding => finding.id === id);
    if (!f) throw new Error(ERROR);
    return {
      id: f.id, reportedCategory: f.category ?? null, reportedType: f.type ?? null,
      reportedSeverity: f.severity ?? null, reportedActionLevel: f.action_level ?? null,
      location: f.location ?? null, title: f.title ?? '',
      description: typeof f.description === 'string' ? f.description.slice(0, 2000) : '',
    };
  });
  return {
    status: findings.length ? 'awaiting_assessment' : 'approved',
    reviewRunId: value.meta.run.id, treeSha: expected.treeSha,
    candidateDigest: expected.candidateDigest, coverageComplete: true,
    findingInventoryComplete: true, findings,
  };
}

export async function reviewCandidate(candidate, config) {
  const checked = validateCandidate(candidate, config);
  let stage = 'review_snapshot';
  const result = { status: 'blocked', stage, category: 'review_unavailable', candidateDigest: checked.digest };
  const run = async (command, args, cwd, timeout = 60000) => {
    const r = await executeReviewProcess(command, args, {
      cwd, timeout,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
    if (r.status !== 0) throw new Error(ERROR);
    return r.stdout.trim();
  };
  try {
    await mkdir(config.reviewDir, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(join(config.reviewDir, 'candidate-'));
    result.snapshotDir = root;
    await run('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--quiet', 'https://github.com/randoneering/mellon.git', root], undefined);
    for (const args of candidateCheckoutCommands(root, config.baseSha, checked.digest)) await run('git', args);
    if (await run('git', ['-C', root, 'rev-parse', 'HEAD']) !== config.baseSha) throw new Error(ERROR);
    for (const file of checked.files) {
      const target = resolve(root, file.path);
      if (!target.startsWith(root+'/')) throw new Error(ERROR);
      // Existing files may be replaced, but never through a symlink in the clone.
      await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 });
      const existing = await lstat(target).catch(() => null);
      if (existing && !existing.isFile()) throw new Error(ERROR);
      await writeFile(target, file.content, { mode: 0o600 });
    }
    await run('git', ['-C', root, 'add', '--', ...checked.files.map(f => f.path)]);
    const treeSha = await run('git', ['-C', root, 'write-tree']);
    const contextFile = join(config.reviewDir, `${checked.digest}.context.json`);
    const context = {
      notes: `Mellon factory build for issue #${config.issueNumber}. Only these planned paths may change: ${checked.files.map(f => f.path).join(', ')}. No dist, workflow, dependency or generated-file edits; no live API calls or private data. The full candidate is supplied uncommitted at the approved base; official tests run later in GitHub CI. This is an independent Qodo review, not a worker claim. Report category, action level and severity separately; Low findings stay unchanged and unclassified findings go to the owner. Source tree and candidate digest are independently pinned. Never post PR comments.`,
      decisions: ['The maintainer approved the saved plan with the n8n: build label; merge stays manual.', 'T3 Code with Pi produced the candidate inside an isolated container; the controller validates scope and reviews immutable file data independently.'],
      recent_work: [`Candidate changes for issue #${config.issueNumber} limited to the planned paths.`],
    };
    await writeFile(contextFile, JSON.stringify(context), { flag: 'wx', mode: 0o600 });
    stage = 'qodo_preflight';
    const version = await run('qodo', ['--version'], root);
    if (!/^([2-9]|[1-9][0-9]+)\./.test(version)) throw new Error(ERROR);
    await run('qodo', ['read', 'whoami', '--json', '--skill', 'qodo-review', '--skill-version', '1.10.14', '--distribution', 'skills-sh'], root);
    stage = 'qodo_submission';
    const submitted = JSON.parse(await run('qodo', ['review', '--base', config.baseSha, '--repo', 'randoneering/mellon', '--context-file', contextFile, '--async', '--json'], root, 90000));
    if (!submitted.operation_id) throw new Error(ERROR);
    result.operationId = submitted.operation_id;
    await writeFile(join(config.reviewDir, `${checked.digest}.operation.json`), JSON.stringify({ operationId: submitted.operation_id, treeSha, candidateDigest: checked.digest, snapshotDir: root }), { flag: 'wx', mode: 0o600 });
    stage = 'qodo_collection';
    for (let i = 0; i < 120; i++) {
      const r = await executeReviewProcess('qodo', ['review', 'status', submitted.operation_id, '--json', '--extended'], {
        cwd: root, timeout: 45000,
      });
      if (r.status === 2) { await delay(5000); continue; }
      if (r.status !== 0) throw new Error(ERROR);
      const review = JSON.parse(r.stdout);
      await writeFile(join(config.reviewDir, `${checked.digest}.review.json`), JSON.stringify(review), { flag: 'wx', mode: 0o600 });
      if (await run('git', ['-C', root, 'write-tree']) !== treeSha) throw new Error(ERROR);
      Object.assign(result, evaluateCandidateReview(review, { baseSha: config.baseSha, treeSha, candidateDigest: checked.digest }), { stage: 'complete', category: 'review_complete' });
      return result;
    }
  } catch { result.stage = stage; }
  return result;
}
