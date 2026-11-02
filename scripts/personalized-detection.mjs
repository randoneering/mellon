import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
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
const usage = 'Usage: personalized-detection.mjs collect --urls FILE --dataset FILE | train --dataset FILE --model FILE | evaluate --dataset FILE --model FILE --report FILE';

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

export async function runCli(argv, dependencies = {}) {
  const [command, ...args] = argv;
  const values = argumentsMap(args, command);
  const output = dependencies.output ?? (line => console.log(line));
  if (command === 'collect') {
    const token = (dependencies.env ?? process.env).GH_TOKEN ?? (dependencies.env ?? process.env).GITHUB_TOKEN;
    if (!token) throw new Error('Set GH_TOKEN or GITHUB_TOKEN for read-only GitHub access.');
    const urls = (await readFile(values.get('--urls'), 'utf8')).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
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
