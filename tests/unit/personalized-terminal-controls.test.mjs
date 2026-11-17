import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../../scripts/personalized-detection.mjs';

const submissionUrl = 'https://github.com/acme/project/issues/47';
const cases = [
  {
    name: 'OSC BEL termination in title',
    title: 'before \u001b]0;synthetic title\u0007 after',
    body: 'Ordinary description',
    expectedPrompt: 'https://github.com/acme/project/issues/47\nbefore \\x1B]0;synthetic title\\x07 after\nOrdinary description\nLabel [human/ai/unsure]: ',
  },
  {
    name: 'OSC BEL termination in description',
    title: 'Ordinary title',
    body: 'before \u001b]0;synthetic title\u0007 after',
    expectedPrompt: 'https://github.com/acme/project/issues/47\nOrdinary title\nbefore \\x1B]0;synthetic title\\x07 after\nLabel [human/ai/unsure]: ',
  },
  {
    name: 'OSC ESC-backslash termination in title',
    title: 'before \u001b]0;synthetic title\u001b\\ after',
    body: 'Ordinary description',
    expectedPrompt: 'https://github.com/acme/project/issues/47\nbefore \\x1B]0;synthetic title\\x1B\\ after\nOrdinary description\nLabel [human/ai/unsure]: ',
  },
  {
    name: 'OSC ESC-backslash termination in description',
    title: 'Ordinary title',
    body: 'before \u001b]0;synthetic title\u001b\\ after',
    expectedPrompt: 'https://github.com/acme/project/issues/47\nOrdinary title\nbefore \\x1B]0;synthetic title\\x1B\\ after\nLabel [human/ai/unsure]: ',
  },
  {
    name: 'C1 CSI formatting and reset in title',
    title: 'before \u009b31mcolored\u009b0m after',
    body: 'Ordinary description',
    expectedPrompt: 'https://github.com/acme/project/issues/47\nbefore \\x9B31mcolored\\x9B0m after\nOrdinary description\nLabel [human/ai/unsure]: ',
  },
  {
    name: 'C1 CSI formatting and reset in description',
    title: 'Ordinary title',
    body: 'before \u009b31mcolored\u009b0m after',
    expectedPrompt: 'https://github.com/acme/project/issues/47\nOrdinary title\nbefore \\x9B31mcolored\\x9B0m after\nLabel [human/ai/unsure]: ',
  },
  {
    name: 'newlines and tabs within both fields',
    title: 'Title first\nTitle second\tcolumn',
    body: 'Body first\tcolumn\nBody second',
    expectedPrompt: 'https://github.com/acme/project/issues/47\nTitle first\nTitle second\tcolumn\nBody first\tcolumn\nBody second\nLabel [human/ai/unsure]: ',
  },
];

async function privateDataset(t) {
  const repository = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
  const temporaryRoot = await realpath(tmpdir());
  const relativeRoot = path.relative(repository, temporaryRoot);
  assert.ok(relativeRoot === '..' || relativeRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeRoot),
    'Temporary data must stay outside the repository');
  const directory = await mkdtemp(path.join(temporaryRoot, 'mellon-terminal-controls-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal((await stat(directory)).mode & 0o077, 0);
  return path.join(directory, 'dataset.json');
}

for (const { name, title, body, expectedPrompt } of cases) {
  test(`collect safely displays ${name} and retains the raw snapshot`, async t => {
    const datasetPath = await privateDataset(t);
    const requests = [];
    const prompts = [];
    const output = [];

    await runCli(['collect', '--urls', '-', '--dataset', datasetPath], {
      urls: [submissionUrl],
      env: { GH_TOKEN: 'synthetic-terminal-controls-token' },
      fetchImpl: async (url, options) => {
        requests.push({
          url,
          method: options.method,
          redirect: options.redirect,
          authorization: options.headers.authorization,
        });
        return { ok: true, json: async () => ({ title, body }) };
      },
      prompt: async question => {
        prompts.push(question);
        return 'human';
      },
      output: line => output.push(line),
      isTracked: async () => false,
    });

    // Collection catches fetch failures, so request assertions belong after runCli.
    assert.deepEqual(requests, [{
      url: 'https://api.github.com/repos/acme/project/issues/47',
      method: 'GET',
      redirect: 'manual',
      authorization: 'Bearer synthetic-terminal-controls-token',
    }]);
    assert.deepEqual(prompts, [expectedPrompt]);
    assert.doesNotMatch(prompts[0], /[\u001b\u0007\u009b]/u);
    assert.deepEqual(output, []);

    const saved = JSON.parse(await readFile(datasetPath, 'utf8'));
    assert.deepEqual(saved, {
      version: 1,
      records: [{ url: submissionUrl, title, body, label: 'human' }],
    });
  });
}
