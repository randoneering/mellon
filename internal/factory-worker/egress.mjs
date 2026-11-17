import { lookup } from 'node:dns/promises';
import { createServer } from 'node:http';
import { connect, isIP } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Model endpoints are reachable only through the credential relay, never directly.
const HOSTS = new Set([
  'pi.dev', 'models.pi.dev',
  'github.com', 'api.github.com', 'codeload.github.com',
  'objects.githubusercontent.com', 'raw.githubusercontent.com',
]);
const ERROR = 'Factory egress destination rejected.';

export function checkedAuthority(input) {
  if (typeof input !== 'string' || !/^[a-zA-Z0-9.-]+:443$/.test(input)) throw new Error(ERROR);
  const host = input.slice(0, -4).toLowerCase();
  if (!HOSTS.has(host)) throw new Error(ERROR);
  return host;
}

export function checkedPublicAddress(input) {
  if (typeof input !== 'string' || isIP(input) !== 4) throw new Error(ERROR);
  const [a, b, c] = input.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || b === 0))
      || (a === 198 && ((b >= 18 && b <= 19) || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113)) throw new Error(ERROR);
  return input;
}

export function startEgress(options = {}) {
  const lookupHost = options.lookup ?? lookup;
  const connectHost = options.connect ?? connect;
  let active = 0;
  const server = createServer({ maxHeaderSize: 8192 }, (_request, response) => {
    response.writeHead(403, { 'content-type': 'text/plain' });
    response.end('Factory egress denied.');
  });
  server.maxConnections = 32;
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connect', async (request, client, head) => {
    // Preserve pipelined TLS bytes until the upstream pipe can consume them.
    client.pause();
    if (active >= 16) { client.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return; }
    active++;
    let upstream;
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      active--;
      client.destroy();
      upstream?.destroy();
    };
    client.once('close', finish);
    client.once('error', finish);
    client.setTimeout(120000, finish);
    try {
      const host = checkedAuthority(request.url);
      const addresses = await lookupHost(host, { all: true, family: 4 });
      if (!addresses.length) throw new Error(ERROR);
      for (const result of addresses) checkedPublicAddress(result.address);
      if (closed) return;
      upstream = connectHost({ host: addresses[0].address, port: 443 });
      upstream.setTimeout(120000, finish);
      upstream.once('error', finish);
      upstream.once('close', finish);
      let bytes = head.length;
      const bound = data => { bytes += data.length; if (bytes > 64 * 1024 * 1024) finish(); };
      client.on('data', bound);
      upstream.on('data', bound);
      upstream.once('connect', () => {
        if (closed) return;
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
    } catch {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      finish();
    }
  });
  if (options.listen !== false) server.listen(8788, '0.0.0.0');
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startEgress();
}
