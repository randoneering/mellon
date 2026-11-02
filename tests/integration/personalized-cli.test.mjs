import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCli } from '../../scripts/personalized-detection.mjs';

const urls = Array.from({ length: 10 }, (_, index) => `https://github.com/acme/project/issues/${index + 1}`);

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mellon-personalized-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const urlFile = path.join(directory, 'urls.txt');
  const datasetPath = path.join(directory, 'dataset.json');
  const modelPath = path.join(directory, 'model.json');
  const reportPath = path.join(directory, 'report.json');
  await writeFile(urlFile, `${urls.join('\n')}\n`);
  return { directory, urlFile, datasetPath, modelPath, reportPath };
}

function deps(labels, output = []) {
  return {
    env: { GH_TOKEN: 'do-not-leak-token' },
    fetchImpl: async (url, options) => {
      assert.equal(options.headers.authorization, 'Bearer do-not-leak-token');
      const number = Number(new URL(url).pathname.split('/').at(-1));
      return { ok: true, json: async () => ({ title: `Title ${number}`, body: `Body ${number}` }) };
    },
    prompt: async () => labels.shift(),
    output: line => output.push(String(line)),
    isTracked: async () => false,
  };
}

test('collect, train, and evaluate selected snapshots end to end', async t => {
  const files = await fixture(t);
  const output = [];
  await runCli(['collect', '--urls', files.urlFile, '--dataset', files.datasetPath], deps(urls.map((_, i) => i % 2 ? 'ai' : 'human'), output));
  const dataset = JSON.parse(await readFile(files.datasetPath, 'utf8'));
  assert.equal(dataset.records.length, 10);
  assert.deepEqual(dataset.records.map(record => record.label), urls.map((_, i) => i % 2 ? 'ai' : 'human'));
  await runCli(['train', '--dataset', files.datasetPath, '--model', files.modelPath], {
    ...deps([]), baselineModelHash: 'a'.repeat(64),
  });
  await runCli(['evaluate', '--dataset', files.datasetPath, '--model', files.modelPath, '--report', files.reportPath], {
    ...deps([]), baselineScore: async () => 0.2,
  });
  const report = JSON.parse(await readFile(files.reportPath, 'utf8'));
  assert.ok(report.detectors.baseline);
  assert.ok(report.detectors.personalized);
  assert.equal(output.join('\n').includes('do-not-leak-token'), false);
  dataset.records[0].body += ' changed';
  await writeFile(files.datasetPath, JSON.stringify(dataset));
  await assert.rejects(runCli(['evaluate', '--dataset', files.datasetPath, '--model', files.modelPath, '--report', path.join(files.directory, 'changed-report.json')], {
    ...deps([]), baselineScore: async () => 0.2,
  }), /does not match the model training snapshot/);
});

test('resumes labeling without refetching or overwriting saved labels', async t => {
  const files = await fixture(t);
  let first = true;
  const interrupted = {
    ...deps(['human']),
    prompt: async () => { if (first) { first = false; return 'human'; } throw new Error('stop'); },
  };
  await assert.rejects(runCli(['collect', '--urls', files.urlFile, '--dataset', files.datasetPath], interrupted), /stop/);
  const saved = JSON.parse(await readFile(files.datasetPath, 'utf8'));
  assert.equal(saved.records.length, 1);
  assert.equal(saved.records[0].label, 'human');
  let fetches = 0;
  await runCli(['collect', '--urls', files.urlFile, '--dataset', files.datasetPath], {
    ...deps(Array(9).fill('ai')), fetchImpl: async (...args) => { fetches++; return deps([]).fetchImpl(...args); },
  });
  assert.equal(fetches, 9);
  const resumed = JSON.parse(await readFile(files.datasetPath, 'utf8'));
  assert.equal(resumed.records.length, 10);
  assert.equal(resumed.records[0].label, 'human');
});

