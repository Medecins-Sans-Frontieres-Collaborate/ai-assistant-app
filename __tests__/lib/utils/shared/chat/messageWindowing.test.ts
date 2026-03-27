import { windowMessagesForAPI } from '@/lib/utils/shared/chat/messageWindowing';

import { Message } from '@/types/chat';

function makeMessage(
  index: number,
  role: 'user' | 'assistant' = 'user',
): Message {
  return {
    role,
    content: `Message ${index}`,
  };
}

function makeMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, i) =>
    makeMessage(i, i % 2 === 0 ? 'user' : 'assistant'),
  );
}

describe('windowMessagesForAPI', () => {
  it('returns messages unchanged when under the limit', () => {
    const messages = makeMessages(10);
    const result = windowMessagesForAPI(messages, 80);
    expect(result).toBe(messages); // Same reference, not a copy
  });

  it('returns messages unchanged when exactly at the limit', () => {
    const messages = makeMessages(80);
    const result = windowMessagesForAPI(messages, 80);
    expect(result).toBe(messages);
  });

  it('windows messages when over the limit', () => {
    const messages = makeMessages(100);
    const result = windowMessagesForAPI(messages, 80);

    expect(result).toHaveLength(80);
    // First message is preserved
    expect(result[0]).toEqual(messages[0]);
    // Last 79 messages are preserved
    expect(result.slice(1)).toEqual(messages.slice(-79));
  });

  it('preserves the first message (initial context)', () => {
    const messages = makeMessages(150);
    messages[0].content = 'Important initial context';

    const result = windowMessagesForAPI(messages, 50);

    expect(result[0].content).toBe('Important initial context');
    expect(result).toHaveLength(50);
  });

  it('preserves the most recent messages', () => {
    const messages = makeMessages(120);
    const result = windowMessagesForAPI(messages, 30);

    // Last 29 messages should be the most recent
    expect(result.slice(1)).toEqual(messages.slice(-29));
  });

  it('handles single message', () => {
    const messages = makeMessages(1);
    const result = windowMessagesForAPI(messages, 80);
    expect(result).toBe(messages);
    expect(result).toHaveLength(1);
  });

  it('handles two messages with limit of 1', () => {
    const messages = makeMessages(2);
    const result = windowMessagesForAPI(messages, 1);

    // With maxMessages=1, keep only the most recent message
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(messages[1]);
  });

  it('uses default CLIENT_MAX_MESSAGES when no limit specified', () => {
    const messages = makeMessages(100);
    const result = windowMessagesForAPI(messages);

    // Default is CLIENT_MAX_MESSAGES (80), so 100 > 80 triggers windowing
    expect(result).toHaveLength(80);
    expect(result[0]).toEqual(messages[0]);
    expect(result.slice(1)).toEqual(messages.slice(-79));
  });

  it('drops middle messages, not endpoints', () => {
    const messages = makeMessages(10);
    const result = windowMessagesForAPI(messages, 5);

    expect(result).toHaveLength(5);
    // First message preserved
    expect(result[0]).toEqual(messages[0]);
    // Messages 1-5 are dropped (indices 1 through 5)
    // Messages 6-9 are kept (last 4)
    expect(result[1]).toEqual(messages[6]);
    expect(result[4]).toEqual(messages[9]);
  });
});
