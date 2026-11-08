import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const runner = resolve(root, 'automation/ci/run-tests.mjs');
const [mode, target] = process.argv.slice(2);
const readDirectory = fs.readdirSync;
const extra = 'added-regression.test.mjs';

fs.readdirSync = (directory, options) => {
  const entries = readDirectory(directory, options);
  if (resolve(directory) !== resolve(root, 'tests/unit')) return entries;
  if (mode === 'omit') return entries.filter(entry => entry.name !== target);
  if (mode === 'rename') return entries.map(entry => entry.name === target
    ? { name: 'renamed-regression.test.mjs', isFile: () => true }
    : entry);
  if (mode === 'symlink') return entries.map(entry => entry.name === target
    ? { name: target, isFile: () => false }
    : entry);
  if (mode === 'add') return [...entries, { name: extra, isFile: () => true }];
  throw new Error('Invalid test-set probe mode.');
};
childProcess.spawnSync = (_command, args) => {
  process.stdout.write(`${JSON.stringify(args.slice(2))}\n`);
  return { status: 0 };
};
syncBuiltinESMExports();
delete process.env.GITHUB_ACTIONS;
process.argv[1] = runner;
await import(pathToFileURL(runner).href);
