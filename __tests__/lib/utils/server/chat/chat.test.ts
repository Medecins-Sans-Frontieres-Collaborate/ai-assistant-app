import {
  IMAGE_TOKENS_HIGH_DETAIL,
  IMAGE_TOKENS_LOW_DETAIL,
  countMessageTokens,
  getMessagesToSend,
} from '@/lib/utils/server/chat/chat';

import { ImageMessageContent, Message, TextMessageContent } from '@/types/chat';

// Import after mocks
import { Tiktoken } from '@dqbd/tiktoken/lite/init';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock blob/image helpers used by processImageUrl
vi.mock('@/lib/utils/server/blob/blob', () => ({
  getBlobBase64String: vi.fn().mockResolvedValue('data:image/png;base64,abc'),
}));
vi.mock('@/lib/utils/app/image', () => ({
  getBase64FromImageURL: vi.fn().mockResolvedValue('data:image/png;base64,abc'),
}));
vi.mock('@/lib/utils/app/chat', () => ({
  isFileConversation: vi.fn().mockReturnValue(false),
  isImageConversation: vi.fn().mockReturnValue(false),
}));

// Mock Tiktoken: encode splits on whitespace so token count = word count
vi.mock('@dqbd/tiktoken/lite/init', () => {
  class MockTiktoken {
    encode = vi.fn((text: string) => {
      if (!text || text.trim().length === 0) return [];
      return text.trim().split(/\s+/);
    });
    free = vi.fn();
  }

  return {
    init: vi.fn().mockResolvedValue(undefined),
    Tiktoken: MockTiktoken,
  };
});

vi.mock('@dqbd/tiktoken/encoders/cl100k_base.json', () => ({
  default: { bpe_ranks: {}, special_tokens: {}, pat_str: '' },
}));

function makeEncoding(): InstanceType<typeof Tiktoken> {
  return new Tiktoken({} as any, {} as any, {} as any);
}

function textMessage(
  text: string,
  role: 'user' | 'assistant' = 'user',
): Message {
  return { role, content: text };
}

function imageMessage(
  text: string,
  detail: 'low' | 'high' | 'auto' = 'auto',
): Message {
  return {
    role: 'user',
    content: [
      { type: 'text', text } as TextMessageContent,
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,abc', detail },
      } as ImageMessageContent,
    ],
  };
}

const testUser = {
  id: 'test-user',
  email: 'test@test.com',
  name: 'Test',
  displayName: 'Test',
};

describe('countMessageTokens', () => {
  let encoding: InstanceType<typeof Tiktoken>;

  beforeEach(() => {
    encoding = makeEncoding();
  });

  it('counts tokens for string content', () => {
    const msg = textMessage('hello world');
    expect(countMessageTokens(msg, encoding)).toBe(2);
  });

  it('counts tokens for array with text-only parts', () => {
    const msg: Message = {
      role: 'user',
      content: [{ type: 'text', text: 'one two three' } as TextMessageContent],
    };
    expect(countMessageTokens(msg, encoding)).toBe(3);
  });

  it('counts tokens for text + low-detail image', () => {
    const msg = imageMessage('hello', 'low');
    // 1 text token + 85 image tokens
    expect(countMessageTokens(msg, encoding)).toBe(1 + IMAGE_TOKENS_LOW_DETAIL);
  });

  it('counts tokens for text + high-detail image', () => {
    const msg = imageMessage('hello', 'high');
    expect(countMessageTokens(msg, encoding)).toBe(
      1 + IMAGE_TOKENS_HIGH_DETAIL,
    );
  });

  it('counts tokens for text + auto-detail image (treated as high)', () => {
    const msg = imageMessage('hello', 'auto');
    expect(countMessageTokens(msg, encoding)).toBe(
      1 + IMAGE_TOKENS_HIGH_DETAIL,
    );
  });

  it('accumulates costs for multiple images', () => {
    const msg: Message = {
      role: 'user',
      content: [
        { type: 'text', text: 'two words' } as TextMessageContent,
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,a', detail: 'auto' },
        } as ImageMessageContent,
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,b', detail: 'low' },
        } as ImageMessageContent,
      ],
    };
    expect(countMessageTokens(msg, encoding)).toBe(
      2 + IMAGE_TOKENS_HIGH_DETAIL + IMAGE_TOKENS_LOW_DETAIL,
    );
  });

  it('returns 0 for empty content', () => {
    const msg: Message = { role: 'user', content: '' };
    expect(countMessageTokens(msg, encoding)).toBe(0);
  });
});

