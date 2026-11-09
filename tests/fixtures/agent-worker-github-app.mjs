import { generateKeyPairSync } from 'node:crypto';
import { createGitHubAppBroker } from '../../src/automation/worker/github-app.mjs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
export const BROKER_REQUEST = Object.freeze({
  repositoryId: 789,
  repositoryName: 'randoneering/mellon',
  runId: '00000000-0000-0000-0000-000000000000',
  branch: 'agent-work/00000000-0000-0000-0000-000000000000',
});

export function brokerFixture({ mutate, transport, repositoryId = 789 } = {}) {
  const calls = [];
  const issued = [];
  let time = Date.now();
  const config = {
    appId: 123, installationId: 456, repositoryId,
    repositoryName: 'randoneering/mellon', privateKey: pem,
    actor: { databaseId: 42, login: 'mellon[bot]' },
    preflightCommitSha: 'a'.repeat(40),
  };
  const repo = { id: repositoryId, name: 'mellon', full_name: 'randoneering/mellon' };
  const fetch = async (url, options) => {
    const path = decodeURIComponent(new URL(url).pathname);
    const call = { path, url: String(url), ...options };
    calls.push(call);
    if (transport) {
      const result = await transport(call);
      if (result !== undefined) return result;
    }
    let data;
    if (path === '/app') data = { id: 123, slug: 'mellon' };
    else if (path === '/app/installations/456') data = {
      id: 456, app_id: 123, app_slug: 'mellon',
      repository_selection: 'selected', suspended_at: null,
      permissions: { metadata: 'read', contents: 'write', issues: 'read',
        pull_requests: 'write', actions: 'read', checks: 'read' },
    };
    else if (path === '/app/installations/456/access_tokens') {
      data = {
        token: `ghs_test_${issued.length + 1}`,
        expires_at: new Date(time + 60 * 60_000).toISOString(),
        permissions: JSON.parse(options.body).permissions,
        repository_selection: 'selected', repositories: [{ ...repo }],
      };
    } else if (path === '/installation/repositories') {
      data = { total_count: 1, repositories: [{ ...repo }] };
    } else if (path === `/repositories/${repositoryId}`) data = { ...repo };
    else if (path === '/users/mellon[bot]') {
      data = { id: 42, login: 'mellon[bot]', type: 'Bot' };
    } else if (path === '/user') {
      return new Response(JSON.stringify({ message: 'Resource not accessible by integration' }),
        { status: 403 });
    } else if (path === '/graphql') {
      data = { data: { repository: {
        databaseId: repositoryId, nameWithOwner: 'randoneering/mellon', object: {
          oid: 'a'.repeat(40), tree: { oid: 'b'.repeat(40) },
          parents: { nodes: [{ oid: 'c'.repeat(40) }] },
          author: { user: { databaseId: 42, login: 'mellon[bot]' } },
          committer: { user: { databaseId: 42, login: 'mellon[bot]' } },
          signature: { isValid: true, state: 'VALID', wasSignedByGitHub: true },
        },
      } } };
    } else throw new Error('Unsupported fixture route.');
    if (mutate) data = await mutate({ ...call, data });
    if (path.endsWith('/access_tokens')) issued.push(structuredClone(data));
    return new Response(JSON.stringify(data), {
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    config, calls, issued, fetch,
    now: () => time,
    advance: ms => { time += ms; },
    create: () => createGitHubAppBroker(config, { fetch, now: () => time }),
  };
}
