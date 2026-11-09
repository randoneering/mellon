import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
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

test('guided manual entry collects, trains, and evaluates without leaking submissions', async t => {
  const files = await fixture(t);
  const output = [];
  const answers = ['', ...urls, '', files.datasetPath, files.modelPath, files.reportPath,
    ...urls.map((_, index) => index % 2 ? 'ai' : 'human')];
  await runCli(['guided'], {
    ...deps([], output),
    prompt: async () => answers.shift(),
    baselineModelHash: 'a'.repeat(64),
    baselineScore: async () => 0.2,
  });
  assert.equal(answers.length, 0);
  assert.equal(JSON.parse(await readFile(files.datasetPath, 'utf8')).records.length, 10);
  assert.ok(JSON.parse(await readFile(files.reportPath, 'utf8')).detectors.baseline);
  assert.doesNotMatch(output.join('\n'), /do-not-leak-token|Title 1|Body 1/);
});

for (const occupied of ['model', 'report']) {
  for (const kind of ['file', 'directory', 'dangling symlink']) {
    test(`guided refuses an existing ${occupied} ${kind} before collection`, async t => {
      const files = await fixture(t);
      const originalDataset = '{"version":1,"records":[]}';
      await writeFile(files.datasetPath, originalDataset);
      const target = occupied === 'model' ? files.modelPath : files.reportPath;
      if (kind === 'file') await writeFile(target, 'preserve me');
      else if (kind === 'directory') await mkdir(target);
      else await symlink('missing-target.json', target);
      let fetches = 0;
      const answers = [files.urlFile, files.datasetPath, files.modelPath, files.reportPath];
      await assert.rejects(runCli(['guided'], {
        ...deps([]), prompt: async () => answers.shift(),
        fetchImpl: async () => { fetches++; throw new Error('unexpected fetch'); },
      }), /already exists|choose a new/i);
      assert.equal(fetches, 0);
      assert.equal(await readFile(files.datasetPath, 'utf8'), originalDataset);
      if (kind === 'file') assert.equal(await readFile(target, 'utf8'), 'preserve me');
      else if (kind === 'directory') assert.equal((await lstat(target)).isDirectory(), true);
      else assert.equal(await readlink(target), 'missing-target.json');
      if (occupied === 'report') {
        await assert.rejects(lstat(files.modelPath), error => error.code === 'ENOENT');
      }
    });
  }
}

for (const destination of ['dataset', 'model', 'report']) {
  test(`guided confirms a new unignored ${destination} path before collection`, async t => {
    const files = await fixture(t);
    const repo = path.join(files.directory, 'repo');
    await mkdir(repo);
    execFileSync('git', ['init', '--quiet', repo]);
    const paths = { dataset: files.datasetPath, model: files.modelPath, report: files.reportPath };
    paths[destination] = path.join(repo, 'private', `${destination}.json`);
    const answers = [files.urlFile, paths.dataset, paths.model, paths.report, 'no'];
    const output = [];
    const options = deps([], output);
    delete options.isTracked;
    let fetches = 0;
    await assert.rejects(runCli(['guided'], {
      ...options, prompt: async () => answers.shift(),
      fetchImpl: async () => { fetches++; throw new Error('unexpected fetch'); },
    }), /cancel/i);
    assert.equal(fetches, 0);
    assert.ok(output.some(line => /not ignored/i.test(line)));
    for (const target of Object.values(paths)) {
      await assert.rejects(lstat(target), error => error.code === 'ENOENT');
    }
  });
}

test('guided can explicitly accept new private paths in a Git worktree', async t => {
  const files = await fixture(t);
  const repo = path.join(files.directory, 'repo');
  await mkdir(repo);
  execFileSync('git', ['init', '--quiet', repo]);
  const paths = ['dataset', 'model', 'report'].map(name => path.join(repo, 'private', `${name}.json`));
  const answers = [files.urlFile, ...paths, 'yes', 'yes', 'yes',
    ...urls.map((_, index) => index % 2 ? 'ai' : 'human')];
  const output = [];
  const options = deps([], output);
  delete options.isTracked;
  await runCli(['guided'], { ...options, prompt: async () => answers.shift(),
    baselineModelHash: 'a'.repeat(64), baselineScore: async () => 0.2 });
  assert.equal(answers.length, 0);
  assert.equal(JSON.parse(await readFile(paths[0], 'utf8')).records.length, 10);
  assert.equal(output.filter(line => /not ignored/i.test(line)).length, 3);
  for (const target of paths) assert.equal((await lstat(target)).isFile(), true);
});

