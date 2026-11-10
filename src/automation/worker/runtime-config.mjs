import { createHash } from 'node:crypto';
import { SOL_MODEL_PROFILE, validManifestModel } from './model-profile.mjs';
import { CONSERVATIVE_INPUT_MODE } from './input-budget.mjs';
import { SUBMITTED_REVIEW_PROFILE, validQodoIdentity } from './review-contract.mjs';
import { validateLimitsFromRow } from './store-validation.mjs';
import { validateCoordinatorConfig } from './approval.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const PREFLIGHT_CHECKS = Object.freeze([
  'native_ingress', 'worker_credential_isolation', 'gateway_model_tools_usage',
  'gateway_spend_limits', 'github_app_signing', 'qodo_draft_review', 'qodo_updated_head_review',
]);
const STARTUP_PREFLIGHT_CHECKS = Object.freeze([
  'native_ingress', 'worker_credential_isolation', 'gateway_model_tools_usage',
  'gateway_spend_limits', 'github_app_signing',
]);
const STARTUP_PREFLIGHT_PURPOSE = 'first-run-startup';
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function invalid() { throw new Error('Worker runtime configuration is invalid.'); }

export function readRuntimeConfiguration(env) {
  try {
    const raw = env.AGENT_WORKER_CONFIG_JSON;
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 128 * 1024) return null;
    return freeze(JSON.parse(raw));
  } catch { return null; }
}

export function authorizeRuntimeConfiguration(config, env, now = Date.now()) {
  try {
    if (!exact(config, ['version', 'productionBranch', 'triggerId', 'databaseRole',
      'manifest', 'manifestSha256', 'policyManifest', 'github', 'preflight'])
      || config.version !== 1 || !SHA256.test(env.AGENT_WORKER_CONFIG_SHA256 ?? '')
      || hash(canonical(config)) !== env.AGENT_WORKER_CONFIG_SHA256
      || !SHA256.test(config.manifestSha256 ?? '')
      || hash(canonical(config.manifest)) !== config.manifestSha256
      || config.manifest?.approved !== true || !validManifestModel(config.manifest.model)
      || config.manifest.model.id !== SOL_MODEL_PROFILE.id
      || config.manifest.model.inputAdmission !== CONSERVATIVE_INPUT_MODE
      || !Array.isArray(config.manifest.qodoIdentities)
      || config.manifest.qodoIdentities.length === 0
      || !config.manifest.qodoIdentities.every(identity => validQodoIdentity(identity)
        && identity.completion === SUBMITTED_REVIEW_PROFILE)
      || config.policyManifest?.enabled !== true
      || config.policyManifest.pilot?.repository !== config.manifest.repository?.name
      || config.policyManifest.pilot?.issueNumber !== config.manifest.issue?.number
      || !exact(config.github, ['appId', 'installationId', 'actor', 'preflightCommitSha'])) invalid();
    validateLimitsFromRow(config.manifest.limits);
    const baseURL = env.WORKER_MODEL_BASE_URL;
    const apiKey = env.WORKER_MODEL_TOKEN;
    const privateKey = env.AGENT_WORKER_APP_PRIVATE_KEY;
    const url = new URL(baseURL);
    if (url.protocol !== 'https:' || url.port || url.username || url.password
      || url.search || url.hash || url.pathname !== '/'
      || !url.hostname.endsWith('.neon.tech') || !url.hostname.includes('-api.ai.')
      || typeof apiKey !== 'string' || !/^[!-~]{8,4096}$/.test(apiKey)
      || typeof privateKey !== 'string' || !privateKey.length) invalid();
    const reviewPolicy = config.manifest.reviewPolicy;
    const reviewRequests = reviewPolicy !== undefined;
    if (reviewRequests && (!exact(reviewPolicy, ['version', 'profile']) || reviewPolicy.version !== 1
      || reviewPolicy.profile !== 'worker-command-maintainer-fallback-v1'
      || config.manifest.coordinator?.version !== 1)) invalid();
    const startupPreflight = reviewRequests && config.preflight?.version === 3;
    if (startupPreflight && !validateCoordinatorConfig(config.manifest)) invalid();
    const checks = startupPreflight ? STARTUP_PREFLIGHT_CHECKS
      : reviewRequests ? PREFLIGHT_CHECKS.filter(check => !check.startsWith('qodo_'))
        .concat(['worker_review_command', 'maintainer_exact_head_review']) : PREFLIGHT_CHECKS;
    const preflight = config.preflight;
    const expectedPreflightKeys = ['version', 'planSha256', 'gatewayBindingSha256', 'databaseBindingSha256',
      'checkedAt', 'expiresAt', 'evidenceSha256', 'checks', ...(reviewRequests ? ['reviewProfile'] : []),
      ...(startupPreflight ? ['purpose'] : [])];
    const { preflight: ignored, ...plan } = config;
    const checkedAt = Date.parse(preflight?.checkedAt);
    const expiresAt = Date.parse(preflight?.expiresAt);
    if (!exact(preflight, expectedPreflightKeys)
      || preflight.version !== (startupPreflight ? 3 : reviewRequests ? 2 : 1)
      || reviewRequests && preflight.reviewProfile !== reviewPolicy.profile
      || startupPreflight && preflight.purpose !== STARTUP_PREFLIGHT_PURPOSE
      || preflight.planSha256 !== hash(canonical(plan))
      || preflight.databaseBindingSha256 !== hash(canonical({
        connectionString: env.AGENT_WORKER_DATABASE_URL, role: config.databaseRole,
      }))
      || preflight.gatewayBindingSha256 !== hash(canonical({
        baseURL, tokenSha256: hash(apiKey), model: config.manifest.model,
      })) || !SHA256.test(preflight.evidenceSha256 ?? '')
      || !Number.isFinite(checkedAt) || !Number.isFinite(expiresAt)
      || checkedAt > now + 60_000 || checkedAt < now - 4 * 60 * 60_000
      || expiresAt <= now || expiresAt <= checkedAt || expiresAt > checkedAt + 4 * 60 * 60_000
      || !Array.isArray(preflight.checks) || preflight.checks.length !== checks.length
      || new Set(preflight.checks).size !== checks.length
      || !checks.every(check => preflight.checks.includes(check))) invalid();
    return Object.freeze({ baseURL, apiKey, privateKey, expiresAt });
  } catch { invalid(); }
}
