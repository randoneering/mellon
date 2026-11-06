import pg from 'pg';
import { attachDatabasePool } from '@neon/functions';
import { createGitHubReader } from './github.mjs';
import { createIntake } from './intake.mjs';
import { createStore } from './store.mjs';
import { positiveId } from './http.mjs';
import { ConfigurationError, reportFailure } from './diagnostics.mjs';

function configuration(env) {
  const required = ['GITHUB_WEBHOOK_SECRET', 'GITHUB_READ_TOKEN', 'GITHUB_REPOSITORY_ID', 'GITHUB_REPOSITORY_FULL_NAME', 'AGENT_INTAKE_DATABASE_URL'];
  if (required.some(key => typeof env[key] !== 'string' || !env[key].trim()) ||
      !/^[1-9]\d*$/.test(env.GITHUB_REPOSITORY_ID) || !positiveId(Number(env.GITHUB_REPOSITORY_ID)) ||
      env.GITHUB_REPOSITORY_FULL_NAME.toLowerCase() !== 'randoneering/mellon') {
    throw new ConfigurationError();
  }
  try {
    const url = new URL(env.AGENT_INTAKE_DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || url.pathname.length < 2 ||
        url.searchParams.getAll('sslmode').length !== 1 || url.searchParams.get('sslmode') !== 'verify-full') throw new Error();
    for (const name of url.searchParams.keys()) {
      if ((/ssl|tls|rejectunauthorized|checkserveridentity/i.test(name) && name !== 'sslmode') ||
          /^(?:uselibpqcompat|host|hostaddr|servername)$/i.test(name)) throw new Error();
    }
  } catch { throw new ConfigurationError(); }
  return {
    secret: env.GITHUB_WEBHOOK_SECRET,
    token: env.GITHUB_READ_TOKEN,
    repository: { id: Number(env.GITHUB_REPOSITORY_ID), fullName: env.GITHUB_REPOSITORY_FULL_NAME },
    databaseUrl: env.AGENT_INTAKE_DATABASE_URL,
  };
}

export function createFunction({ env = process.env, poolFactory = options => new pg.Pool(options), fetchImpl = fetch, report = line => console.error(line) } = {}) {
  const config = configuration(env);
  const pool = poolFactory({
    connectionString: config.databaseUrl, max: 5,
    connectionTimeoutMillis: 10000, statement_timeout: 10000, query_timeout: 10000,
  });
  attachDatabasePool(pool, { onUnexpectedError: () => reportFailure(report, 'persistence_unavailable', 'pool') });
  const handle = createIntake({
    secret: config.secret, repository: config.repository, report,
    github: createGitHubReader({ token: config.token, repository: config.repository, fetchImpl }),
    store: createStore(pool),
  });
  return { fetch: handle };
}

export function createEntrypoint({ initialize = createFunction, report = line => console.error(line) } = {}) {
  let deployedFunction;
  return {
    async fetch(request) {
      let stage = 'initialization';
      try {
        deployedFunction ??= initialize();
        stage = 'handler';
        return await deployedFunction.fetch(request);
      } catch (error) {
        const invalid = error instanceof ConfigurationError;
        reportFailure(report, invalid ? 'configuration_invalid' : 'handler_unavailable', invalid ? 'configuration' : stage);
        return Response.json({ status: 'unavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } });
      }
    },
  };
}

export default createEntrypoint();
