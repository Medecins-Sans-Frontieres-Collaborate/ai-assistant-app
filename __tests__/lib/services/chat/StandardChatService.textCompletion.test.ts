/**
 * Plain-text completions on the user's chat model (used by the large-document
 * summarizer): one request shape per SDK, under the same region and
 * custom-source routing as the chat answer.
 */
import { StandardChatService } from '@/lib/services/chat/StandardChatService';
import type { TextCompletionRequest } from '@/lib/services/chat/textCompletion';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const request: TextCompletionRequest = {
  systemPrompt: 'You summarize.',
  userPrompt: 'Summarize this chunk.',
  maxTokens: 900,
  temperature: 0.1,
  user: { id: 'user-1' } as never,
};

const completion = (content: string) => ({
  choices: [{ message: { content } }],
});

function chatClient() {
  return { chat: { completions: { create: vi.fn() } } };
}

function service(regional?: Record<string, unknown>) {
  const azure = chatClient();
  const openai = chatClient();
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

describe('StandardChatService.completeText', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('sends an Azure OpenAI model the OpenAI-native fields', async () => {
    const { instance, azure } = service();
    azure.chat.completions.create.mockResolvedValue(completion('  summary  '));

    const text = await instance.completeText(
      {
        model: {
          id: 'gpt-5.2',
          deploymentName: 'gpt-5.2-dep',
          sdk: 'azure-openai',
        } as never,
      },
      request,
    );

    const [body] = azure.chat.completions.create.mock.calls[0];
    expect(body).toEqual({
      model: 'gpt-5.2-dep',
      messages: [
        { role: 'system', content: 'You summarize.' },
        { role: 'user', content: 'Summarize this chunk.' },
      ],
      max_completion_tokens: 900,
      temperature: 0.1,
      user: 'user-1',
    });
    expect(text).toBe('summary');
  });

  it('sends other Foundry models only the classic fields, on the Foundry client', async () => {
    const { instance, azure, openai } = service();
    openai.chat.completions.create.mockResolvedValue(completion('summary'));

    await instance.completeText(
      { model: { id: 'Mistral-Large-3', sdk: 'openai' } as never },
      request,
    );

    expect(azure.chat.completions.create).not.toHaveBeenCalled();
    const [body] = openai.chat.completions.create.mock.calls[0];
    // Strict third-party containers 422 on OpenAI-native keys.
    expect(body).toEqual({
      model: 'Mistral-Large-3',
      messages: expect.any(Array),
      max_tokens: 900,
      temperature: 0.1,
    });
  });

  it('uses the Messages API for an Anthropic model and joins its text blocks', async () => {
    const { instance, anthropic } = service();
    anthropic.messages.create.mockResolvedValue({
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'part one, ' },
        { type: 'text', text: 'part two' },
      ],
    });

    const text = await instance.completeText(
      { model: { id: 'claude-sonnet-5', sdk: 'anthropic-foundry' } as never },
      request,
    );

    const [body] = anthropic.messages.create.mock.calls[0];
    expect(body).toEqual({
      model: 'claude-sonnet-5',
      max_tokens: 900,
      system: 'You summarize.',
      messages: [{ role: 'user', content: 'Summarize this chunk.' }],
      temperature: 0.1,
    });
    expect(text).toBe('part one, part two');
  });

  it('passes a reasoning-effort hint to a reasoning model, at its lowest supported level', async () => {
    const { instance, azure } = service();
    azure.chat.completions.create.mockResolvedValue(completion('query'));

    await instance.completeText(
      {
        model: {
          id: 'gpt-5.2',
          sdk: 'azure-openai',
          supportsReasoningEffort: true,
          supportsMinimalReasoning: false,
        } as never,
      },
      { ...request, reasoningEffort: 'minimal' },
    );

    expect(
      azure.chat.completions.create.mock.calls[0][0].reasoning_effort,
    ).toBe('low');
  });

  it('sends no reasoning effort to a model that does not take one', async () => {
    const { instance, azure } = service();
    azure.chat.completions.create.mockResolvedValue(completion('query'));

    await instance.completeText(
      { model: { id: 'gpt-4.1', sdk: 'azure-openai' } as never },
      { ...request, reasoningEffort: 'minimal' },
    );

    expect(azure.chat.completions.create.mock.calls[0][0]).not.toHaveProperty(
      'reasoning_effort',
    );
  });

  it('omits temperature for a model that rejects custom values', async () => {
    const { instance, azure } = service();
    azure.chat.completions.create.mockResolvedValue(completion('summary'));

    await instance.completeText(
      {
        model: {
          id: 'o3',
          sdk: 'azure-openai',
          supportsTemperature: false,
        } as never,
      },
      request,
    );

    expect(azure.chat.completions.create.mock.calls[0][0]).not.toHaveProperty(
      'temperature',
    );
  });

  it('runs an EU caller on the EU region client, not the default', async () => {
    const euOpenai = chatClient();
    euOpenai.chat.completions.create.mockResolvedValue(completion('eu'));
    const { instance, openai } = service({ openAIClient: euOpenai });

    const text = await instance.completeText(
      {
        model: { id: 'Mistral-Large-3', sdk: 'openai' } as never,
        userRegion: 'EU',
      },
      request,
    );

    expect(text).toBe('eu');
    expect(openai.chat.completions.create).not.toHaveBeenCalled();
  });

  it('refuses an EU caller when the EU region has no client for the model', async () => {
    const { instance, openai } = service({});

    await expect(
      instance.completeText(
        {
          model: { id: 'Mistral-Large-3', sdk: 'openai' } as never,
          userRegion: 'EU',
        },
        request,
      ),
    ).rejects.toThrow(/residency/);
    expect(openai.chat.completions.create).not.toHaveBeenCalled();
  });

  it("runs a custom-source model on the user's own account and credential", async () => {
    const { instance, azure, openai, anthropic } = service();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(completion('byom summary')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const credential = {
      getToken: vi.fn(async () => ({
        token: 'user-token',
        expiresOnTimestamp: Date.now() + 3_600_000,
      })),
    };

    const text = await instance.completeText(
      {
        model: { id: 'byom-model', sdk: 'openai' } as never,
        userRegion: 'EU',
        customSource: {
          endpoint: 'https://user-account.services.ai.azure.com',
          credential,
        },
      },
      request,
    );

    expect(text).toBe('byom summary');
    expect(credential.getToken).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(String(url)).toBe(
      'https://user-account.services.ai.azure.com/openai/v1/chat/completions',
    );
    expect(new Headers(init.headers).get('authorization')).toBe(
      'Bearer user-token',
    );
    expect(azure.chat.completions.create).not.toHaveBeenCalled();
    expect(openai.chat.completions.create).not.toHaveBeenCalled();
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });
});
