import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import tls from 'node:tls';
import pg from 'pg';
import { workerRuntimeEnvironment } from '../../src/automation/worker/function.mjs';

const ROLE = 'mellon_agent_worker';
const URL = 'postgresql://mellon_agent_worker:worker-password@db.example/neondb?sslmode=verify-full';
const validRole = {
  role_name: ROLE, session_role: ROLE, ssl: true,
  rolsuper: false, rolbypassrls: false, rolcreatedb: false,
  rolcreaterole: false, rolreplication: false, rolinherit: false,
  has_memberships: false, owns_database: false, owns_app_objects: false,
  database_create: false, schema_create: false, grants_ok: true,
};

function tlsStream(overrides = {}) {
  return Object.setPrototypeOf({
    encrypted: true, authorized: true, servername: 'db.example',
    getProtocol() { return 'TLSv1.3'; }, ...overrides,
  }, tls.TLSSocket.prototype);
}

async function loadFactory() {
  const module = await import('../../src/automation/worker/pool.mjs').catch(() => ({}));
  assert.equal(typeof module.createWorkerDatabase, 'function',
    'A real restricted-pool factory must be available.');
  return module.createWorkerDatabase;
}

function fixture({ row = validRole, connect, query, report, stream = tlsStream() } = {}) {
  const released = [];
  const queries = [];
  let constructed;
  class Pool extends EventEmitter {
    constructor(options) { super(); this.options = options; constructed = this; }
    async connect() {
      if (connect) return connect();
      return {
        connection: { stream },
        async query(input) {
          queries.push(input);
          if (query) return query(input);
          return { rows: [{ ...row }] };
        },
        release(discard) { released.push(discard); },
      };
    }
    async end() {}
  }
  return { Pool, released, queries, report, pool: () => constructed };
}

for (const parameter of ['user=owner', 'password=owner-secret', 'options=-c%20role%3Downer',
  'database=other', 'port=9999', 'service=owner']) {
  test(`worker URL rejects pg override ${parameter.split('=')[0]}`, () => {
    assert.throws(() => workerRuntimeEnvironment({
      AGENT_WORKER_DATABASE_URL: `${URL}&${parameter}`,
    }, ROLE), { message: 'Worker configuration is invalid.' });
  });
}

test('factory creates a real pg Pool with explicit worker-only credentials and TLS', async () => {
  const create = await loadFactory();
  const database = create({ env: {
    AGENT_WORKER_DATABASE_URL: URL,
    DATABASE_URL: 'postgresql://owner:owner-secret@owner.example/other',
  }, databaseRole: ROLE });
  try {
    assert.ok(database.pool instanceof pg.Pool);
    assert.equal(database.pool.totalCount, 0);
    assert.equal(database.pool.options.user, ROLE);
    assert.equal(database.pool.options.host, 'db.example');
    assert.equal(database.pool.options.database, 'neondb');
    assert.equal(database.pool.options.password, 'worker-password');
    assert.equal(database.pool.options.connectionString, undefined);
    assert.equal(database.pool.options.ssl.rejectUnauthorized, true);
    assert.equal(database.pool.options.max, 2);
    assert.equal(database.pool.options.query_timeout, 5000);
    assert.ok(database.pool.options.options.includes('statement_timeout=5000'));
  } finally { await database.close(); }
});

test('pool refuses missing worker credentials instead of an owner fallback', async () => {
  const create = await loadFactory();
  assert.throws(() => create({ env: { DATABASE_URL: URL }, databaseRole: ROLE }),
    { message: 'Worker database configuration is invalid.' });
  assert.throws(() => create({ env: {
    AGENT_WORKER_DATABASE_URL: 'postgresql://mellon_agent_worker@db.example/neondb?sslmode=verify-full',
  }, databaseRole: ROLE }), { message: 'Worker database configuration is invalid.' });
});

test('role attestation requires the complete restricted-role receipt', async () => {
  const create = await loadFactory();
  const f = fixture();
  const database = create({ env: { AGENT_WORKER_DATABASE_URL: URL }, databaseRole: ROLE }, f);
  assert.equal(await database.verifyRole(), true);
  assert.deepEqual(f.released, [false]);
  assert.equal(f.queries.length, 1);
  assert.ok(f.queries[0].query_timeout <= 5000);
});

test('role attestation accepts verified client TLS when the backend view reports a proxied hop', async () => {
  const create = await loadFactory();
  const f = fixture({ row: { ...validRole, ssl: false } });
  const database = create({ env: { AGENT_WORKER_DATABASE_URL: URL }, databaseRole: ROLE }, f);
  assert.equal(await database.verifyRole(), true);
  assert.deepEqual(f.released, [false]);
});

// Names stay free of '::' because the CI reporter rejects workflow-command markers.
for (const [family, host] of [['IPv4', '203.0.113.10'], ['IPv6', '[2001:db8::10]']]) {
  test(`role attestation accepts verified TLS to an ${family} host`, async () => {
    const create = await loadFactory();
    const url = `postgresql://${ROLE}:worker-password@${host}/neondb?sslmode=verify-full`;
    const f = fixture({ stream: tlsStream({ servername: undefined }) });
    const database = create({ env: { AGENT_WORKER_DATABASE_URL: url }, databaseRole: ROLE }, f);
    assert.equal(await database.verifyRole(), true);
  });
}

