import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { parseSubmissionUrl, fetchSubmission } from '../src/personalized/github.mjs';
import { loadDataset, addRecord, saveDataset, validateDataset } from '../src/personalized/dataset.mjs';
import { splitDataset } from '../src/personalized/split.mjs';
import { trainClassifier } from '../src/personalized/classifier.mjs';
import { createEvaluationMetadata, evaluateHoldout } from '../src/personalized/evaluate.mjs';
import { scoreRequest } from '../detector/scorer.mjs';

const LABELS = new Set(['human', 'ai', 'unsure']);

function displayText(value) {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, character => {
    const code = character.codePointAt(0);
    return code <= 0xff ? `\\x${code.toString(16).padStart(2, '0').toUpperCase()}` : `\\u${code.toString(16).padStart(4, '0').toUpperCase()}`;
  });
}

async function ensurePrivateParent(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
}
const usage = 'Usage: personalized-detection.mjs guided | collect --urls FILE --dataset FILE | train --dataset FILE --model FILE | evaluate --dataset FILE --model FILE --report FILE';

function argumentsMap(args, command) {
  const allowed = {
    collect: new Set(['--urls', '--dataset']),
    train: new Set(['--dataset', '--model']),
    evaluate: new Set(['--dataset', '--model', '--report']),
  }[command];
  if (!allowed) throw new Error(usage);
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!allowed.has(key) || !value || value.startsWith('--') || values.has(key)) throw new Error(usage);
    values.set(key, value);
  }
  for (const key of allowed) if (!values.has(key)) throw new Error(usage);
  return values;
}

async function interactivePrompt(question) {
  const terminal = createInterface({ input: stdin, output: stdout });
  try { return await terminal.question(question); } finally { terminal.close(); }
}

async function physicalDestination(path) {
  let directory = dirname(resolve(path));
  for (;;) {
    try { await stat(directory); break; } catch (error) {
      if (error.code !== 'ENOENT' || dirname(directory) === directory) throw error;
      directory = dirname(directory);
    }
  }
  return resolve(await realpath(directory), relative(directory, resolve(path)));
}

async function assertNewArtifact(path, kind) {
  try { await lstat(path); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new Error(`Unable to inspect the ${kind.toLowerCase()} destination; choose a verifiable path.`);
  }
  throw new Error(`${kind} already exists. Choose a new ${kind.toLowerCase()} path and retry.`);
}

