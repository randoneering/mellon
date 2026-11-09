import test from 'node:test';

test.skip('native boolean skip', () => {});
test('native string skip', { skip: 'database unavailable' }, () => {});
test.todo('native boolean todo');
test('native string todo', { todo: 'pending work' }, () => {});
test('native false flags run', { skip: false, todo: false }, () => {});
