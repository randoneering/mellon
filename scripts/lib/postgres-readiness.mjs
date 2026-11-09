export function isPostgresTcpReady(run, container, database) {
  // The image's temporary initialization server listens only on a Unix socket.
  const result = run([
    'exec', container, 'pg_isready', '--host', '127.0.0.1',
    '--username', 'postgres', '--dbname', database,
  ]);
  return result?.status === 0;
}
