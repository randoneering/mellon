// Pool clients receive only the dedicated worker URL, never an owner/intake fallback.
export function workerRuntimeEnvironment(env, databaseRole) {
  const databaseUrl = env.AGENT_WORKER_DATABASE_URL;
  try {
    if (typeof databaseUrl !== 'string' || !databaseUrl.trim()
      || typeof databaseRole !== 'string'
      || !/^[a-z_][a-z0-9_]{0,62}$/.test(databaseRole)) throw new Error();
    const url = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname
      || !url.username || decodeURIComponent(url.username) !== databaseRole
      || url.pathname.length < 2 || url.hash
      || url.searchParams.getAll('sslmode').length !== 1
      || url.searchParams.get('sslmode') !== 'verify-full') throw new Error();
    for (const name of url.searchParams.keys()) {
      if ((/ssl|tls|rejectunauthorized|checkserveridentity/i.test(name) && name !== 'sslmode')
        || /^(?:uselibpqcompat|user|password|database|dbname|port|options|service|connectionstring|connection_string|host|hostaddr|servername)$/i.test(name)) {
        throw new Error();
      }
    }
    if (env.AGENT_INTAKE_DATABASE_URL
      && decodeURIComponent(new URL(env.AGENT_INTAKE_DATABASE_URL).username) === databaseRole) throw new Error();
  } catch { throw new Error('Worker configuration is invalid.'); }
  return Object.freeze({
    AGENT_WORKER_DATABASE_URL: databaseUrl,
    DATABASE_URL: databaseUrl,
    DATABASE_URL_UNPOOLED: databaseUrl,
  });
}
