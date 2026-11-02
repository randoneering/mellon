import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addRecord, loadDataset, saveDataset, validateDataset } from '../../src/personalized/dataset.mjs';

const record = { url: 'https://github.com/o/r/issues/1', title: 'Title', body: '', label: 'human' };

async function tempDir(t) {
  const path = await mkdtemp(join(tmpdir(), 'mellon-dataset-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('persists and reloads versioned dataset records', async t => {
  const path = join(await tempDir(t), 'dataset.json');
  await saveDataset(path, [record]);
  assert.deepEqual(await loadDataset(path), { version: 1, records: [record] });
});

test('rejects invalid records and labels', () => {
  assert.throws(() => validateDataset({ version: 1, records: [{ ...record, label: 'maybe' }] }));
  assert.throws(() => validateDataset({ version: 2, records: [record] }));
  assert.throws(() => validateDataset({ version: 1, records: [record, record] }));
});

test('stores canonical URLs and preserves existing label and snapshot', () => {
  const existing = { ...record, label: 'ai', title: 'Original' };
  const result = addRecord([existing], { ...record, label: 'human', title: 'Updated' });
  assert.deepEqual(result, [existing]);
  assert.equal(validateDataset({ version: 1, records: [{ ...record, url: `${record.url}/` }] }).records[0].url, record.url);
});

test('failed save does not alter existing dataset', async t => {
  const path = join(await tempDir(t), 'dataset.json');
  await saveDataset(path, [record]);
  await assert.rejects(saveDataset(path, [{ ...record, label: 'bad' }]));
  assert.deepEqual(await loadDataset(path), { version: 1, records: [record] });
});

test('warns before saving to tracked destination', async t => {
  const path = join(await tempDir(t), 'dataset.json');
  const warnings = [];
  await saveDataset(path, [record], { isTracked: async () => true, warn: message => warnings.push(message) });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /tracked/i);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).records, [record]);
});

test('failed atomic replacement leaves prior file intact', async t => {
  const path = join(await tempDir(t), 'dataset.json');
  await saveDataset(path, [record]);
  await assert.rejects(saveDataset(path, [{ ...record, label: 'ai' }], { renameImpl: async () => { throw new Error('disk'); } }));
  assert.deepEqual(await loadDataset(path), { version: 1, records: [record] });
});
