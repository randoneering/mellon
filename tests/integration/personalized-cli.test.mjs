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