test('guided accepts Git-ignored private paths without the unignored-path confirmation', async t => {
  const files = await fixture(t);
  const repo = path.join(files.directory, 'repo');
  await mkdir(repo);
  execFileSync('git', ['init', '--quiet', repo]);
  await writeFile(path.join(repo, '.gitignore'), 'private/\n');
  const paths = ['dataset', 'model', 'report'].map(name => path.join(repo, 'private', `${name}.json`));
  const answers = [files.urlFile, ...paths, ...urls.map((_, index) => index % 2 ? 'ai' : 'human')];
  const output = [];
  const options = deps([], output);
  delete options.isTracked;
  await runCli(['guided'], { ...options, prompt: async () => answers.shift(),
    baselineModelHash: 'a'.repeat(64), baselineScore: async () => 0.2 });
  assert.equal(answers.length, 0);
  assert.equal(output.some(line => /not ignored/i.test(line)), false);
  assert.equal(JSON.parse(await readFile(paths[0], 'utf8')).records.length, 10);
});

test('guided checks outer repositories even when an inner repository ignores the private path', async t => {
  const files = await fixture(t);
  const outer = path.join(files.directory, 'outer');
  const inner = path.join(outer, 'inner');
  await mkdir(inner, { recursive: true });
  execFileSync('git', ['init', '--quiet', outer]);
  execFileSync('git', ['init', '--quiet', inner]);
  // Local excludes do not protect a path when the outer repository checks it.
  await writeFile(path.join(inner, '.git', 'info', 'exclude'), 'private/\n');
  const target = path.join(inner, 'private', 'dataset.json');
  const answers = [files.urlFile, target, files.modelPath, files.reportPath, 'no'];
  const output = [];
  const options = deps([], output);
  delete options.isTracked;
  await assert.rejects(runCli(['guided'], { ...options, prompt: async () => answers.shift() }), /cancel/i);
  assert.ok(output.some(line => /not ignored/i.test(line)));
  await assert.rejects(lstat(target), error => error.code === 'ENOENT');
});

test('guided recognizes new repository-private paths through symlinked directories', async t => {
  const files = await fixture(t);
  const repo = path.join(files.directory, 'repo');
  await mkdir(repo);
  execFileSync('git', ['init', '--quiet', repo]);
  const link = path.join(files.directory, 'linked');
  await symlink(repo, link, 'dir');
  const target = path.join(link, 'dataset.json');
  const answers = [files.urlFile, target, files.modelPath, files.reportPath, 'no'];
  const output = [];
  const options = deps([], output);
  delete options.isTracked;
  await assert.rejects(runCli(['guided'], { ...options, prompt: async () => answers.shift() }), /cancel/i);
  assert.ok(output.some(line => /not ignored/i.test(line)));
  await assert.rejects(lstat(path.join(repo, 'dataset.json')), error => error.code === 'ENOENT');
});

test('guided escapes terminal controls in new repository-private path warnings', async t => {
  const files = await fixture(t);
  const repo = path.join(files.directory, 'repo');
  await mkdir(repo);
  execFileSync('git', ['init', '--quiet', repo]);
  const target = path.join(repo, 'dataset\u001b[31m.json');
  const answers = [files.urlFile, target, files.modelPath, files.reportPath, 'no'];
  const output = [];
  const options = deps([], output);
  delete options.isTracked;
  await assert.rejects(runCli(['guided'], { ...options, prompt: async () => answers.shift() }), /cancel/i);
  const warning = output.find(line => /not ignored/i.test(line));
  assert.ok(warning);
  assert.equal(warning.includes('\u001b'), false);
  assert.ok(warning.includes('\\x1B'));
});

