import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, verify } from 'node:crypto';
import test from 'node:test';
import { createGitHubAppBroker } from '../../src/automation/worker/github-app.mjs';
import { validatePublicationContext, validatePullRequestContext } from '../../src/automation/worker/publication-validation.mjs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const config = { appId: 123, installationId: 456, repositoryId: 789,
  repositoryName: 'randoneering/mellon', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  actor: { databaseId: 42, login: 'mellon[bot]' }, preflightCommitSha: 'a'.repeat(40) };
const now = () => Date.now();
function response(data, status = 200) { return new Response(JSON.stringify(data), { status }); }
function fixture() {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url: String(url), ...options });
    const path = new URL(url).pathname;
    if (path === '/app') return response({ id: 123, slug: 'mellon' });
    if (path === '/app/installations/456') return response({ id: 456, app_id: 123, repository_selection: 'selected', suspended_at: null, permissions: { metadata: 'read', contents: 'write', issues: 'read', pull_requests: 'write', actions: 'read', checks: 'read' }, repositories_url: 'https://api.github.com/installation/repositories' });
    if (path === '/installation/repositories') return response({ total_count: 1, repositories: [{ id: 789, full_name: 'randoneering/mellon' }] });
    if (path === '/app/installations/456/access_tokens') return response({ token: 'ghs_test', expires_at: new Date(Date.now() + 60 * 60_000).toISOString(), permissions: JSON.parse(options.body).permissions, repository_selection: 'selected', repositories: [{ id: 789, name: 'mellon', full_name: 'randoneering/mellon' }] });
    if (path === '/repositories/789') return response({ id: 789, full_name: 'randoneering/mellon' });
    if (path === '/users/mellon%5Bbot%5D') return response({ id: 42, login: 'mellon[bot]', type: 'Bot' });
    if (path === '/graphql') return response({ data: { repository: { databaseId: 789, nameWithOwner: 'randoneering/mellon', object: { oid: 'a'.repeat(40), tree: { oid: 'b'.repeat(40) }, parents: { nodes: ['c'.repeat(40)].map(oid => ({ oid })) }, author: { user: { databaseId: 42, login: 'mellon[bot]' } }, committer: { name: 'GitHub', email: 'noreply@github.com', user: null }, signature: { isValid: true, state: 'VALID', wasSignedByGitHub: true } } } } });
    throw new Error('unexpected');
  };
  return { calls, fetch, broker: createGitHubAppBroker(config, { fetch, now }) };
}
const run = { repositoryId: 789 };
test('creates and verifies RS256 app JWT claims and exact scoped tokens', async () => {
  const f = fixture();
  const token = await f.broker.getReadToken();
  assert.equal(token, 'ghs_test');
  const jwt = f.calls.find(c => c.url.endsWith('/app')).headers.authorization.slice(7);
  const [h, p, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(claims.iss, '123');
  assert.equal(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey(config.privateKey), Buffer.from(sig, 'base64url')), true);
  const tokenRequest = f.calls.find(c => c.url.endsWith('/access_tokens'));
  assert.deepEqual(JSON.parse(tokenRequest.body), { repository_ids: [789], permissions: { actions: 'read', checks: 'read', contents: 'read', issues: 'read', metadata: 'read', pull_requests: 'read' } });
});
test('returns publication and pull request contexts accepted by existing validators', async () => {
  const f = fixture();
  const context = await f.broker.getPublicationContext({ repositoryId: 789, repositoryName: 'randoneering/mellon', runId: '00000000-0000-0000-0000-000000000000', branch: 'agent-work/00000000-0000-0000-0000-000000000000' });
  assert.equal(validatePublicationContext(context, run, now()).repositoryId, 789);
  const pr = await f.broker.getPullRequestContext({ repositoryId: 789, repositoryName: 'randoneering/mellon', runId: '00000000-0000-0000-0000-000000000000', branch: 'agent-work/00000000-0000-0000-0000-000000000000' });
  assert.equal(validatePullRequestContext(pr, run).repositoryId, 789);
});
test('fails closed on wrong configured repository and never leaks credential material', async () => {
  const f = fixture();
  const broker = createGitHubAppBroker({ ...config, repositoryId: 999 }, { fetch: f.fetch, now });
  await assert.rejects(broker.getReadToken(), error => !error.message.includes('ghs_test') && !error.message.includes(config.privateKey));
});
