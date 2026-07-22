import {
  buildLocalModel,
  buildLocalModelId,
  isLocalModel,
  isLocalModelId,
  parseLocalModelId,
} from '@/lib/services/models/localModels';
import { isWorkflowEligibleModel } from '@/lib/services/workflows/shared/workflowModels';

import { getModelHosting } from '@/types/openai';

import { describe, expect, it } from 'vitest';

// Real-world names: Ollama tags use ':', HuggingFace refs add '/' and more
// ':'. These must survive the id round-trip untouched.
const AWKWARD_NAMES = [
  'llama3.1:8b',
  'hf.co/user/repo:Q4_K_M',
  'qwen2.5-coder:7b-instruct-q4_0',
  'mistral',
];

describe('local model ids', () => {
  it('round-trips names containing colons, slashes and dashes', () => {
    for (const name of AWKWARD_NAMES) {
      const id = buildLocalModelId('ollama', name);
      expect(parseLocalModelId(id)).toEqual({
        runtime: 'ollama',
        modelName: name,
      });
    }
  });

  it('keeps runtimes in separate namespaces', () => {
    const a = buildLocalModelId('ollama', 'mistral');
    const b = buildLocalModelId('lmstudio', 'mistral');
    expect(a).not.toBe(b);
    expect(parseLocalModelId(a)?.runtime).toBe('ollama');
    expect(parseLocalModelId(b)?.runtime).toBe('lmstudio');
  });

  it('does not encode the port, so a port change keeps ids stable', () => {
    // Guards the design decision: ids must survive the user editing a port,
    // or every persisted conversation would orphan.
    expect(buildLocalModelId('ollama', 'mistral')).toBe('local-ollama-mistral');
  });

  it('rejects non-local and malformed ids', () => {
    expect(isLocalModelId('gpt-5.2')).toBe(false);
    expect(isLocalModelId('byom-abc123-gpt-4o')).toBe(false);
    expect(isLocalModelId(undefined)).toBe(false);
    expect(parseLocalModelId('local-unknownruntime-x')).toBeNull();
    // Empty model name is not a usable id.
    expect(parseLocalModelId('local-ollama-')).toBeNull();
  });
});

describe('isLocalModel', () => {
  it('detects by flag or by id, and is safe on nullish input', () => {
    expect(isLocalModel(buildLocalModel('ollama', 'mistral'))).toBe(true);
    expect(isLocalModel({ id: 'local-ollama-mistral' })).toBe(true);
    expect(isLocalModel({ id: 'gpt-5.2', isLocalModel: true })).toBe(true);
    expect(isLocalModel({ id: 'gpt-5.2' })).toBe(false);
    expect(isLocalModel(undefined)).toBe(false);
    expect(isLocalModel(null)).toBe(false);
  });
});

describe('buildLocalModel', () => {
  const model = buildLocalModel('ollama', 'llama3.1:8b');

  it('reports hosting as local rather than defaulting to azure', () => {
    // Compliance disclosure: getModelHosting() defaults absent values to
    // 'azure', which would be a false claim for on-device inference.
    expect(getModelHosting(model)).toBe('local');
  });

  it('advertises no server-backed capabilities', () => {
    // The browser-direct path has no pipeline behind it, so claiming these
    // would produce silent no-ops rather than working features.
    expect(model.supportsVision).toBe(false);
    expect(model.supportsTools).toBe(false);
    expect(model.supportsReasoningEffort).toBe(false);
    expect(model.supportsVerbosity).toBe(false);
  });

  it('stays out of the catalog family tree', () => {
    expect(model.series).toBeUndefined();
    expect(model.provider).toBeUndefined();
  });

  it('sends the runtime-native name on the wire, not the app id', () => {
    expect(model.deploymentName).toBe('llama3.1:8b');
    expect(model.id).not.toBe(model.deploymentName);
  });
});

describe('workflow eligibility', () => {
  it('excludes local models — workflows run server-side and cannot reach loopback', () => {
    expect(isWorkflowEligibleModel(buildLocalModel('ollama', 'mistral'))).toBe(
      false,
    );
  });
});
