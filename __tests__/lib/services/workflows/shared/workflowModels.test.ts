import {
  isWorkflowEligibleModel,
  resolveWorkflowModelId,
} from '@/lib/services/workflows/shared/workflowModels';

import { DEFAULT_ANALYSIS_MODEL } from '@/lib/utils/app/const';

import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { describe, expect, it } from 'vitest';

describe('resolveWorkflowModelId', () => {
  it('falls back to the default when absent or unknown', () => {
    expect(resolveWorkflowModelId(undefined)).toBe(DEFAULT_ANALYSIS_MODEL);
    expect(resolveWorkflowModelId('not-a-model')).toBe(DEFAULT_ANALYSIS_MODEL);
  });

  it('accepts a known Azure-OpenAI base model', () => {
    // The default itself must resolve to itself.
    expect(resolveWorkflowModelId(DEFAULT_ANALYSIS_MODEL)).toBe(
      DEFAULT_ANALYSIS_MODEL,
    );
  });

  it('rejects non-openai providers', () => {
    const anthropic = Object.values(OpenAIModels).find(
      (m) => m.provider === 'anthropic',
    );
    if (anthropic) {
      expect(resolveWorkflowModelId(anthropic.id)).toBe(DEFAULT_ANALYSIS_MODEL);
    }
  });
});

describe('isWorkflowEligibleModel', () => {
  it('rejects agents and disabled models', () => {
    expect(isWorkflowEligibleModel({ isCustomAgent: true })).toBe(false);
    expect(isWorkflowEligibleModel({ isOrganizationAgent: true })).toBe(false);
    expect(isWorkflowEligibleModel({ isDisabled: true })).toBe(false);
  });

  it('rejects non-openai providers, accepts openai/unspecified', () => {
    expect(isWorkflowEligibleModel({ provider: 'anthropic' })).toBe(false);
    expect(isWorkflowEligibleModel({ provider: 'mistral' })).toBe(false);
    expect(isWorkflowEligibleModel({ provider: 'openai' })).toBe(true);
    expect(isWorkflowEligibleModel({})).toBe(true);
  });

  it('agrees with the resolver on every configured model', () => {
    for (const model of Object.values(OpenAIModels)) {
      const resolved = resolveWorkflowModelId(model.id);
      if (isWorkflowEligibleModel(model)) {
        expect(resolved).toBe(model.id);
      } else {
        expect(resolved).toBe(DEFAULT_ANALYSIS_MODEL);
      }
    }
  });

  it('keeps GPT_5_2 (the default analysis model) eligible', () => {
    expect(isWorkflowEligibleModel(OpenAIModels[OpenAIModelID.GPT_5_2])).toBe(
      true,
    );
  });
});
