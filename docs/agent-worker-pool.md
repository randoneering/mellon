# Restricted worker database pool

`createWorkerDatabase({ env, databaseRole, report }, dependencies)` returns `{ pool, verifyRole, close }`.
Its defaults use the installed `pg.Pool` and Neon `attachDatabasePool`.
Constructing it opens no database connection.
The [default runtime](agent-worker-runtime.md) constructs it only after authenticated delivery, enablement and private configuration checks.

## Connection boundaries

- Use only `AGENT_WORKER_DATABASE_URL`, never owner, intake, or unpooled fallbacks.
- Require the approved role, a nonempty password, and `sslmode=verify-full`.
- Reject URI parameters that override user, password, host, database, port, options or service.
- Pass explicit host, port, user, password and database fields to pg rather than forwarding its URL parser or ambient authority settings.
- Enable TLS certificate verification and channel binding.
- Limit the pool to two clients, connection/query/statement waits to five seconds, and lock waits to two seconds.
- Supply a fixed, exception-safe Neon error reporter so the SDK cannot print raw database errors.

## Role attestation

`verifyRole({ signal, deadline, limits })` runs one read-only catalog query before model work.
When supplied, the reviewed limits must also satisfy the actual migrated `agent_worker.valid_limits` function.
It requires the configured current/session role and a verified client TLS socket.
The socket must be encrypted, certificate-authorized and on TLS 1.2 or 1.3.
For DNS hosts, its TLS server name must match the configured host.
IP hosts send no server name, so they rely on pg's certificate IP check.
Neon's backend `pg_stat_ssl` view can report `false` for the internal proxy hop, so attestation does not use it.
It rejects superuser, RLS bypass, role/database creation, replication, inheritance, role membership, database ownership, application-object ownership and schema creation.
It verifies the required schema/table/sequence grants and rejects extra table grants within `agent_intake` and `agent_worker`.
Worker tables require the migration-defined read/insert/update subsets; intake jobs remain read-only.
This query does not audit unrelated schemas or replace the separately approved production grant review.

The verifier bounds local waits even when a driver ignores cancellation.
It discards uncertain clients and releases late acquisitions.
It does not claim that SQL accepted remotely is cancelled.
`close()` bounds the pool shutdown wait.

## Evidence

Unit tests construct an actual pg pool without connecting and use controlled driver receipts for role/grant/deadline cases.
They also execute the installed Neon pool error handler.
`npm run test:worker:runtime:db` passes eight actual PostgreSQL cases plus three fresh-database marker guards.
They execute the catalog SQL, safe/unsafe grants and roles, the 65,536 ceiling, duplicate prevention and two nonrefunded initial reservations.
The local test adapter uses plaintext deliberately: production attestation rejects its non-TLS socket.
Live Neon TLS/grants and service isolation remain gated; these local results do not replace that preflight.
