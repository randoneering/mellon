import { createHash } from 'node:crypto';

const MAX_FILES = 10;
const MAX_FILE_BYTES = 65_536;
const MAX_TOTAL_BYTES = 262_144;
const HEX_SHA1 = /^[a-f0-9]{40}$/;
const VALID_KEYS = {
  base: ['path', 'mode', 'blobSha'],
  create: ['operation', 'path', 'content'],
  modify: ['operation', 'path', 'content', 'expectedBlobSha'],
};

function fail() {
  throw new TypeError('Patch validation failed.');
}

function hasExactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function validPath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > 200
    || path.startsWith('/') || path.includes('\\') || path.includes('%')
    || /[\u0000-\u001f\u007f-\u009f]/u.test(path)
    || /^[a-zA-Z]:/u.test(path)) return false;
  if (path.normalize('NFC') !== path) return false;
  const segments = path.split('/');
  if (segments.some((part) => part === '' || part === '.' || part === '..')) return false;
  return !segments.some((part) => part.endsWith('.') || part.endsWith(' '));
}

function protectedPath(path) {
  const value = path.toLowerCase();
  const segments = value.split('/');
  const basename = segments.at(-1);
  if (segments.some((part) => part === '.git' || part === '.ssh' || part === '.gnupg'
    || part === 'auth' || part === 'credentials' || part === 'secrets'
    || part === 'policies' || part === 'policy' || part === 'skills'
    || part === 'automation' || part === '.neon' || part === '.pi'
    || part === '.agents' || part === '.superpowers')) return true;
  if (basename === 'agents.md' || basename === '.env' || basename.startsWith('.env.')
    || basename === 'credentials.json' || basename === 'secrets.json'
    || basename.endsWith('.secret') || basename.endsWith('.pem')
    || basename.endsWith('.key') || basename.endsWith('.p12')
    || basename.endsWith('.pfx')) return true;
  if (segments.includes('.github')) return true;
  if (['action.yml', 'action.yaml', 'src/action.mjs', 'src/github.mjs', 'src/inputs.mjs',
    'src/moderation.mjs', 'src/prepare.mjs'].includes(value)) return true;
  if (['neon.ts', '.npmrc', '.yarnrc', '.yarnrc.yml'].includes(basename)) return true;
  if (/^agent-(?:worker|intake)-/.test(basename) || /^test-agent-(?:worker|intake)/.test(basename)) return true;
  if (value.startsWith('scripts/tests/') || [
    'scripts/build.mjs', 'scripts/validate-release.mjs', 'scripts/verify-assets.mjs', 'scripts/coverage.mjs',
  ].includes(value)) return true;
  if (['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'].includes(basename)) return true;
  if (segments[0] === 'dist' || segments[0] === 'detector' || segments[0] === 'migrations') return true;
  return false;
}

function utf8Bytes(text) {
  if (typeof text !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) fail();
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.toString('utf8') !== text) fail();
  return bytes;
}

