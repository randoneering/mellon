import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateAuthorizationUrl, validateRedirectUrl, waitForRedirect } from '../../internal/factory-worker/auth-session.mjs';

const AUTH = 'https://auth.openai.com/oauth/authorize?state=expected-state-0123456789&code_challenge=challenge&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback';
const REDIRECT = 'http://localhost:1455/auth/callback?code=private-code-canary&state=expected-state-0123456789';

test('accepts only the SDK provider authorization URL and exact matching full callback', () => {
  assert.equal(validateAuthorizationUrl(AUTH), AUTH);
  assert.equal(validateRedirectUrl(REDIRECT, AUTH), REDIRECT);
});

for (const input of [
  'private-code-canary',
  REDIRECT.replace('expected-state-0123456789', 'wrong-state'),
  REDIRECT.replace('localhost:1455', 'attacker.example'),
  REDIRECT.replace('/auth/callback', '/other'),
  REDIRECT.replace('http:', 'https:'),
  REDIRECT.replace('code=private-code-canary&', ''),
  REDIRECT + '&state=expected-state-0123456789',
  REDIRECT + '&code=second-code',
  REDIRECT + '&error=denied',
  REDIRECT + '#private-fragment',
  REDIRECT.replace('localhost:1455', 'user@localhost:1455'),
]) {
  test('rejects mismatched or ambiguous redirect without exposing its contents', () => {
    assert.throws(() => validateRedirectUrl(input, AUTH), error => {
      assert.equal(error.message, 'Worker authorization input rejected.');
      return true;
    });
  });
}

test('an out-of-scope session directory cannot receive result files', () => {
  const root = mkdtempSync(join(tmpdir(), 'mellon-auth-boundary-test-'));
  const outside = join(root, 'mellon-factory-auth-012345abcdef');
  mkdirSync(outside);
  const r = spawnSync(process.execPath, ['internal/factory-worker/auth-session.mjs', '/missing-sdk', outside], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(existsSync(join(outside, 'result.json')), false);
});

test('global login abort settles manual input even when the SDK prompt signal stays live', async () => {
  const global = new AbortController();
  const prompt = new AbortController();
  let pending;
  const waiting = waitForRedirect(global.signal, prompt.signal, value => { pending = value; });
  assert.equal(typeof pending.resolve, 'function');
  global.abort();
  await assert.rejects(waiting, /Worker authorization input cancelled/);
  assert.equal(prompt.signal.aborted, false);
  assert.equal(pending, undefined);
});

test('redirect resolution detaches cancellation listeners and clears the pending input', async () => {
  const global = new AbortController();
  let pending;
  const waiting = waitForRedirect(global.signal, undefined, value => { pending = value; });
  pending.resolve(REDIRECT);
  assert.equal(await waiting, REDIRECT);
  assert.equal(pending, undefined);
  global.abort();
});

for (const input of [
  AUTH.replace('auth.openai.com', 'attacker.example'),
  AUTH.replace('https:', 'http:'),
  AUTH.replace('expected-state-0123456789', ''),
  AUTH.replace('code_challenge_method=S256', 'code_challenge_method=plain'),
  AUTH.replace('/oauth/authorize', '/other'),
]) {
  test('rejects an unexpected authorization destination or missing PKCE state', () => {
    assert.throws(() => validateAuthorizationUrl(input), /Worker authorization input rejected/);
  });
}

test('an unexpected sibling pi-ai version is rejected before login setup', () => {
  const root = mkdtempSync(join(tmpdir(), 'mellon-auth-sdk-test-'));
  const coding = join(root, 'pi-coding-agent');
  mkdirSync(coding);
  mkdirSync(join(root, 'pi-ai'));
  writeFileSync(join(coding, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.5.2' }));
  writeFileSync(join(root, 'pi-ai/package.json'), JSON.stringify({ name: '@earendil-works/pi-ai', version: '1.5.3' }));
  const session = join(tmpdir(), 'mellon-factory-auth-' + randomBytes(6).toString('hex'));
  const run = spawnSync(process.execPath, ['internal/factory-worker/auth-session.mjs', coding, session], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.equal(JSON.parse(run.stdout).stage, 'session_setup');
  assert.equal(existsSync(session), false);
});
