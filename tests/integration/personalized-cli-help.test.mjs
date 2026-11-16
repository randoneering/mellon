import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../../scripts/personalized-detection.mjs';

const script = fileURLToPath(new URL('../../scripts/personalized-detection.mjs', import.meta.url));

for (const command of ['', 'guided', 'collect', 'train', 'evaluate']) {
  test(`${command || 'root'} help succeeds without credentials or operational side effects`, async () => {
    const output = [];
    let sideEffects = 0;
    const unexpected = async () => { sideEffects++; throw new Error('Help must not perform this operation.'); };
    await runCli(command ? [command, '--help'] : ['--help'], {
      env: {}, output: line => output.push(line),
      prompt: unexpected, fetchImpl: unexpected, isTracked: unexpected,
    });
    assert.match(output.join('\n'), /Usage:/);
    for (const name of ['guided', 'collect', 'train', 'evaluate']) assert.ok(output.join('\n').includes(name));
    assert.match(output.join('\n'), /GH_TOKEN|GITHUB_TOKEN/);
    assert.match(output.join('\n'), /20/);
    assert.match(output.join('\n'), /100/);
    assert.match(output.join('\n'), /local/i);
    assert.equal(sideEffects, 0);
  });
}

test('the executable help exits zero without credentials and leaves its working directory unchanged', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mellon-help-'));
  // Keep cleanup within the test fixture, never the caller's working directory.
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(join(directory, 'keep.txt'), 'untouched');
  const result = spawnSync(process.execPath, [script, '--help'], {
    cwd: directory, env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '' },
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Usage:/);
  assert.deepEqual(await readdir(directory), ['keep.txt']);
  assert.equal(await readFile(join(directory, 'keep.txt'), 'utf8'), 'untouched');
});

for (const argv of [
  ['--help', '--dataset', '/should-not-write'],
  ['collect', '--help', '--dataset', '/should-not-write'],
  ['unknown', '--help'],
]) {
  test(`rejects ambiguous help ${argv.join(' ')} before side effects`, async () => {
    let sideEffects = 0;
    const unexpected = async () => { sideEffects++; throw new Error('Unexpected side effect.'); };
    await assert.rejects(runCli(argv, {
      env: {}, prompt: unexpected, fetchImpl: unexpected, isTracked: unexpected, output() {},
    }), /Usage:/);
    assert.equal(sideEffects, 0);
  });
}
