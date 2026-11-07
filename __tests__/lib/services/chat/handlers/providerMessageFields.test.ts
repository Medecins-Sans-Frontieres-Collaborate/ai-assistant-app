/**
 * History messages carry app-internal bookkeeping (tool-call records,
 * citations, thinking, error flags, tone/prompt ids). Azure OpenAI ignores
 * unknown message keys, but third-party publishers behind Azure AI Foundry
 * (Mistral and others) validate request bodies strictly and reject the whole
 * request — every follow-up turn after a reply with a tool record failed
 * with "the model service rejected the request as invalid" (issue #152).
 * Both chat.completions handlers must forward only `role` and `content`.
 */
import { AzureOpenAIHandler } from '@/lib/services/chat/handlers/AzureOpenAIHandler';
import { StandardOpenAIHandler } from '@/lib/services/chat/handlers/StandardOpenAIHandler';

import {
  toProviderMessageFields,
  toProviderMessages,
} from '@/lib/utils/server/chat/providerMessages';

import { Message, MessageType } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';

import type OpenAI from 'openai';
import type { AzureOpenAI } from 'openai';
import { describe, expect, it } from 'vitest';

const PROVIDER_FIELDS = ['role', 'content'];

/** A follow-up turn whose history reply carries every app-internal field. */
const historyWithRecords: Message[] = [
  {
    id: 'u1',
    role: 'user',
    content: 'Create a presentation as a .pptx file.',
    messageType: MessageType.TEXT,
    toneId: null,
    promptId: null,
  },
  {
    role: 'assistant',
    content: '\n\n\nHere is the file.',
    messageType: MessageType.TEXT,
    toolCalls: [
      {
        id: 'skills-1',
        name: 'use_skills',
        server_label: 'Skills',
        arguments: null,
        status: 'incomplete',
        output: 'Automatic skill selection unavailable.',
        error: null,
      },
    ],
    citations: [],
    thinking: 'reasoning summary',
    error: false,
    usage: {
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      modelId: 'm',
    },
  } as Message,
  {
    id: 'u2',
    role: 'user',
    content: [
      { type: 'text', text: 'Change the title of slide 2.' },
      {
        type: 'file_url',
        url: '/api/file/abc.pptx',
        originalFilename: 'deck.pptx',
      },
    ] as Message['content'],
    messageType: MessageType.TEXT,
    toneId: 'formal',
    promptId: 'p1',
  },
];

const foundryModel: OpenAIModel = {
  id: 'Mistral-Large-3',
  name: 'Mistral Large 3',
  maxLength: 128000,
  tokenLimit: 16000,
  provider: 'mistral',
  sdk: 'openai',
};

const azureModel: OpenAIModel = {
  id: 'gpt-5.4',
  name: 'GPT-5.4',
  maxLength: 128000,
  tokenLimit: 16000,
  provider: 'openai',
  sdk: 'azure-openai',
};

const reasoningAzureModel: OpenAIModel = {
  ...azureModel,
  id: 'o3',
  modelType: 'reasoning',
};

function expectProviderShape(
  prepared: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
): void {
  for (const message of prepared) {
    expect(Object.keys(message).sort()).toEqual([...PROVIDER_FIELDS].sort());
  }
}

describe('toProviderMessageFields', () => {
  it('keeps only role and content', () => {
    const [, assistant] = historyWithRecords;
    const provider = toProviderMessageFields(assistant);
    expect(provider).toEqual({ role: 'assistant', content: assistant.content });
    expect(provider).not.toHaveProperty('toolCalls');
  });

  it('returns a new object and leaves the source message intact', () => {
    const [, assistant] = historyWithRecords;
    const provider = toProviderMessageFields(assistant);
    expect(provider).not.toBe(assistant);
    expect(assistant).toHaveProperty('toolCalls');
  });

  it('maps every message in order', () => {
    const provider = toProviderMessages(historyWithRecords);
    expect(provider.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expectProviderShape(provider);
  });
});

describe('StandardOpenAIHandler provider message fields', () => {
  const handler = new StandardOpenAIHandler({} as OpenAI);

  it('drops app-internal fields from history messages', () => {
    const prepared = handler.prepareMessages(
      historyWithRecords,
      'Prompt',
      foundryModel,
    );
    expect(prepared[0]).toEqual({ role: 'system', content: 'Prompt' });
    expectProviderShape(prepared.slice(1));
    expect(prepared[2]).toEqual({
      role: 'assistant',
      content: '\n\n\nHere is the file.',
    });
  });
});

describe('AzureOpenAIHandler provider message fields', () => {
  const handler = new AzureOpenAIHandler({} as AzureOpenAI);

  it('drops app-internal fields on the standard system-prompt path', () => {
    const prepared = handler.prepareMessages(
      historyWithRecords,
      'Prompt',
      azureModel,
    );
    expect(prepared[0]).toEqual({ role: 'system', content: 'Prompt' });
    expectProviderShape(prepared.slice(1));
    // Unsupported `file_url` parts are still filtered, text survives.
    expect(prepared[3]).toEqual({
      role: 'user',
      content: 'Change the title of slide 2.',
    });
  });

  it('drops app-internal fields on the merged-prompt path', () => {
    const prepared = handler.prepareMessages(
      historyWithRecords,
      'Prompt',
      reasoningAzureModel,
    );
    expectProviderShape(prepared);
    expect(prepared.every((m) => m.role !== 'system')).toBe(true);
    expect(prepared[0].content).toContain('Prompt');
    expect(prepared[1]).toEqual({
      role: 'assistant',
      content: '\n\n\nHere is the file.',
    });
  });
});
