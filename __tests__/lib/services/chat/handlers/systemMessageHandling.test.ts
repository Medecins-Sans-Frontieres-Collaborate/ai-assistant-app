/**
 * In-array system messages (enricher-injected RAG/file context) must reach
 * every model family: models with a no-system policy get them converted to
 * user messages in place — never forwarded as 'system', never dropped.
 */
import { AzureOpenAIHandler } from '@/lib/services/chat/handlers/AzureOpenAIHandler';
import { DeepSeekHandler } from '@/lib/services/chat/handlers/DeepSeekHandler';

import { Message, MessageType } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';

import type OpenAI from 'openai';
import type { AzureOpenAI } from 'openai';
import { describe, expect, it } from 'vitest';

const ragMessages: Message[] = [
  {
    role: 'system',
    content: 'Available sources:\n\nSource 1:\nContent: chunk text',
    messageType: MessageType.TEXT,
  },
  { role: 'user', content: 'Question?', messageType: MessageType.TEXT },
];

const baseModel: OpenAIModel = {
  id: 'gpt-5.2-chat',
  name: 'GPT-5.2 Chat',
  maxLength: 128000,
  tokenLimit: 16000,
  provider: 'openai',
  sdk: 'azure-openai',
};

describe('AzureOpenAIHandler system-message handling', () => {
  const handler = new AzureOpenAIHandler({} as AzureOpenAI);

  it('keeps system messages for standard models', () => {
    const prepared = handler.prepareMessages(ragMessages, 'Prompt', baseModel);
    expect(prepared[0]).toEqual({ role: 'system', content: 'Prompt' });
    expect(prepared[1].role).toBe('system');
    expect(prepared[1].content).toContain('chunk text');
  });

  it('converts in-array system messages to user for avoid-system models', () => {
    const reasoningModel: OpenAIModel = {
      ...baseModel,
      id: 'o3',
      modelType: 'reasoning',
    };
    const prepared = handler.prepareMessages(
      ragMessages,
      'Prompt',
      reasoningModel,
    );
    expect(prepared.every((m) => m.role !== 'system')).toBe(true);
    // Context survives as a user message with the prompt merged in front.
    expect(prepared[0].role).toBe('user');
    expect(prepared[0].content).toContain('Prompt');
    expect(prepared[0].content).toContain('chunk text');
    expect(prepared[1]).toEqual({ role: 'user', content: 'Question?' });
  });
});

describe('DeepSeekHandler system-message handling', () => {
  const handler = new DeepSeekHandler({} as OpenAI);

  it('converts in-array system messages to user and merges the prompt', () => {
    const prepared = handler.prepareMessages(ragMessages, 'Prompt', baseModel);
    expect(prepared.every((m) => m.role !== 'system')).toBe(true);
    expect(prepared[0].role).toBe('user');
    expect(prepared[0].content).toContain('Prompt');
    expect(prepared[0].content).toContain('chunk text');
    expect(prepared[1]).toEqual({ role: 'user', content: 'Question?' });
  });
});
