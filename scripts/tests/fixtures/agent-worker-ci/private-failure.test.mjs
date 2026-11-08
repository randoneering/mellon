import assert from 'node:assert/strict';
import test from 'node:test';

test('SYNTHETIC_PRIVATE_TEST_NAME', () => {
  process.stdout.write('::error::SYNTHETIC_PRIVATE_STDOUT\n');
  process.stderr.write('SYNTHETIC_PRIVATE_STDERR\u001b[31m\n');
  assert.fail('SYNTHETIC_PRIVATE_ASSERTION');
});