async function gitDestination(path) {
  const target = await physicalDestination(path);
  let directory = dirname(target);
  while (true) {
    try { await stat(directory); break; } catch (error) {
      if (error.code !== 'ENOENT' || dirname(directory) === directory) throw error;
      directory = dirname(directory);
    }
  }
  const exec = promisify(execFile);
  let unignored = false;
  while (true) {
    let root;
    try {
      root = (await exec('git', ['-C', directory, 'rev-parse', '--show-toplevel'])).stdout.replace(/\r?\n$/u, '');
    } catch (error) {
      if (error.code === 128 && /not a git repository/i.test(error.stderr ?? '')) {
        return { tracked: false, unignored };
      }
      throw new Error('Unable to check whether the destination is Git-tracked.');
    }
    const relativeTarget = relative(root, target);
    if (!isAbsolute(root) || relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`)
      || isAbsolute(relativeTarget)) throw new Error('Unable to verify the destination repository.');
    try {
      await exec('git', ['--literal-pathspecs', '-C', root, 'ls-files', '--error-unmatch', '--', target]);
      return { tracked: true, unignored: true };
    } catch (error) {
      if (error.code !== 1) throw new Error('Unable to check whether the destination is Git-tracked.');
    }
    try {
      await exec('git', ['-C', root, 'check-ignore', '--no-index', '--', target]);
    } catch (error) {
      if (error.code !== 1) throw new Error('Unable to check whether the destination is Git-ignored.');
      unignored = true;
    }
    // An inner repository's ignore rules cannot protect private files from its outer repository.
    const parent = dirname(root);
    if (parent === root) return { tracked: false, unignored };
    directory = parent;
  }
}

async function runGuided(dependencies) {
  const output = dependencies.output ?? (line => console.log(line));
  const prompt = dependencies.prompt ?? interactivePrompt;
  const ask = async question => {
    const answer = await prompt(question);
    if (typeof answer !== 'string') throw new Error('Guided workflow cancelled.');
    return answer.trim();
  };
  output('Use a read-only GitHub token in GH_TOKEN or GITHUB_TOKEN. Labels are judgments, not proof of authorship.');
  const env = dependencies.env ?? process.env;
  if (!(env.GH_TOKEN || env.GITHUB_TOKEN)) {
    throw new Error('Set GH_TOKEN or GITHUB_TOKEN for read-only GitHub access.');
  }
  const urlFile = await ask('URL list path (leave blank to enter URLs manually): ');
  let urls;
  if (!urlFile) {
    urls = [];
    for (;;) {
      const value = await ask('GitHub issue or pull request URL (blank to finish): ');
      if (!value) break;
      try { parseSubmissionUrl(value); } catch { output('Unsupported GitHub URL; try again.'); continue; }
      urls.push(value);
    }
    if (!urls.length) throw new Error('Provide at least one GitHub submission URL.');
  }
  const dataset = await ask('Dataset path: ');
  const model = await ask('New model path: ');
  const report = await ask('New report path: ');
  if (!dataset || !model || !report) throw new Error('Dataset, model, and report paths are required.');
  await assertNewArtifact(model, 'Model');
  await assertNewArtifact(report, 'Report');
  if (new Set(await Promise.all([dataset, model, report].map(physicalDestination))).size !== 3) {
    throw new Error('Dataset, model, and report paths must be distinct.');
  }
  const confirm = async path => {
    let tracked;
    let unignored;
    try {
      const overrideTracked = dependencies.isTracked ? await dependencies.isTracked(path) : false;
      const inspected = await gitDestination(path);
      tracked = inspected.tracked || overrideTracked;
      unignored = inspected.unignored;
    } catch {
      throw new Error('Unable to check whether the destination is Git-tracked; choose a verifiable path.');
    }
    if (tracked) {
      output(`Warning: destination is Git-tracked: ${displayText(path)}`);
      if (!/^(y|yes)$/i.test(await ask('Write to this tracked path? [y/N]: '))) {
        throw new Error('Guided workflow cancelled before writing a tracked destination.');
      }
    } else if (unignored) {
      output(`Warning: private destination is inside a Git working tree and is not ignored: ${displayText(path)}`);
      if (!/^(y|yes)$/i.test(await ask('Write private data to this unignored repository path? [y/N]: '))) {
        throw new Error('Guided workflow cancelled before writing an unignored repository destination.');
      }
    }
  };
  await confirm(dataset);
  await confirm(model);
  await confirm(report);
  output('Collecting and labeling submissions. Previously labeled URLs are skipped.');
  await runCli(['collect', '--urls', urlFile || '-', '--dataset', dataset], {
    ...dependencies, prompt: ask, ...(urls ? { urls } : {}),
  });
  output('Training personalized classifier.');
  try {
    await runCli(['train', '--dataset', dataset, '--model', model], dependencies);
  } catch (error) {
    if (error.message === 'Training requires examples from both human and ai labels.') {
      throw new Error('Training needs eligible examples for both human and ai labels. Collect more labeled examples and retry.');
    }
    if (error.code === 'EEXIST') throw new Error('Model already exists. Choose a new model path and retry.');
    throw error;
  }
  const trained = JSON.parse(await readFile(model, 'utf8'));
  for (const warning of trained.evaluation?.split?.warnings ?? []) output(`Split warning: ${warning}`);
  output('Evaluating both detectors on the same holdout.');
  try {
    await runCli(['evaluate', '--dataset', dataset, '--model', model, '--report', report], dependencies);
  } catch (error) {
    if (error.message === 'Recorded holdout is empty.') {
      throw new Error('No holdout is available. Collect more eligible examples and train a new model.');
    }
    if (error.code === 'EEXIST') throw new Error('Report already exists. Choose a new report path and retry.');
    throw error;
  }
  output('Review the report and its warnings. Labels and scores do not prove authorship.');
}

export async function runCli(argv, dependencies = {}) {
  const [command, ...args] = argv;
  if (command === 'guided') {
    if (args.length) throw new Error(usage);
    return runGuided(dependencies);
  }
  const values = argumentsMap(args, command);
  const output = dependencies.output ?? (line => console.log(line));
  if (command === 'collect') {
    const token = (dependencies.env ?? process.env).GH_TOKEN || (dependencies.env ?? process.env).GITHUB_TOKEN;
    if (!token) throw new Error('Set GH_TOKEN or GITHUB_TOKEN for read-only GitHub access.');
    const urls = dependencies.urls ?? (await readFile(values.get('--urls'), 'utf8')).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!urls.length) throw new Error('URL list is empty.');
    const records = (await loadDataset(values.get('--dataset'))).records;
    const existing = new Set(records.map(record => record.url));
    const isTracked = dependencies.isTracked;
    if (isTracked && await isTracked(values.get('--dataset'))) output(`Warning: dataset destination is Git-tracked: ${values.get('--dataset')}`);
    for (const value of urls) {
      let parsed;
      try { parsed = parseSubmissionUrl(value); } catch { output('Skipped unsupported GitHub URL.'); continue; }
      if (existing.has(parsed.canonicalUrl)) continue;
      let snapshot;
      try { snapshot = await fetchSubmission(parsed, token, dependencies.fetchImpl ?? fetch); }
      catch { output(`Could not fetch ${parsed.canonicalUrl}; existing dataset preserved.`); continue; }
      const prompt = dependencies.prompt ?? interactivePrompt;
      const answer = await prompt(displayText(`${parsed.canonicalUrl}\n${snapshot.title}\n${snapshot.body}\nLabel [human/ai/unsure]: `));
      const label = String(answer).trim().toLowerCase();
      if (!LABELS.has(label)) throw new Error('Label must be human, ai, or unsure.');
      const next = addRecord(records, { url: parsed.canonicalUrl, ...snapshot, label });
      records.splice(0, records.length, ...next);
      await saveDataset(values.get('--dataset'), records, {
        ...(dependencies.isTracked ? { isTracked: dependencies.isTracked } : {}), warn: output,
      });
      existing.add(parsed.canonicalUrl);
    }
    return;
  }
  if (command === 'train') {
    const dataset = await loadDataset(values.get('--dataset'));
    const split = splitDataset(dataset.records);
    const model = trainClassifier(split.training);
    const baselineModelHash = dependencies.baselineModelHash ?? (await readFile(new URL('../detector/provenance.json', import.meta.url), 'utf8').then(JSON.parse)).model_sha256;
    model.evaluation = createEvaluationMetadata(dataset.records, split, baselineModelHash);
    model.evaluation.split = {
      version: split.version,
      assignments: split.assignments,
      groupHashes: split.groupHashes,
      exclusions: split.exclusions,
      warnings: split.warnings,
    };
    await ensurePrivateParent(values.get('--model'));
    await writeFile(values.get('--model'), `${JSON.stringify(model, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    output(`Model saved to ${values.get('--model')}. Training: ${split.training.length}; holdout: ${split.holdout.length}.`);
    return;
  }
  const dataset = validateDataset(JSON.parse(await readFile(values.get('--dataset'), 'utf8')));
  const model = JSON.parse(await readFile(values.get('--model'), 'utf8'));
  const canonicalRecords = [...dataset.records].sort((a, b) => a.url.localeCompare(b.url));
  const datasetHash = createHash('sha256').update(JSON.stringify(canonicalRecords)).digest('hex');
  if (datasetHash !== model.evaluation?.datasetHash) throw new Error('Dataset does not match the model training snapshot.');
  const split = model.evaluation?.split;
  if (!split?.assignments) throw new Error('Model does not contain split metadata.');
  const holdoutUrls = Object.entries(split.assignments).filter(([, assignment]) => assignment === 'holdout').map(([url]) => url);
  const holdout = dataset.records.filter(record => holdoutUrls.includes(record.url));
  if (!holdout.length) throw new Error('Recorded holdout is empty.');
  const baselineScore = dependencies.baselineScore ?? (async text => scoreRequest({ protocol_version: 1, text }));
  const report = await evaluateHoldout(model, holdout, baselineScore);
  await ensurePrivateParent(values.get('--report'));
  await writeFile(values.get('--report'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  output(`Evaluation report saved to ${values.get('--report')}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