test('escapes terminal controls at prompt boundary while retaining raw snapshots', async t => {
  const files = await fixture(t);
  const unsafeTitle = `Title ${String.fromCodePoint(0x1b)}]0;owned${String.fromCodePoint(7)} C1 ${String.fromCodePoint(0x9b)}31m`;
  const unsafeBody = `first\nsecond ${String.fromCodePoint(0x1b)}[2J\rspoof ${String.fromCodePoint(0x1b)}]52;c;c3ludGhldGlj${String.fromCodePoint(7)}`;
  let promptText = '';
  await runCli(['collect', '--urls', files.urlFile, '--dataset', files.datasetPath], {
    ...deps(Array(10).fill('human')),
    fetchImpl: async () => ({ ok: true, json: async () => ({ title: unsafeTitle, body: unsafeBody }) }),
    prompt: async text => { promptText = text; return 'human'; },
  });
  for (const control of [0x1b, 0x9b, 0x07, 0x0d]) assert.equal(promptText.includes(String.fromCodePoint(control)), false);
  assert.ok(promptText.includes('first\nsecond'));
  assert.match(promptText, /\\x1B/);
  const saved = JSON.parse(await readFile(files.datasetPath, 'utf8'));
  assert.equal(saved.records[0].title, unsafeTitle);
  assert.equal(saved.records[0].body, unsafeBody);
});

test('creates nested artifact parents restrictively without changing existing permissions or overwriting', async t => {
  const files = await fixture(t);
  const nestedDataset = path.join(files.directory, 'new', 'deep', 'dataset.json');
  const nestedModel = path.join(files.directory, 'models', 'nested', 'model.json');
  const nestedReport = path.join(files.directory, 'reports', 'nested', 'report.json');
  await runCli(['collect', '--urls', files.urlFile, '--dataset', nestedDataset], deps(urls.map((_, index) => index % 2 ? 'ai' : 'human')));
  await runCli(['train', '--dataset', nestedDataset, '--model', nestedModel], { ...deps([]), baselineModelHash: 'a'.repeat(64) });
  await runCli(['evaluate', '--dataset', nestedDataset, '--model', nestedModel, '--report', nestedReport], { ...deps([]), baselineScore: async () => 0.2 });
  const { stat } = await import('node:fs/promises');
  assert.equal((await stat(path.dirname(path.dirname(nestedModel)))).mode & 0o077, 0);
  await assert.rejects(runCli(['train', '--dataset', nestedDataset, '--model', nestedModel], { ...deps([]), baselineModelHash: 'a'.repeat(64) }), error => error.code === 'EEXIST');
  await assert.rejects(runCli(['evaluate', '--dataset', nestedDataset, '--model', nestedModel, '--report', nestedReport], { ...deps([]), baselineScore: async () => 0.2 }), error => error.code === 'EEXIST');
  const existingDirectory = path.join(files.directory, 'existing');
  const { mkdir, chmod } = await import('node:fs/promises');
  await mkdir(existingDirectory);
  await chmod(existingDirectory, 0o750);
  await runCli(['collect', '--urls', files.urlFile, '--dataset', path.join(existingDirectory, 'data.json')], deps(urls.map((_, index) => index % 2 ? 'ai' : 'human')));
  assert.equal((await stat(existingDirectory)).mode & 0o777, 0o750);
});

test('rejects invalid arguments before side effects', async t => {
  const files = await fixture(t);
  await assert.rejects(runCli(['train', '--dataset', files.datasetPath], deps([])), /Usage:/);
  await assert.rejects(runCli(['collect', '--urls', files.urlFile, '--dataset', files.datasetPath], { env: {}, output() {} }), /GH_TOKEN/);
});

test('warns before writing tracked dataset and never prints credentials', async t => {
  const files = await fixture(t);
  const output = [];
  await runCli(['collect', '--urls', files.urlFile, '--dataset', files.datasetPath], {
    ...deps(urls.map((_, i) => i % 2 ? 'ai' : 'human'), output), isTracked: async () => true,
  });
  assert.ok(output.some(line => /Git-tracked/.test(line)));
  assert.equal(output.join('\n').includes('do-not-leak-token'), false);
});
