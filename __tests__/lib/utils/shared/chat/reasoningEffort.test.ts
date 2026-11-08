import { resolveReasoningEffort } from '@/lib/utils/shared/chat/reasoningEffort';

import { OpenAIModels } from '@/types/openai';

import { describe, expect, it } from 'vitest';

const acceptsMinimal = {
  supportsReasoningEffort: true,
  supportsMinimalReasoning: true,
};
const rejectsMinimal = {
  supportsReasoningEffort: true,
  supportsMinimalReasoning: false,
};
const noReasoning = { supportsReasoningEffort: false };

describe('resolveReasoningEffort', () => {
  it('forwards minimal only when the model accepts it', () => {
    expect(resolveReasoningEffort(acceptsMinimal, 'minimal')).toBe('minimal');
    expect(resolveReasoningEffort(rejectsMinimal, 'minimal')).toBe('low');
  });

  it('leaves the other levels untouched for every reasoning model', () => {
    for (const effort of ['low', 'medium', 'high'] as const) {
      expect(resolveReasoningEffort(acceptsMinimal, effort)).toBe(effort);
      expect(resolveReasoningEffort(rejectsMinimal, effort)).toBe(effort);
    }
  });

  it('omits the parameter for models without reasoning effort or without a request', () => {
    expect(resolveReasoningEffort(noReasoning, 'minimal')).toBeUndefined();
    expect(resolveReasoningEffort(undefined, 'high')).toBeUndefined();
    expect(resolveReasoningEffort(acceptsMinimal, undefined)).toBeUndefined();
  });

  it('records that the GPT-5.6 trio rejects minimal while GPT-5.4 accepts it', () => {
    // Verified against the swedencentral deployment on 2026-11-07: the
    // endpoint answers 400 "does not support 'minimal' with this model".
    for (const id of ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra']) {
      expect(resolveReasoningEffort(OpenAIModels[id as never], 'minimal')).toBe(
        'low',
      );
    }
    expect(
      resolveReasoningEffort(OpenAIModels['gpt-5.4-nano' as never], 'minimal'),
    ).toBe('minimal');
  });
});
