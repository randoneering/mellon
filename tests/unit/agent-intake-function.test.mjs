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
  AGENT_INTAKE_DATABASE_URL: 'postgresql://intake_runtime:synthetic@127.0.0.1/test',
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
