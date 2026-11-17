import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startEgress } from '../../internal/factory-worker/egress.mjs';
import { checkedAuthority, checkedPublicAddress } from '../../internal/factory-worker/egress.mjs';

for (const value of ['pi.dev:443', 'github.com:443', 'api.github.com:443']) {
  test('permits an exact required TLS destination', () => {
    assert.equal(checkedAuthority(value), value.split(':')[0]);
  });
}
for (const value of ['chatgpt.com:443', 'auth.openai.com:443', 'example.com:443', 'github.com:80', 'chatgpt.com:80', 'chatgpt.com:0443', 'user@chatgpt.com:443', 'chatgpt.com.attacker.example:443', 'chatgpt.com.:443', '127.0.0.1:443', '[::1]:443', 'chatgpt.com:443\r\nX: injected']) {
  test('rejects unapproved proxy authority without echoing it', () => {
    assert.throws(() => checkedAuthority(value), error => {
      assert.equal(error.message, 'Factory egress destination rejected.');
      return true;
    });
  });
}
for (const ip of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.1.1', '172.31.255.1', '192.168.1.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::1', '::ffff:127.0.0.1']) {
  test('rejects private, special-use or non-IPv4 upstream resolution', () => {
    assert.throws(() => checkedPublicAddress(ip), /Factory egress destination rejected/);
  });
}
test('CONNECT preserves bytes arriving while upstream connection is delayed', async () => {
  let received = '';
  const upstream = net.createServer(socket => socket.on('data', data => { received += data.toString(); }));
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = startEgress({ listen: false,
    lookup: async () => { await new Promise(resolve => setTimeout(resolve, 20)); return [{ address: '1.1.1.1' }]; },
    connect: () => { const s = new net.Socket(); setTimeout(() => s.connect(upstream.address().port, '127.0.0.1'), 40); return s; },
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const client = net.connect(proxy.address().port, '127.0.0.1');
  client.on('data', () => {});
  try {
    await new Promise(resolve => client.once('connect', resolve));
    client.write('CONNECT github.com:443 HTTP/1.1\r\nHost: github.com\r\n\r\n');
    await new Promise(resolve => setTimeout(resolve, 30));
    client.write('EARLY-TLS-BYTES');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(received, 'EARLY-TLS-BYTES');
  } finally {
    client.destroy();
    await new Promise(resolve => setTimeout(resolve, 10));
    await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  }
});

for (const ip of ['104.18.32.7', '140.82.112.3', '1.1.1.1']) {
  test('accepts only a checked public IPv4 address for the approved host', () => {
    assert.equal(checkedPublicAddress(ip), ip);
  });
}
