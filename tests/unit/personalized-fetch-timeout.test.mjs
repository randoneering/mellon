import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSubmission, parseSubmissionUrl } from '../../src/personalized/github.mjs';

const submission = parseSubmissionUrl('https://github.com/o/r/issues/5');

async function withTimeoutSpy(run) {
  const original = AbortSignal.timeout;
  const signals = [];
  const durations = [];
  AbortSignal.timeout = milliseconds => {
    const signal = original.call(AbortSignal, milliseconds);
    durations.push(milliseconds);
    signals.push(signal);
    return signal;
  };
  try {
    await run(signals, durations);
  } finally {
    AbortSignal.timeout = original;
  }
}

test('uses a fresh five-second AbortSignal for every request', async () => {
  await withTimeoutSpy(async (signals, durations) => {
    const seen = [];
    const fetchImpl = async (_url, options) => {
      seen.push(options.signal);
      return new Response(JSON.stringify({ title: 'Title', body: 'Body' }));
    };
    assert.deepEqual(await fetchSubmission(submission, 'token', fetchImpl), {
      title: 'Title', body: 'Body',
    });
    assert.deepEqual(await fetchSubmission(submission, 'token', fetchImpl), {
      title: 'Title', body: 'Body',
    });
    assert.deepEqual(durations, [5000, 5000]);
    assert.equal(signals.length, 2);
    assert.equal(seen.length, 2);
    assert.ok(signals[0] instanceof AbortSignal);
    assert.ok(signals[1] instanceof AbortSignal);
    assert.notStrictEqual(signals[0], signals[1]);
    assert.deepEqual(seen, signals);
  });
});

test('sanitizes AbortError from fetch', async () => {
  await withTimeoutSpy(async () => {
    await assert.rejects(
      fetchSubmission(submission, 'token', async () => {
        const error = new Error('private response and bearer token');
        error.name = 'AbortError';
        throw error;
      }),
      error => error.message === 'GitHub submission request failed safely.',
    );
  });
});

test('sanitizes TimeoutError from response parsing', async () => {
  await withTimeoutSpy(async () => {
    await assert.rejects(
      fetchSubmission(submission, 'token', async () => ({
        ok: true,
        status: 200,
        json: async () => {
          const error = new Error('private response and bearer token');
          error.name = 'TimeoutError';
          throw error;
        },
      })),
      error => error.message === 'GitHub submission request failed safely.',
    );
  });
});