function gitBlobSha(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function validScope(scope) {
  return hasExactKeys(scope, ['kind', 'maxChangedFiles', 'maxFileBytes', 'maxTotalBytes'])
    && scope.kind === 'bounded-public-issue'
    && Number.isSafeInteger(scope.maxChangedFiles) && scope.maxChangedFiles > 0
    && scope.maxChangedFiles <= MAX_FILES
    && Number.isSafeInteger(scope.maxFileBytes) && scope.maxFileBytes > 0
    && scope.maxFileBytes <= MAX_FILE_BYTES
    && Number.isSafeInteger(scope.maxTotalBytes) && scope.maxTotalBytes > 0
    && scope.maxTotalBytes <= MAX_TOTAL_BYTES
    && scope.maxFileBytes <= scope.maxTotalBytes;
}

function validBaseEntry(file) {
  if (!hasExactKeys(file, VALID_KEYS.base) || !validPath(file.path)) return false;
  if (file.mode === null || file.mode === '040000') return file.blobSha === null;
  return ['100644', '100755', '120000', '160000'].includes(file.mode)
    && typeof file.blobSha === 'string' && HEX_SHA1.test(file.blobSha);
}

function safeTarget(current, path) {
  const parts = path.split('/');
  let absentAncestor = false;
  for (let index = 1; index < parts.length; index += 1) {
    const ancestor = current.get(parts.slice(0, index).join('/'));
    if (!ancestor || (ancestor.mode !== null && ancestor.mode !== '040000')) fail();
    if (ancestor.mode === null) absentAncestor = true;
    else if (absentAncestor) fail();
  }
  const target = current.get(path);
  if (!target || absentAncestor && target.mode !== null) fail();
  for (const [otherPath, entry] of current) {
    if (otherPath.startsWith(`${path}/`) && entry.mode !== null) fail();
  }
  return target;
}

/** Validate proposed file changes against trusted base metadata and the approved path scope. */
export function validateChanges(baseFiles, proposed, manifest) {
  if (!Array.isArray(baseFiles) || !Array.isArray(proposed)
    || proposed.length === 0 || !hasExactKeys(manifest, ['allowedPaths', 'pilotScope'])
    || !validScope(manifest.pilotScope) || !Array.isArray(manifest.allowedPaths)
    || manifest.allowedPaths.length === 0 || manifest.allowedPaths.length > 32) fail();

  const allowed = new Set();
  for (const path of manifest.allowedPaths) {
    if (!validPath(path) || protectedPath(path) || allowed.has(path)) fail();
    allowed.add(path);
  }

  const current = new Map();
  for (const file of baseFiles) {
    if (!validBaseEntry(file) || current.has(file.path)) fail();
    current.set(file.path, { mode: file.mode, blobSha: file.blobSha });
  }

  const scope = {
    maxChangedFiles: manifest.pilotScope.maxChangedFiles,
    maxFileBytes: manifest.pilotScope.maxFileBytes,
    maxTotalBytes: manifest.pilotScope.maxTotalBytes,
  };
  const maxFiles = Math.min(scope.maxChangedFiles, MAX_FILES);
  const maxFileBytes = Math.min(scope.maxFileBytes, MAX_FILE_BYTES);
  const maxTotalBytes = Math.min(scope.maxTotalBytes, MAX_TOTAL_BYTES);
  if (proposed.length > maxFiles) fail();

  const seen = new Set();
  let totalBytes = 0;
  const accepted = [];
  for (const change of proposed) {
    if (change === null || typeof change !== 'object' || Array.isArray(change)
      || (change.operation !== 'create' && change.operation !== 'modify')) fail();
    const keys = VALID_KEYS[change.operation];
    if (!hasExactKeys(change, keys) || !validPath(change.path)
      || protectedPath(change.path) || !allowed.has(change.path)
      || seen.has(change.path)) fail();
    if ([...seen].some(path => change.path.startsWith(`${path}/`) || path.startsWith(`${change.path}/`))) fail();
    seen.add(change.path);
    const existing = safeTarget(current, change.path);
    if (change.operation === 'create' ? existing.mode !== null : !['100644', '100755'].includes(existing.mode)) fail();
    if (change.operation === 'modify' && (typeof change.expectedBlobSha !== 'string'
      || !HEX_SHA1.test(change.expectedBlobSha)
      || change.expectedBlobSha !== existing.blobSha)) fail();
    const bytes = utf8Bytes(change.content);
    totalBytes += bytes.length;
    if (bytes.length > maxFileBytes || totalBytes > maxTotalBytes) fail();
    accepted.push(Object.freeze({
      operation: change.operation,
      path: `${change.path}`,
      content: `${change.content}`,
      mode: existing?.mode ?? '100644',
      expectedBlobSha: change.operation === 'modify' ? `${change.expectedBlobSha}` : null,
      contentBytes: bytes.length,
      contentBlobSha: gitBlobSha(bytes),
    }));
  }
  return Object.freeze(accepted);
}
