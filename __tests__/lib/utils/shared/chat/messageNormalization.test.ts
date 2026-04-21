import {
  normalizeMessageContent,
  normalizeMessagesForAPI,
} from '@/lib/utils/shared/chat/messageNormalization';

import { MessageType } from '@/types/chat';

import { describe, expect, it } from 'vitest';

describe('normalizeMessageContent', () => {
  it('passes strings through unchanged', () => {
    expect(normalizeMessageContent('hello')).toBe('hello');
    expect(normalizeMessageContent('')).toBe('');
  });

  it('passes valid arrays through and filters invalid blocks', () => {
    const input = [
      { type: 'text', text: 'a' },
      { type: 'image_url', image_url: { url: 'https://x', detail: 'auto' } },
      { type: 'bogus', foo: 'bar' },
      null,
      'raw-string',
    ];
    const result = normalizeMessageContent(input);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });

  it('extracts text from a bare TextMessageContent object', () => {
    expect(normalizeMessageContent({ type: 'text', text: 'hi there' })).toBe(
      'hi there',
    );
  });

  it('returns "" for null/undefined', () => {
    expect(normalizeMessageContent(null)).toBe('');
    expect(normalizeMessageContent(undefined)).toBe('');
  });

  it('returns "" for non-text objects and other junk', () => {
    expect(normalizeMessageContent({ foo: 'bar' })).toBe('');
    expect(normalizeMessageContent(42)).toBe('');
    expect(
      normalizeMessageContent({ type: 'image_url', image_url: { url: 'x' } }),
    ).toBe('');
  });
});

describe('normalizeMessagesForAPI', () => {
  it('coerces invalid content in-place and leaves other fields untouched', () => {
    const messages = [
      {
        role: 'user' as const,
        content: 'hello',
        messageType: MessageType.TEXT,
      },
      {
        role: 'assistant' as const,
        // Simulate a corrupted historical message
        content: null as unknown as string,
        messageType: MessageType.TEXT,
      },
      {
        role: 'assistant' as const,
        content: { type: 'text', text: 'legacy-bare-object' } as never,
        messageType: MessageType.TEXT,
        citations: [],
      },
    ];

    const result = normalizeMessagesForAPI(messages);

    expect(result[0].content).toBe('hello');
    expect(result[1].content).toBe('');
    expect(result[2].content).toBe('legacy-bare-object');
    expect(result[2].citations).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const messages = [
      {
        role: 'user' as const,
        content: null as unknown as string,
        messageType: MessageType.TEXT,
      },
    ];
    const result = normalizeMessagesForAPI(messages);
    expect(messages[0].content).toBeNull();
    expect(result[0].content).toBe('');
  });
});