test('role attestation rejects unauthorized TLS to an IP host', async () => {
  const create = await loadFactory();
  const url = `postgresql://${ROLE}:worker-password@203.0.113.10/neondb?sslmode=verify-full`;
  const f = fixture({ stream: tlsStream({ servername: undefined, authorized: false }) });
  const database = create({ env: { AGENT_WORKER_DATABASE_URL: url }, databaseRole: ROLE }, f);
  await assert.rejects(database.verifyRole(), { message: 'Worker database role could not be verified.' });
});

test('role attestation rejects mismatched TLS server name for an IP host', async () => {
  const create = await loadFactory();
  const url = `postgresql://${ROLE}:worker-password@203.0.113.10/neondb?sslmode=verify-full`;
  const f = fixture({ stream: tlsStream({ servername: 'db.example' }) });
  const database = create({ env: { AGENT_WORKER_DATABASE_URL: url }, databaseRole: ROLE }, f);
  await assert.rejects(database.verifyRole(), { message: 'Worker database role could not be verified.' });
});

for (const [name, stream] of [
  ['a missing socket', null],
  ['a plaintext socket', new EventEmitter()],
  ['a non-TLS socket shaped like TLS', { encrypted: true, authorized: true,
    servername: 'db.example', getProtocol() { return 'TLSv1.3'; } }],
  ['an unencrypted TLS socket', tlsStream({ encrypted: false })],
  ['an unauthorized certificate', tlsStream({ authorized: false })],
  ['a mismatched server name', tlsStream({ servername: 'other.example' })],
  ['a missing server name', tlsStream({ servername: undefined })],
  ['an old TLS protocol', tlsStream({ getProtocol() { return 'TLSv1.1'; } })],
  ['an unknown TLS protocol', tlsStream({ getProtocol() { return null; } })],
  ['a throwing protocol reader', tlsStream({ getProtocol() { throw new Error('private'); } })],
]) {
  test(`role attestation rejects ${name} even with a backend TLS receipt`, async () => {
    const create = await loadFactory();
    const f = fixture({ stream });
    const database = create({ env: { AGENT_WORKER_DATABASE_URL: URL }, databaseRole: ROLE }, f);
    await assert.rejects(database.verifyRole(), { message: 'Worker database role could not be verified.' });
    assert.deepEqual(f.released, [true]);
  });
}

for (const [field, bad] of [
  ['role_name', 'owner'], ['session_role', 'owner'],
  ['rolsuper', true], ['rolbypassrls', true], ['rolcreatedb', true],
  ['rolcreaterole', true], ['rolreplication', true], ['rolinherit', true],
  ['has_memberships', true], ['owns_database', true], ['owns_app_objects', true],
  ['database_create', true], ['schema_create', true], ['grants_ok', false],
]) {
  test(`role attestation rejects unsafe ${field}`, async () => {
    const create = await loadFactory();
    const f = fixture({ row: { ...validRole, [field]: bad } });
    const database = create({ env: { AGENT_WORKER_DATABASE_URL: URL }, databaseRole: ROLE }, f);
    await assert.rejects(database.verifyRole(), { message: 'Worker database role could not be verified.' });
    assert.deepEqual(f.released, [true]);
  });
}

test('role attestation rejects incomplete database evidence', async () => {
  const create = await loadFactory();
  const f = fixture({ row: {} });
  const database = create({ env: { AGENT_WORKER_DATABASE_URL: URL }, databaseRole: ROLE }, f);
  await assert.rejects(database.verifyRole(), { message: 'Worker database role could not be verified.' });
});

test('role attestation releases a late connection after its deadline', async () => {
  const create = await loadFactory();
  let deliver;
  const released = [];
  const f = fixture({ connect: () => new Promise(resolve => { deliver = resolve; }) });
  const database = create({ env: { AGENT_WORKER_DATABASE_URL: URL }, databaseRole: ROLE }, f);
  await assert.rejects(database.verifyRole({ deadline: Date.now() + 30 }),
    { message: 'Worker database role could not be verified.' });
  deliver({ release(discard) { released.push(discard); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(released, [true]);
});

test('caller abort stops a role query and discards its connection', async () => {
  const create = await loadFactory();
  const controller = new AbortController();
  const f = fixture({ query: () => { controller.abort(); return new Promise(() => {}); } });
  const database = create({ env: { AGENT_WORKER_DATABASE_URL: URL }, databaseRole: ROLE }, f);
  await assert.rejects(database.verifyRole({ signal: controller.signal, deadline: Date.now() + 50 }),
    { message: 'Worker database role could not be verified.' });
  assert.deepEqual(f.released, [true]);
});

test('pool diagnostic promises cannot leak rejected private failures', async () => {
  const create = await loadFactory();
  let observed = false;
  const f = fixture();
  const database = create({ env: { AGENT_WORKER_DATABASE_URL: URL }, databaseRole: ROLE,
    report: () => ({ then(_resolve, reject) {
      observed = true;
      reject(new Error('private asynchronous reporter failure'));
    } }) }, f);
  database.pool.emit('error', new Error('private database failure'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observed, true);
});

test('pool errors use fixed diagnostics even when the reporter throws', async () => {
  const create = await loadFactory();
  const output = [];
  const f = fixture();
  const database = create({ env: { AGENT_WORKER_DATABASE_URL: URL }, databaseRole: ROLE,
    report: message => { output.push(message); throw new Error('private-report-error'); } }, f);
  database.pool.emit('error', new Error('private-database-secret'));
  assert.deepEqual(output, ['[agent_worker] database_pool_unavailable']);
});
