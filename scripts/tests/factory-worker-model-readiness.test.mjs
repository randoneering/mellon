import test from 'node:test';
import assert from 'node:assert/strict';
import { requestedModelAvailable } from '../../internal/factory-worker/live-setup.mjs';

const MODEL = 'openai-codex/gpt-6.1-sol';

test('uses T3 ServerProviderModel.slug rather than a Pi model id', () => {
  const provider = { instanceId: 'pi', driver: 'pi', models: [
    { slug: MODEL, name: 'Selected model', subProvider: 'openai-codex', isCustom: false, capabilities: null },
  ] };
  assert.equal(requestedModelAvailable(provider), true);
});

test('does not silently accept another provider, an alias or the wrong model shape', () => {
  for (const provider of [
    { instanceId: 'codex', driver: 'codex', models: [{ slug: MODEL }] },
    { instanceId: 'pi', driver: 'pi', models: [{ id: MODEL }] },
    { instanceId: 'pi', driver: 'pi', models: [{ slug: 'different-model', aliases: [MODEL] }] },
    { instanceId: 'pi', driver: 'pi', models: [] },
  ]) assert.equal(requestedModelAvailable(provider), false);
});
