import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { appendFile, mkdir, open, writeFile } from 'node:fs/promises';
import { closeSync, openSync } from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const OUTPUTS = [
  'dist/index.mjs',
  'dist/scorer.mjs',
  'dist/build-meta.json',
  'dist/THIRD_PARTY_NOTICES.txt',
  'dist/detector/provenance.json',
  'dist/detector/vendor/aicomment/LICENSE',
  'dist/detector/vendor/aicomment/classifier.mjs',
  'dist/detector/vendor/aicomment/langs/c_family.mjs',
  'dist/detector/vendor/aicomment/langs/elisp.mjs',
  'dist/detector/vendor/aicomment/langs/haskell.mjs',
  'dist/detector/vendor/aicomment/langs/index.mjs',
  'dist/detector/vendor/aicomment/langs/perl.mjs',
  'dist/detector/vendor/aicomment/langs/php.mjs',
  'dist/detector/vendor/aicomment/langs/python.mjs',
  'dist/detector/vendor/aicomment/langs/registry.mjs',
  'dist/detector/vendor/aicomment/langs/shell.mjs',
  'dist/detector/vendor/aicomment/model.json',
  'dist/detector/vendor/aicomment/preprocess.mjs',
  'dist/detector/vendor/aicomment/pychars.mjs',
];
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const CHECKS = [
  ['install-root', ['ci', '--ignore-scripts']],
  ['install-detector', ['ci', '--prefix', 'detector', '--ignore-scripts']],
  ['verify-assets', ['run', 'verify:assets']],
  ['test-build', ['run', 'test:build']],
  ['tests', ['test']],
  ['parity', ['run', 'test:parity']],
  ['build', ['run', 'build']],
  ['validate-release', ['run', 'validate:release']],
];

class RunnerError extends Error {
  constructor(stage, category) {
    super(`${stage} failed (${category}).`);
    this.stage = stage;
    this.category = category;
  }
}

export function validateDispatch(input) {
  const fields = ['repository', 'event_name', 'ref', 'branch', 'source_sha', 'request_id'];
  if (!input || fields.some(field => typeof input[field] !== 'string' || input[field] !== input[field].trim()) ||
      input.repository !== 'randoneering/mellon' || input.event_name !== 'workflow_dispatch' ||
      input.ref !== 'refs/heads/main' || !/^n8n\/issue-[1-9][0-9]*$/.test(input.branch) ||
      !Number.isSafeInteger(Number(input.branch.slice('n8n/issue-'.length))) ||
      !/^[a-f0-9]{40}$/.test(input.source_sha) || !/^n8n-[1-9][0-9]{0,19}$/.test(input.request_id)) {
    throw new RunnerError('dispatch-validation', 'invalid-input');
  }
  return Object.fromEntries(fields.map(field => [field, input[field]]));
}

