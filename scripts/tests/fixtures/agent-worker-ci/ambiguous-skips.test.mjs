import test from 'node:test';

for (let index = 0; index < 2; index += 1) {
  test.skip('same source coordinate and name must not authorize two skips', () => {});
}
