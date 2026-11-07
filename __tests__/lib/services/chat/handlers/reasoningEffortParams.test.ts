/**
 * The chat completions handler must not forward `reasoning_effort: 'minimal'`
 * to deployments that reject it (GPT-5.6 and later answer HTTP 400, see
 * issue #149). The Responses API handler already downgraded; both now share
 * `resolveReasoningEffort`.
 */
import type { Session } from 'next-auth';

import { AzureOpenAIHandler } from '@/lib/services/chat/handlers/AzureOpenAIHandler';

import { OpenAIModel } from '@/types/openai';

import type { AzureOpenAI } from 'openai';
import { describe, expect, it } from 'vitest';

const user = { id: 'user-1' } as Session['user'];
const messages = [{ role: 'user' as const, content: 'Reply with OK.' }];

const acceptsMinimal: OpenAIModel = {
  id: 'gpt-5.4-nano',
  name: 'GPT-5.4 Nano',
  maxLength: 128000,
  tokenLimit: 16000,
  provider: 'openai',
  sdk: 'azure-openai',
  supportsReasoningEffort: true,
  supportsMinimalReasoning: true,
  supportsTemperature: false,
};

const rejectsMinimal: OpenAIModel = {
  ...acceptsMinimal,
  id: 'gpt-5.6-luna',
  name: 'GPT-5.6 Luna',
  supportsMinimalReasoning: false,
};

const noReasoning: OpenAIModel = {
  ...acceptsMinimal,
  id: 'gpt-4.1',
  name: 'GPT-4.1',
  supportsReasoningEffort: false,
  supportsTemperature: true,
};

describe('AzureOpenAIHandler reasoning effort parameters', () => {
  const handler = new AzureOpenAIHandler({} as AzureOpenAI);
  const build = (model: OpenAIModel, effort?: 'minimal' | 'low') =>
    handler.buildRequestParams(
      model.id,
      messages,
      0.5,
      user,
      false,
      model,
      effort,
    ) as unknown as { reasoning_effort?: string };

  it("forwards 'minimal' to a model that accepts it", () => {
    expect(build(acceptsMinimal, 'minimal').reasoning_effort).toBe('minimal');
  });

  it("downgrades 'minimal' to 'low' for a model that rejects it", () => {
    expect(build(rejectsMinimal, 'minimal').reasoning_effort).toBe('low');
  });

  it("passes 'low' through unchanged", () => {
    expect(build(rejectsMinimal, 'low').reasoning_effort).toBe('low');
  });

  it('omits the parameter for a model without reasoning effort', () => {
    expect(build(noReasoning, 'minimal')).not.toHaveProperty(
      'reasoning_effort',
    );
  });
});
