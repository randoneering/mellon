import { createHash } from 'node:crypto';

const TRUSTED_ROOTS = new Set([
  'automation/policy/system.md',
  'AGENTS.md',
  'automation/policy/skills/test-driven-development/SKILL.md',
  'automation/policy/skills/systematic-debugging/SKILL.md',
  'automation/policy/skills/verification-before-completion/SKILL.md',
  'automation/policy/documentation.md',
  'automation/policy/skills/test-driven-development/writing-good-tests.md',
  'automation/policy/skills/systematic-debugging/root-cause-tracing.md',
  'automation/policy/skills/systematic-debugging/defense-in-depth.md',
  'automation/policy/skills/systematic-debugging/condition-based-waiting.md',
]);
const REQUIRED_SKILLS = [
  'test-driven-development',
  'systematic-debugging',
  'verification-before-completion',
];
const REQUIRED_REFERENCES = {
  'test-driven-development': ['writing-good-tests.md'],
  'systematic-debugging': ['root-cause-tracing.md', 'defense-in-depth.md', 'condition-based-waiting.md'],
  'verification-before-completion': [],
};
const HASH = /^[a-f0-9]{64}$/;
const PINNED_HASHES = new Map([
  ['automation/policy/system.md', 'ab24bdd185bd6eb49a026d9cd3832a8f82c39c2a9de924064c2e13da244e5792'],
  ['AGENTS.md', 'baed526474d63edd5aa001db9a334c6222e764954caaea8da82bfaddc1a84537'],
  ['automation/policy/skills/test-driven-development/SKILL.md', '64b03fce4aee5a97a93160cea8111f3ba13a17b7c001db4bd5836d67fd10705d'],
  ['automation/policy/skills/systematic-debugging/SKILL.md', '51c6435d98c83c42c96ba7c35725a0b2c376cd487fb1a4e6bd0ddbe7e33ef202'],
  ['automation/policy/skills/verification-before-completion/SKILL.md', '2befe7fc55bcadaa3d97dd9e8efeb633d2561c0ebe74c5a8b17c4d9e7e4520b3'],
  ['automation/policy/documentation.md', '8505ed17cdbf76f4b42530784364ce1a76ebd9285048bfa17d491eee978a73cd'],
  ['automation/policy/skills/test-driven-development/writing-good-tests.md', '51471c853306ff92ca8bb41dcaea05f31c0e46b03651f8f3c99754b7172f4ae1'],
  ['automation/policy/skills/systematic-debugging/root-cause-tracing.md', '75b933b6a8c40bdb2031b10f21654395b56ec6ab6bc7b018c18d3fe57aeb7fb8'],
  ['automation/policy/skills/systematic-debugging/defense-in-depth.md', '1e175fb86fc357e58c6aebf5441e481e1b7868b4380c0456b63a17eefbd18ba7'],
  ['automation/policy/skills/systematic-debugging/condition-based-waiting.md', 'e89fec8400d6cd50f43407cec9fab50976ba4d55d0ec2eb51c0bd68036b54c26'],
]);
const MAX_SOURCE_BYTES = 128 * 1024;

function fail(reason) {
  throw new Error(reason);
}

function validDescriptor(source, expectedPath) {
  return source && source.path === expectedPath && TRUSTED_ROOTS.has(source.path) && HASH.test(source.hash ?? '') && source.hash === PINNED_HASHES.get(source.path);
}

function hash(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function loadSource(source, dependencies) {
  let content;
  try {
    content = await dependencies.readTrustedFile(source.path);
  } catch {
    fail(`trusted source unavailable: ${source.path}`);
  }
  if (content === undefined || content === null) fail(`trusted source unavailable: ${source.path}`);
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_SOURCE_BYTES) {
    fail(`trusted source invalid: ${source.path}`);
  }
  const actualHash = hash(content);
  if (actualHash !== source.hash) fail(`trusted source hash mismatch: ${source.path}`);
  return { content, sha256: actualHash, path: source.path };
}

export async function loadPolicy(manifest, dependencies) {
  if (manifest === undefined || manifest === null) return { enabled: false, reason: 'manifest_missing' };
  if (manifest.enabled !== true) return { enabled: false, reason: 'disabled' };
  if (!manifest.pilot || typeof manifest.pilot.repository !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(manifest.pilot.repository) || !Number.isSafeInteger(manifest.pilot.issueNumber) || manifest.pilot.issueNumber < 1) {
    return { enabled: false, reason: 'pilot_missing' };
  }
  if (!dependencies || typeof dependencies.readTrustedFile !== 'function') fail('trusted file reader required');
  const sources = manifest.trustedSources;
  if (!sources || !validDescriptor(sources.policy, 'automation/policy/system.md') || !validDescriptor(sources.projectRules, 'AGENTS.md') || !validDescriptor(sources.guidance, 'automation/policy/documentation.md') || !Array.isArray(sources.skills) || sources.skills.length !== REQUIRED_SKILLS.length) {
    fail('unapproved trusted source');
  }
  const byName = new Map();
  for (const skill of sources.skills) {
    if (!skill || !REQUIRED_SKILLS.includes(skill.name) || byName.has(skill.name) || !validDescriptor(skill, `automation/policy/skills/${skill.name}/SKILL.md`)) fail('unapproved trusted source');
    const required = REQUIRED_REFERENCES[skill.name];
    if (!Array.isArray(skill.references) || skill.references.length !== required.length ||
        required.some((filename, index) => !validDescriptor(skill.references[index], `automation/policy/skills/${skill.name}/${filename}`))) {
      fail('unapproved trusted source');
    }
    byName.set(skill.name, skill);
  }
  if (REQUIRED_SKILLS.some(name => !byName.has(name))) fail('unapproved trusted source');

  const policy = await loadSource(sources.policy, dependencies);
  const projectRules = await loadSource(sources.projectRules, dependencies);
  const documentationGuidance = await loadSource(sources.guidance, dependencies);
  const skills = [];
  for (const name of REQUIRED_SKILLS) {
    const source = byName.get(name);
    const loaded = await loadSource(source, dependencies);
    const references = [];
    for (const reference of source.references) references.push(await loadSource(reference, dependencies));
    skills.push({ name, content: loaded.content, sha256: loaded.sha256, path: loaded.path, references });
  }
  return {
    status: 'loaded',
    pilot: { repository: manifest.pilot.repository, issueNumber: manifest.pilot.issueNumber },
    systemPolicy: policy.content,
    projectRules: projectRules.content,
    documentationGuidance: documentationGuidance.content,
    skills,
    sources: {
      policy: { path: policy.path, sha256: policy.sha256 },
      projectRules: { path: projectRules.path, sha256: projectRules.sha256 },
      guidance: { path: documentationGuidance.path, sha256: documentationGuidance.sha256 },
    },
  };
}
