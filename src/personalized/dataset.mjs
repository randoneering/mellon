import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parseSubmissionUrl } from './github.mjs';

const execFileAsync = promisify(execFile);
const LABELS = new Set(['human', 'ai', 'unsure']);

export function validateDataset(value) {
  if (!value || typeof value !== 'object' || value.version !== 1 || !Array.isArray(value.records)) {
    throw new TypeError('Dataset must use version 1 and contain records.');
  }
  const seen = new Set();
  for (const record of value.records) {
    if (!record || typeof record !== 'object' || typeof record.url !== 'string' ||
        typeof record.title !== 'string' || typeof record.body !== 'string' || !LABELS.has(record.label)) {
      throw new TypeError('Dataset record has invalid fields or label.');
    }
    let submission;
    try { submission = parseSubmissionUrl(record.url); } catch { throw new TypeError('Dataset record has invalid GitHub URL.'); }
    if (seen.has(submission.canonicalUrl)) throw new TypeError('Dataset contains duplicate canonical URLs.');
    seen.add(submission.canonicalUrl);
  }
  return {
    version: 1,
    records: value.records.map(record => ({
      ...record,
      url: parseSubmissionUrl(record.url).canonicalUrl,
    })),
  };
}

export function addRecord(records, record) {
  const dataset = validateDataset({ version: 1, records });
  const candidate = validateDataset({ version: 1, records: [record] }).records[0];
  const canonical = parseSubmissionUrl(candidate.url).canonicalUrl;
  if (dataset.records.some(existing => parseSubmissionUrl(existing.url).canonicalUrl === canonical)) {
    return dataset.records;
  }
  dataset.records.push(candidate);
  return dataset.records;
}

export async function loadDataset(path) {
  let contents;
  try { contents = await readFile(path, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, records: [] };
    throw error;
  }
  let value;
  try { value = JSON.parse(contents); } catch { throw new TypeError('Dataset file is not valid JSON.'); }
  return validateDataset(value);
}

async function isGitTracked(path) {
  try {
    await execFileAsync('git', ['ls-files', '--error-unmatch', '--', resolve(path)], { cwd: process.cwd() });
    return true;
  } catch {
    return false;
  }
}

export async function saveDataset(path, records, { isTracked = isGitTracked, warn = console.warn, renameImpl = rename } = {}) {
  if (typeof path !== 'string' || !path) throw new TypeError('Dataset path is required.');
  const dataset = validateDataset({ version: 1, records });
  if (await isTracked(path)) warn(`Warning: dataset destination is Git-tracked: ${path}`);
  const target = resolve(path);
  const directory = dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryDirectory = await mkdtemp(`${directory}/.mellon-dataset-`);
  const temporaryPath = `${temporaryDirectory}/${randomUUID()}.json`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(dataset, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await renameImpl(temporaryPath, target);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
