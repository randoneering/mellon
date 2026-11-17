import { createHash } from 'node:crypto';

export const GENERATED_PATHS = Object.freeze([
  'dist/index.mjs', 'dist/scorer.mjs', 'dist/build-meta.json', 'dist/THIRD_PARTY_NOTICES.txt',
  'dist/detector/provenance.json', 'dist/detector/vendor/aicomment/LICENSE',
  'dist/detector/vendor/aicomment/classifier.mjs',
  'dist/detector/vendor/aicomment/langs/c_family.mjs', 'dist/detector/vendor/aicomment/langs/elisp.mjs',
  'dist/detector/vendor/aicomment/langs/haskell.mjs', 'dist/detector/vendor/aicomment/langs/index.mjs',
  'dist/detector/vendor/aicomment/langs/perl.mjs', 'dist/detector/vendor/aicomment/langs/php.mjs',
  'dist/detector/vendor/aicomment/langs/python.mjs', 'dist/detector/vendor/aicomment/langs/registry.mjs',
  'dist/detector/vendor/aicomment/langs/shell.mjs', 'dist/detector/vendor/aicomment/model.json',
  'dist/detector/vendor/aicomment/preprocess.mjs', 'dist/detector/vendor/aicomment/pychars.mjs',
]);

export function selectGeneratedChanges(input) {
  const reject = () => { throw new Error('Generated publication input rejected.'); };
  if (!/^[a-f0-9]{40}$/.test(input?.sourceSha ?? '') || input.treeSourceSha !== input.sourceSha
      || input.tree?.truncated !== false || !Array.isArray(input.tree.tree)
      || !Array.isArray(input.additions) || input.additions.length !== GENERATED_PATHS.length) reject();
  const existing = new Map();
  for (const entry of input.tree.tree) {
    if (!GENERATED_PATHS.includes(entry.path)) continue;
    if (entry.type !== 'blob' || !/^[a-f0-9]{40}$/.test(entry.sha ?? '') || existing.has(entry.path)) reject();
    existing.set(entry.path, entry.sha);
  }
  const seen = new Set();
  const changed = [];
  let total = 0;
  for (const file of input.additions) {
    if (!GENERATED_PATHS.includes(file?.path) || seen.has(file.path)
        || typeof file.contents !== 'string' || !file.contents.length || file.contents.length > 11184812) reject();
    seen.add(file.path);
    const bytes = Buffer.from(file.contents, 'base64');
    total += bytes.length;
    if (!bytes.length || bytes.length > 8 * 1024 * 1024 || total > 16 * 1024 * 1024
        || bytes.toString('base64') !== file.contents
        || !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) reject();
    const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (existing.get(file.path) !== sha) changed.push({ path:file.path,contents:file.contents });
  }
  return {
    sourceSha: input.sourceSha, noOp: changed.length === 0,
    decodedBytes: total, unchangedCount: GENERATED_PATHS.length - changed.length,
    changedPaths: changed.map(file => file.path), batches: changed.map(file => [file]),
  };
}
