export const CONSERVATIVE_INPUT_MODE = 'conservative-bytes-v1';
export const MAX_RENDERED_INPUT_BYTES = 60 * 1024;
export const INPUT_SAFETY_ALLOWANCE = 4096;
export const MAX_INPUT_RESERVATION = 65536;

export function reserveRenderedInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 3
    || !['system', 'prompt', 'toolSchemas'].every(key => Object.hasOwn(value, key))
    || typeof value.system !== 'string' || typeof value.prompt !== 'string'
    || !Array.isArray(value.toolSchemas)) throw new Error('Rendered input budget is invalid.');
  let inputBytes;
  try {
    inputBytes = Buffer.byteLength(JSON.stringify({
      system: value.system, prompt: value.prompt, toolSchemas: value.toolSchemas,
    }));
  } catch { throw new Error('Rendered input budget is invalid.'); }
  if (inputBytes > MAX_RENDERED_INPUT_BYTES) {
    throw new Error('Rendered input exceeds the approved byte budget.');
  }
  // This is the approved conservative reservation, not a tokenizer or a framing guarantee.
  return Object.freeze({ mode: CONSERVATIVE_INPUT_MODE, inputBytes,
    inputTokens: inputBytes + INPUT_SAFETY_ALLOWANCE });
}