export async function verifyRequestedHead(input, token, fetchImpl = fetch) {
  const request = validateDispatch(input);
  let data;
  try {
    if (typeof token !== 'string' || !token) throw new Error();
    const response = await fetchImpl(`https://api.github.com/repos/randoneering/mellon/git/ref/heads/${request.branch}`, {
      redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (response.status !== 200) throw new Error();
    data = await response.json();
  } catch {
    throw new RunnerError('source-validation', 'request');
  }
  if (data?.object?.type !== 'commit' || data.object.sha !== request.source_sha) {
    throw new RunnerError('source-validation', 'head-moved');
  }
}

export function runChecks(execute) {
  for (const [stage, args] of CHECKS) {
    try {
      const result = execute('npm', args, stage);
      if (result?.status !== 0 || result.error || result.signal) throw new Error();
    } catch {
      throw new RunnerError(stage, 'command');
    }
  }
  return { completed: CHECKS.length };
}

export function buildManifest(input, files, runtime) {
  const request = validateDispatch(input);
  if (!runtime || !/^[1-9][0-9]{0,19}$/.test(runtime.run_id ?? '') ||
      !/^[1-9][0-9]{0,5}$/.test(runtime.run_attempt ?? '') || !/^[a-f0-9]{40}$/.test(runtime.workflow_sha ?? '') ||
      typeof files !== 'object' || files === null || Object.keys(files).length !== OUTPUTS.length ||
      Object.keys(files).some(filename => !OUTPUTS.includes(filename))) {
    throw new RunnerError('export', 'contract');
  }
  let total = 0;
  const result = OUTPUTS.map(filename => {
    const bytes = files[filename];
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_FILE_BYTES) throw new RunnerError('export', 'file-size-or-type');
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new RunnerError('export', 'total-size');
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new RunnerError('export', 'encoding'); }
    return { path: filename, contents: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  return {
    version: 1, repository: request.repository, branch: request.branch,
    source_sha: request.source_sha, request_id: request.request_id,
    run_id: String(runtime.run_id), run_attempt: Number(runtime.run_attempt),
    artifact_name: `n8n-build-${request.request_id}-attempt-${Number(runtime.run_attempt)}`,
    workflow_sha: runtime.workflow_sha, files: result,
  };
}

async function collectOutputs(sourceRoot) {
  const files = {};
  for (const filename of OUTPUTS) {
    let handle;
    try {
      handle = await open(path.join(sourceRoot, filename), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error();
      const buffer = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== stat.size) throw new Error();
      files[filename] = buffer.subarray(0, bytesRead);
    } catch {
      throw new RunnerError('export', 'unsafe-or-missing-file');
    } finally {
      await handle?.close();
    }
  }
  return files;
}

function readRequest() {
  return validateDispatch({
    repository: process.env.GITHUB_REPOSITORY,
    event_name: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    branch: process.env.REQUEST_BRANCH,
    source_sha: process.env.REQUEST_SHA,
    request_id: process.env.REQUEST_ID,
  });
}

async function main(command) {
  const request = readRequest();
  if (command === 'validate') {
    await verifyRequestedHead(request, process.env.GH_TOKEN);
    console.log('Requested source head verified.');
    return;
  }
  const sourceRoot = process.env.SOURCE_ROOT;
  const tempRoot = process.env.RUNNER_TEMP;
  if (!sourceRoot || !tempRoot) throw new RunnerError('environment', 'missing-path');
  let actualHead;
  try { actualHead = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { throw new RunnerError('source-validation', 'checkout'); }
  if (actualHead !== request.source_sha) throw new RunnerError('source-validation', 'checkout-head');
  if (command === 'checks') {
    runChecks((executable, args, stage) => {
      // Raw failures can include submission text; expose only fixed stage/category diagnostics.
      const log = openSync(path.join(tempRoot, `${request.request_id}-${stage}.log`), 'a', 0o600);
      try { return spawnSync(executable, args, { cwd: sourceRoot, stdio: ['ignore', log, log], timeout: 300000 }); }
      finally { closeSync(log); }
    });
    console.log('All 8 repository checks completed successfully.');
    return;
  }
  if (command !== 'export') throw new RunnerError('environment', 'invalid-command');
  const manifest = buildManifest(request, await collectOutputs(sourceRoot), {
    run_id: process.env.GITHUB_RUN_ID,
    run_attempt: process.env.GITHUB_RUN_ATTEMPT,
    workflow_sha: process.env.GITHUB_WORKFLOW_SHA,
  });
  const folder = path.join(tempRoot, `${request.request_id}-attempt-${manifest.run_attempt}-result`);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const resultPath = path.join(folder, 'result.json');
  await writeFile(resultPath, JSON.stringify(manifest) + '\n', { flag: 'wx', mode: 0o600 });
  if (!process.env.GITHUB_OUTPUT) throw new RunnerError('export', 'missing-output-channel');
  await appendFile(process.env.GITHUB_OUTPUT, `path=${resultPath}\nartifact_name=${manifest.artifact_name}\n`);
  console.log('Bounded distribution manifest exported. No commits or pull requests were created.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv[2]); }
  catch (error) {
    const safe = error instanceof RunnerError ? error : new RunnerError('runner', 'internal');
    console.error(safe.message);
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, `## n8n build stopped\nStage: ${safe.stage}\nCategory: ${safe.category}\nThe runner has no publication authority. Inspect the n8n source branch before retrying.\n`);
    }
    process.exitCode = 1;
  }
}
