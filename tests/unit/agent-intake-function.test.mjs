import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { webhookSecret } from '../support/agent-intake-fixtures.mjs';

const source = new URL('../../src/automation/function.mjs', import.meta.url);
const entry = await import(source.href).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === source.href) return {};
  throw error;
});
const env = {
  GITHUB_WEBHOOK_SECRET: webhookSecret,
  GITHUB_READ_TOKEN: 'synthetic-token',
  GITHUB_REPOSITORY_ID: '123',
  GITHUB_REPOSITORY_FULL_NAME: 'randoneering/mellon',
  AGENT_INTAKE_DATABASE_URL: 'postgresql://intake_runtime:synthetic@db.example/test?sslmode=verify-full',
};
function build(options) {
  assert.equal(typeof entry.createFunction, 'function', 'missing configured Neon function entrypoint');
  return entry.createFunction(options);
}

test('entrypoint refuses missing or malformed secrets, identity, and database configuration', () => {
  for (const key of Object.keys(env)) {
    assert.throws(() => build({ env: { ...env, [key]: '' } }), error => {
      assert.match(error.message, /configuration/i);
      assert.doesNotMatch(error.message, /synthetic|postgresql:\/\//);
      return true;
    });
  }
  for (const invalid of [{ GITHUB_REPOSITORY_ID: '1.2' }, { GITHUB_REPOSITORY_ID: '9007199254740992' }, { AGENT_INTAKE_DATABASE_URL: 'https://example.com' }, { GITHUB_REPOSITORY_FULL_NAME: 'other/repo' }]) {
    assert.throws(() => build({ env: { ...env, ...invalid } }), /configuration/i);
  }
});

test('requires explicit verify-full and rejects ambiguous or overriding TLS options before pool creation', () => {
  const base = 'postgresql://intake_runtime:synthetic@db.example/test';
  for (const query of [
    '', '?sslmode=disable', '?sslmode=no-verify', '?sslmode=require', '?sslmode=verify-ca',
    '?sslmode=prefer', '?sslmode=verify-full&sslmode=disable',
    '?sslmode=disable&sslmode=verify-full', '?sslmode=verify-full&sslmode=verify-full',
    '?sslmode=verify-full&ssl=false', '?sslmode=verify-full&ssl=0',
    '?sslmode=verify-full&uselibpqcompat=true', '?sslmode=verify-full&sslrootcert=/private/key',
    '?sslmode=verify-full&sslcert=/private/key', '?sslmode=verify-full&sslkey=/private/key',
    '?sslmode=verify-full&sslnegotiation=direct', '?sslmode=verify-full&SSL=0',
    '?sslmode=verify-full&rejectUnauthorized=false', '?sslmode=verify-full&host=other.example',
  ]) {
    let pools = 0;
    assert.throws(() => build({ env: { ...env, AGENT_INTAKE_DATABASE_URL: base + query }, poolFactory() { pools += 1; throw new Error('pool constructed'); } }), /configuration/i);
    assert.equal(pools, 0);
  }
  for (const query of ['?sslmode=verify-full', '?sslmode=verify-full&channel_binding=require']) {
    const pool = { on() {}, query() {}, connect() {} };
    assert.doesNotThrow(() => build({ env: { ...env, AGENT_INTAKE_DATABASE_URL: base + query }, poolFactory: () => pool }));
  }
});

test('configured entrypoint uses the explicit runtime connection and rejects unsigned HTTP without queries', async () => {
  let options;
  let queries = 0;
  const pool = { on() {}, async query() { queries += 1; throw new Error('unexpected query'); }, async connect() { queries += 1; throw new Error('unexpected connection'); } };
  const fn = build({ env, poolFactory(value) { options = value; return pool; } });
  const response = await fn.fetch(new Request('https://intake.example/github', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }));
  assert.equal(response.status, 401);
  assert.equal(options.connectionString, env.AGENT_INTAKE_DATABASE_URL);
  assert.equal(options.max, 5);
  assert.equal(queries, 0);
});

test('entrypoint logs configuration and unexpected handler failures without printing their messages', async () => {
  assert.equal(typeof entry.createEntrypoint, 'function', 'missing entrypoint failure diagnostics');
  for (const [initialize, category, stage] of [
    [() => build({ env: { ...env, GITHUB_READ_TOKEN: '' } }), 'configuration_invalid', 'configuration'],
    [() => ({ async fetch() { throw new Error('private untrusted URL and token'); } }), 'handler_unavailable', 'handler'],
  ]) {
    const logs = [];
    const fn = entry.createEntrypoint({ initialize, report: line => logs.push(line) });
    const response = await fn.fetch(new Request('https://intake.example/github', { headers: { 'x-github-delivery': 'untrusted' } }));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: 'unavailable' });
    assert.deepEqual(logs.map(line => JSON.parse(line)), [{ category, stage, deliveryId: null }]);
    assert.doesNotMatch(logs.join(''), /private|token|URL|untrusted|synthetic|https?:/);
  }
});

test('Neon config declares only the intake and overrides automatically injected owner database URLs', () => {
  const script = `const {default:c}=await import('./neon.ts'); const f=c.functions.githubintake; console.log(JSON.stringify({auth:c.auth,slugs:Object.keys(c.functions),source:f.source,limited:f.env.DATABASE_URL===process.env.AGENT_INTAKE_DATABASE_URL&&f.env.DATABASE_URL_UNPOOLED===process.env.AGENT_INTAKE_DATABASE_URL,noAdmin:!Object.hasOwn(f.env,'NEON_API_KEY')}));`;
  const result = spawnSync('node', ['--input-type=module', '--eval', script], { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(result.status, 0, 'Neon config must be evaluable with explicit runtime secrets');
  const resultData = JSON.parse(result.stdout.trim());
  assert.equal(resultData.auth, true, 'preserve the existing production Auth service');
  assert.deepEqual(resultData.slugs, ['githubintake']);
  assert.equal(resultData.source, './src/automation/function.mjs');
  assert.equal(resultData.limited, true);
  assert.equal(resultData.noAdmin, true);
});
