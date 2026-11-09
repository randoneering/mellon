import test from 'node:test';

test('child stdout command spoofing', async () => {
  process.stdout.write('::err');
  await new Promise(resolve => setImmediate(resolve));
  process.stdout.write('or::forged\r\n::notice::forged\n##[error]legacy');
  process.stderr.write('before ##');
  await new Promise(resolve => setImmediate(resolve));
  process.stderr.write('[warning]legacy\r::error::after-cr\n');
  process.stdout.write(Buffer.from([0xe2]));
  await new Promise(resolve => setImmediate(resolve));
  process.stdout.write(Buffer.from([0x82, 0xac]));
  process.stderr.write(' terminal\u001b[31msequence\n');
});
