/**
 * The chat-model routing fallback: one structured decision per SDK, under
 * the same residency guard as the chat answer.
 */
import { StandardChatService } from '@/lib/services/chat/StandardChatService';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const params = {
  model: 'aux-router',
  messages: [
    { role: 'system' as const, content: 'Decide the tools.' },
    { role: 'user' as const, content: 'Make the Word review' },
  ],
  max_completion_tokens: 290,
  response_format: {
    type: 'json_schema' as const,
    json_schema: {
      name: 'tool_router_response',
      strict: true,
      schema: {
        type: 'object',
        properties: { needsCodeExecution: { type: 'boolean' } },
        required: ['needsCodeExecution'],
        additionalProperties: false,
      },
    },
  },
};

const completion = (content: string) => ({
  choices: [{ message: { content } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

function service(regional?: Record<string, unknown>) {
  const azure = { chat: { completions: { create: vi.fn() } } };
  const openai = { chat: { completions: { create: vi.fn() } } };
  const anthropic = { messages: { create: vi.fn() } };
  const instance = new StandardChatService(
    azure as never,
    openai as never,
    anthropic as never,
    {} as never,
    {} as never,
    {} as never,
    regional ? () => regional as never : undefined,
  );
  return { instance, azure, openai, anthropic };
}

describe('StandardChatService.completeStructuredDecision', () => {
  beforeEach(() => vi.clearAllMocks());

  it('holds an Azure OpenAI model to the schema via the API', async () => {
    const { instance, azure } = service();
    azure.chat.completions.create.mockResolvedValue(
      completion('{"needsCodeExecution":true}'),
    );
    const result = await instance.completeStructuredDecision(
      {
        model: {
          id: 'gpt-5.2',
          deploymentName: 'gpt-5.2-dep',
          sdk: 'azure-openai',
          supportsReasoningEffort: true,
        } as never,
      },
      params,
    );
    const [request] = azure.chat.completions.create.mock.calls[0];
    expect(request.model).toBe('gpt-5.2-dep');
    expect(request.response_format).toEqual(params.response_format);
    expect(request.reasoning_effort).toBe('low');
    expect(request.max_completion_tokens).toBe(2000);
    expect(result).toMatchObject({
      text: '{"needsCodeExecution":true}',
      usage: { totalTokens: 15 },
    });
  });

  it('gives other Foundry models the schema in the prompt and parses tolerantly', async () => {
    const { instance, openai } = service();
    openai.chat.completions.create.mockResolvedValue(
      completion('Sure:\n```json\n{"needsCodeExecution":true}\n```'),
    );
    const result = await instance.completeStructuredDecision(
      { model: { id: 'Mistral-Large-3', sdk: 'openai' } as never },
      params,
    );
    const [request] = openai.chat.completions.create.mock.calls[0];
    expect(request.response_format).toBeUndefined();
    // Strict third-party containers reject the OpenAI-native fields (422).
    expect(request.max_completion_tokens).toBeUndefined();
    expect(request.reasoning_effort).toBeUndefined();
    expect(request.max_tokens).toBe(2000);
    expect(request.messages.at(-1).content).toContain('JSON schema');
    expect(result.text).toBe('{"needsCodeExecution":true}');
  });

  it('forces an Anthropic model to answer through a schema-typed tool', async () => {
    const { instance, anthropic } = service();
    anthropic.messages.create.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          name: 'tool_router_response',
          input: { needsCodeExecution: true },
        },
      ],
      usage: { input_tokens: 12, output_tokens: 3 },
    });
    const result = await instance.completeStructuredDecision(
      { model: { id: 'claude-sonnet-5', sdk: 'anthropic-foundry' } as never },
      params,
    );
    const [request] = anthropic.messages.create.mock.calls[0];
    expect(request.system).toBe('Decide the tools.');
    expect(request.tool_choice).toEqual({
      type: 'tool',
      name: 'tool_router_response',
    });
    expect(request.tools[0].input_schema).toEqual(
      params.response_format.json_schema.schema,
    );
    expect(JSON.parse(result.text)).toEqual({ needsCodeExecution: true });
  });

  it('refuses an EU caller when the EU region has no client for the model', async () => {
    const { instance, openai } = service({});
    await expect(
      instance.completeStructuredDecision(
        {
          model: { id: 'Mistral-Large-3', sdk: 'openai' } as never,
          userRegion: 'EU',
        },
        params,
      ),
    ).rejects.toThrow(/residency/);
    expect(openai.chat.completions.create).not.toHaveBeenCalled();
  });

  it('throws when the reply carries no JSON object', async () => {
    const { instance, openai } = service();
    openai.chat.completions.create.mockResolvedValue(
      completion('I cannot decide.'),
    );
    await expect(
      instance.completeStructuredDecision(
        { model: { id: 'Mistral-Large-3', sdk: 'openai' } as never },
        params,
      ),
    ).rejects.toThrow(/no JSON decision/);
  });
});
