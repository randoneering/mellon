const mode = process.argv[2];

if (mode === 'streams') {
  process.stdout.write('::err');
  await new Promise(resolve => setImmediate(resolve));
  process.stdout.write('or::stdout\r\n##[error]legacy-stdout\n');
  process.stdout.write(Buffer.from([0xe2]));
  await new Promise(resolve => setImmediate(resolve));
  process.stdout.write(Buffer.from([0x82, 0xac]));
  process.stderr.write('prefix ##');
  await new Promise(resolve => setImmediate(resolve));
  process.stderr.write('[warning]legacy-stderr\r::error::after-cr\u001b[31mANSI\n');
} else if (mode === 'exit') {
  process.stdout.write('::error::nonzero\n');
  process.stderr.write('##[error]nonzero\n');
  process.exitCode = 23;
} else if (mode === 'overflow') {
  process.stdout.write('::error::before-overflow\n');
  process.stderr.write('##[error]before-overflow\n');
  process.stdout.write(Buffer.alloc(300 * 1024, 0x41));
  process.stderr.write(Buffer.alloc(300 * 1024, 0x42));
} else if (mode === 'timeout') {
  process.on('SIGTERM', () => {});
  process.stdout.write('::error::before-timeout\n');
  setInterval(() => {}, 1000);
} else if (mode === 'invalid-utf8') {
  process.stdout.write(Buffer.from([0xff, 0x3a, 0x3a]));
  process.stderr.write(Buffer.from([0xff, 0x23, 0x23, 0x5b]));
} else {
  process.stderr.write('Unknown fixed probe.\n');
  process.exitCode = 1;
}
