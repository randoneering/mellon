export class InputError extends Error {
  constructor(status) {
    super('Request could not be accepted.');
    this.status = status;
  }
}

export async function readBytes(stream, limit, timeoutMs = 10000) {
  if (!stream) return Buffer.alloc(0);
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new InputError(503)), timeoutMs);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), expired]);
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new InputError(413);
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

export function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function hasReadyLabel(labels) {
  return Array.isArray(labels) && labels.some(label =>
    typeof label?.name === 'string' && label.name.toLowerCase() === 'agent: ready');
}

export function validRepository(repository) {
  return positiveId(repository?.id) && typeof repository.fullName === 'string' &&
    /^[a-z\d-]+\/[a-z\d_.-]+$/i.test(repository.fullName);
}
