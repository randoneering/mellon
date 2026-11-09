import { CONSERVATIVE_INPUT_MODE } from './input-budget.mjs';

export const SOL_MODEL_PROFILE = Object.freeze({
  id: 'gpt-6-1-sol',
  renderer: 'neon-responses-gpt-6-1-sol-v1',
  reasoningEffort: 'high',
});

export function validManifestModel(model) {
  if (!model || typeof model !== 'object' || Array.isArray(model)
    || typeof model.id !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(model.id)) {
    return false;
  }
  const sol = model.id === SOL_MODEL_PROFILE.id;
  const conservative = sol && Object.hasOwn(model, 'inputAdmission');
  const keys = sol ? ['id', 'renderer', 'reasoningEffort',
    ...(conservative ? ['inputAdmission'] : [])] : ['id'];
  return Object.keys(model).length === keys.length
    && keys.every(key => Object.hasOwn(model, key))
    && (!sol || (model.renderer === SOL_MODEL_PROFILE.renderer
      && model.reasoningEffort === SOL_MODEL_PROFILE.reasoningEffort))
    && (!conservative || model.inputAdmission === CONSERVATIVE_INPUT_MODE);
}