test('guided stops safely when an artifact destination cannot be inspected', async t => {
  const files = await fixture(t);
  const loop = path.join(files.directory, 'do-not-leak-path');
  await symlink('do-not-leak-path', loop, 'dir');
  const answers = [files.urlFile, files.datasetPath, path.join(loop, 'model.json'), files.reportPath];
  let fetches = 0;
  await assert.rejects(runCli(['guided'], {
    ...deps([]), prompt: async () => answers.shift(),
    fetchImpl: async () => { fetches++; throw new Error('unexpected fetch'); },
  }), error => {
    assert.match(error.message, /Unable to inspect the model destination/);
    assert.doesNotMatch(error.message, /do-not-leak-path/);
    return true;
  });
  assert.equal(fetches, 0);
  await assert.rejects(lstat(files.datasetPath), error => error.code === 'ENOENT');
});

test('guided keeps exclusive artifact writes after an early path check', async t => {
  const files = await fixture(t);
  const answers = [files.urlFile, files.datasetPath, files.modelPath, files.reportPath,
    ...urls.map((_, index) => index % 2 ? 'ai' : 'human')];
  const options = deps([]);
  let fetches = 0;
  await assert.rejects(runCli(['guided'], {
    ...options, prompt: async () => answers.shift(), baselineModelHash: 'a'.repeat(64),
    fetchImpl: async (...args) => {
      if (fetches++ === 0) await writeFile(files.modelPath, 'concurrent artifact');
      return options.fetchImpl(...args);
    },
  }), /Model already exists/);
  assert.equal(await readFile(files.modelPath, 'utf8'), 'concurrent artifact');
  assert.equal(JSON.parse(await readFile(files.datasetPath, 'utf8')).records.length, 10);
  await assert.rejects(lstat(files.reportPath), error => error.code === 'ENOENT');
});

test('guided file input refuses a tracked destination without confirmation', async t => {
  const files = await fixture(t);
  const answers = [files.urlFile, files.datasetPath, files.modelPath, files.reportPath, 'no'];
  await assert.rejects(runCli(['guided'], {
    ...deps([]), prompt: async () => answers.shift(), isTracked: async () => true,
  }), /cancel/i);
  await assert.rejects(readFile(files.datasetPath), error => error.code === 'ENOENT');
});

test('guided resumes saved labels and confirms tracked destinations at each stage', async t => {
  const files = await fixture(t);
  let first = true;
  await assert.rejects(runCli(['collect', '--urls', files.urlFile, '--dataset', files.datasetPath], {
    ...deps([]), prompt: async () => { if (first) { first = false; return 'human'; } throw new Error('interrupted'); },
  }), /interrupted/);
  let fetches = 0;
  const answers = [files.urlFile, files.datasetPath, files.modelPath, files.reportPath, 'yes', 'yes', 'yes',
    ...urls.slice(1).map((_, index) => index % 2 ? 'human' : 'ai')];
  const output = [];
  await runCli(['guided'], {
    ...deps([], output), isTracked: async () => true,
    prompt: async () => answers.shift(), baselineModelHash: 'a'.repeat(64),
    baselineScore: async () => 0.2,
    fetchImpl: async (...args) => { fetches++; return deps([]).fetchImpl(...args); },
  });
  assert.equal(fetches, 9);
  assert.equal(answers.length, 0);
  assert.equal(JSON.parse(await readFile(files.datasetPath, 'utf8')).records[0].label, 'human');
  assert.ok(output.filter(line => line.startsWith('Warning: destination is Git-tracked')).length === 3);
});

test('guided recognizes a tracked file through a symlinked directory', async t => {
  const files = await fixture(t);
  const repo = path.join(files.directory, 'repo');
  await mkdir(repo);
  execFileSync('git', ['init', '--quiet', repo]);
  await writeFile(path.join(repo, 'dataset.json'), 'existing');
  execFileSync('git', ['-C', repo, 'add', 'dataset.json']);
  const link = path.join(files.directory, 'linked');
  await symlink(repo, link, 'dir');
  const answers = [files.urlFile, path.join(link, 'dataset.json'), files.modelPath, files.reportPath, 'no'];
  const output = [];
  const options = deps([], output);
  delete options.isTracked;
  await assert.rejects(runCli(['guided'], { ...options, prompt: async () => answers.shift() }), /cancel/i);
  assert.ok(output.some(line => line.includes('Git-tracked')));
  assert.equal(await readFile(path.join(repo, 'dataset.json'), 'utf8'), 'existing');
});