describe('getMessagesToSend – image token budget', () => {
  let encoding: InstanceType<typeof Tiktoken>;

  beforeEach(() => {
    vi.clearAllMocks();
    encoding = makeEncoding();
  });

  it('keeps all messages when image tokens fit within budget', async () => {
    const messages: Message[] = [
      imageMessage('hi', 'low'),
      textMessage('reply', 'assistant'),
      imageMessage('bye', 'low'),
    ];
    // Each image msg: 1 text + 85 image = 86; text msg: 1
    // Total: 86 + 1 + 86 = 173
    const result = await getMessagesToSend(
      messages,
      encoding,
      0,
      500, // plenty of room
      testUser,
    );
    expect(result).toHaveLength(3);
  });

  it('drops older messages when image tokens exceed budget', async () => {
    const messages: Message[] = [
      imageMessage('first', 'auto'), // 1 + 765 = 766
      textMessage('reply', 'assistant'), // 1
      imageMessage('second', 'auto'), // 1 + 765 = 766
      textMessage('reply2', 'assistant'), // 1
      imageMessage('last', 'auto'), // 1 + 765 = 766
    ];
    // Budget: last(766) + reply2(1) + second(766) = 1533
    // Adding reply(1) would be 1534 > 1533, so break.
    // reply2 is not orphaned (second precedes it as user).
    const result = await getMessagesToSend(
      messages,
      encoding,
      0,
      1533,
      testUser,
    );
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(messages[2]); // second
    expect(result[1]).toBe(messages[3]); // reply2
    expect(result[2]).toBe(messages[4]); // last
  });

  it('drops orphaned leading assistant message after truncation', async () => {
    // Scenario: budget fits assistant1 + user2 + assistant2 + user3, but not
    // user1. The contiguous suffix starts with assistant1 (orphaned — its
    // user1 prompt was truncated). The post-loop check drops it.
    const messages: Message[] = [
      textMessage('user1'), // 1 token
      textMessage('assistant1', 'assistant'), // 1 token
      textMessage('user2'), // 1 token
      textMessage('assistant2', 'assistant'), // 1 token
      imageMessage('user3', 'auto'), // 1 + 765 = 766 tokens
    ];
    const result = await getMessagesToSend(
      messages,
      encoding,
      0,
      769, // fits user3(766)+assistant2(1)+user2(1)+assistant1(1)=769, not user1
      testUser,
    );
    // assistant1 is dropped because it's a leading assistant without its user prompt
    expect(result).toHaveLength(3);
    expect(result[0].content).toBe('user2');
    expect(result[1].content).toBe('assistant2');
  });

  it('stops truncation at first message that exceeds budget', async () => {
    // With break (not continue), once a message doesn't fit, no older
    // messages are tried — even if they would individually fit.
    const longText = Array.from({ length: 100 }, (_, i) => `word${i}`).join(
      ' ',
    ); // 100 tokens
    const messages: Message[] = [
      textMessage('old'), // 1 token - would fit individually
      textMessage(longText), // 100 tokens - doesn't fit
      textMessage('recent', 'assistant'), // 1 token
      textMessage('latest'), // 1 token
    ];
    const result = await getMessagesToSend(
      messages,
      encoding,
      0,
      10, // fits latest (1) + recent (1) = 2, but not longText (100)
      testUser,
    );
    // recent is an orphaned assistant reply (its user prompt longText was dropped),
    // so it gets dropped too. Only latest remains.
    // Actually recent is assistant and latest is user, so after orphan drop:
    // only latest remains since recent (assistant) leads without a user prompt.
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('latest');
  });

  it('always includes the last message even if it exceeds budget', async () => {
    const messages: Message[] = [imageMessage('only', 'high')];
    // Token budget is tiny, but last message is always included
    const result = await getMessagesToSend(messages, encoding, 0, 10, testUser);
    expect(result).toHaveLength(1);
  });
});
