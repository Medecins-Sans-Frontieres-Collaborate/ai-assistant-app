import { ChatService } from '@/client/services/chat/ChatService';

import { Message, MessageType } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the image base64 conversion so it doesn't fire a real fetch.
vi.mock('@/lib/services/imageService', () => ({
  fetchImageBase64FromMessageContent: vi.fn(
    async () => 'data:image/png;base64,aaaa',
  ),
}));

// Capture the body posted by ChatService so we can assert on it without a real
// network call.
const postStreamMock = vi.fn(async () => new ReadableStream<Uint8Array>());
const postMock = vi.fn(async () => ({ text: '' }));

vi.mock('@/client/services/api', () => ({
  apiClient: {
    postStream: (...args: unknown[]) => postStreamMock(...args),
    post: (...args: unknown[]) => postMock(...args),
  },
}));

const model: OpenAIModel = {
  id: 'gpt-4o',
  name: 'GPT-4o',
  maxLength: 12000,
  tokenLimit: 8000,
};

function getPostedMessages(): Message[] {
  const [, body] = postStreamMock.mock.calls[0] ?? postMock.mock.calls[0];
  return (body as { messages: Message[] }).messages;
}

describe('ChatService normalization wire-up', () => {
  beforeEach(() => {
    postStreamMock.mockClear();
    postMock.mockClear();
  });

  it('coerces content: null to empty string before posting (streaming path)', async () => {
    const service = new ChatService();
    const messages: Message[] = [
      {
        role: 'user',
        content: 'hello',
        messageType: MessageType.TEXT,
      },
      {
        role: 'assistant',
        content: null as unknown as string,
        messageType: MessageType.TEXT,
      },
    ];

    await service.chat(model, messages);

    expect(postStreamMock).toHaveBeenCalledOnce();
    const posted = getPostedMessages();
    expect(posted).toHaveLength(2);
    expect(posted[0].content).toBe('hello');
    expect(posted[1].content).toBe('');
  });

  it('extracts text from a bare TextMessageContent object', async () => {
    const service = new ChatService();
    const messages: Message[] = [
      {
        role: 'assistant',
        content: { type: 'text', text: 'legacy-bare' } as never,
        messageType: MessageType.TEXT,
      },
    ];

    await service.chat(model, messages);

    expect(getPostedMessages()[0].content).toBe('legacy-bare');
  });

  it('drops messages with an invalid role', async () => {
    const service = new ChatService();
    const messages = [
      { role: 'user', content: 'keep me', messageType: MessageType.TEXT },
      {
        role: 'narrator' as unknown as 'user',
        content: 'drop me',
        messageType: MessageType.TEXT,
      },
    ];

    await service.chat(model, messages as Message[]);

    const posted = getPostedMessages();
    expect(posted).toHaveLength(1);
    expect(posted[0].content).toBe('keep me');
  });

  it('also normalizes on the non-streaming path', async () => {
    const service = new ChatService();
    const messages: Message[] = [
      {
        role: 'assistant',
        content: null as unknown as string,
        messageType: MessageType.TEXT,
      },
    ];

    await service.chatNonStreaming(model, messages);

    expect(postMock).toHaveBeenCalledOnce();
    const posted = (postMock.mock.calls[0][1] as { messages: Message[] })
      .messages;
    expect(posted).toHaveLength(1);
    expect(posted[0].content).toBe('');
  });
});