test('guided manual entry can resume after re-entering URLs', async t => {
  const files = await fixture(t);
  const setup = ['', ...urls, '', files.datasetPath, files.modelPath, files.reportPath];
  const first = [...setup, 'human'];
  await assert.rejects(runCli(['guided'], {
    ...deps([]), prompt: async () => { if (first.length) return first.shift(); throw new Error('interrupted'); },
  }), /interrupted/);
  let fetches = 0;
  const answers = [...setup, ...urls.slice(1).map((_, index) => index % 2 ? 'human' : 'ai')];
  await runCli(['guided'], {
    ...deps([]), prompt: async () => answers.shift(), baselineModelHash: 'a'.repeat(64),
    baselineScore: async () => 0.2,
    fetchImpl: async (...args) => { fetches++; return deps([]).fetchImpl(...args); },
  });
  assert.equal(fetches, 9);
  assert.equal(JSON.parse(await readFile(files.datasetPath, 'utf8')).records[0].label, 'human');
});

test('guided treats a cancelled label prompt as cancellation and preserves prior labels', async t => {
  const files = await fixture(t);
  const answers = [files.urlFile, files.datasetPath, files.modelPath, files.reportPath, 'human'];
  await assert.rejects(runCli(['guided'], {
    ...deps([]), prompt: async () => answers.shift(),
  }), /Guided workflow cancelled/);
  const saved = JSON.parse(await readFile(files.datasetPath, 'utf8'));
  assert.equal(saved.records.length, 1);
  assert.equal(saved.records[0].label, 'human');
});

test('guided uses GITHUB_TOKEN when GH_TOKEN is empty', async t => {
  const files = await fixture(t);
  const answers = [files.urlFile, files.datasetPath, files.modelPath, files.reportPath,
    ...urls.map((_, index) => index % 2 ? 'ai' : 'human')];
  await runCli(['guided'], {
    ...deps([]), env: { GH_TOKEN: '', GITHUB_TOKEN: 'do-not-leak-token' },
    prompt: async () => answers.shift(), baselineModelHash: 'a'.repeat(64),
    baselineScore: async () => 0.2,
  });
  assert.equal(JSON.parse(await readFile(files.datasetPath, 'utf8')).records.length, 10);
});

test('guided checks outer repositories for tracked destinations', async t => {
  const files = await fixture(t);
  const outer = path.join(files.directory, 'outer');
  const inner = path.join(outer, 'inner');
  await mkdir(inner, { recursive: true });
  execFileSync('git', ['init', '--quiet', outer]);
  await writeFile(path.join(inner, 'dataset.json'), 'existing');
  execFileSync('git', ['-C', outer, 'add', 'inner/dataset.json']);
  execFileSync('git', ['init', '--quiet', inner]);
  const answers = [files.urlFile, path.join(inner, 'dataset.json'), files.modelPath, files.reportPath, 'no'];
  const options = deps([]);
  delete options.isTracked;
  await assert.rejects(runCli(['guided'], { ...options, prompt: async () => answers.shift() }), /cancel/i);
  assert.equal(await readFile(path.join(inner, 'dataset.json'), 'utf8'), 'existing');
});

test('guided rejects artifact paths aliased through a symlink', async t => {
  const files = await fixture(t);
  const link = path.join(files.directory, 'linked');
  await symlink(files.directory, link, 'dir');
  const answers = [files.urlFile, files.datasetPath, path.join(link, 'dataset.json'), files.reportPath];
  await assert.rejects(runCli(['guided'], { ...deps([]), prompt: async () => answers.shift() }), /must be distinct/);
  await assert.rejects(readFile(files.datasetPath), error => error.code === 'ENOENT');
});

test('guided fails closed when tracked status cannot be checked', async t => {
  const files = await fixture(t);
  const answers = [files.urlFile, files.datasetPath, files.modelPath, files.reportPath];
  await assert.rejects(runCli(['guided'], {
    ...deps([]), prompt: async () => answers.shift(), isTracked: async () => { throw new Error('sensitive'); },
  }), /Unable to check whether the destination is Git-tracked/);
  await assert.rejects(readFile(files.datasetPath), error => error.code === 'ENOENT');
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
