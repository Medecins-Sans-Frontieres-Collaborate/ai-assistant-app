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

    // Orphaned assistant at index 21 is dropped, so 1 + 78 = 79
    expect(result).toHaveLength(79);
    // First message is preserved
    expect(result[0]).toEqual(messages[0]);
    // Last 78 messages are preserved (tail starts at user index 22)
    expect(result.slice(1)).toEqual(messages.slice(-78));
  });

  it('preserves the first message (initial context)', () => {
    const messages = makeMessages(150);
    messages[0].content = 'Important initial context';

    const result = windowMessagesForAPI(messages, 50);

    expect(result[0].content).toBe('Important initial context');
    // Orphaned assistant at index 101 is dropped → 1 + 48 = 49
    expect(result).toHaveLength(49);
  });

  it('preserves the most recent messages', () => {
    const messages = makeMessages(120);
    const result = windowMessagesForAPI(messages, 30);

    // Orphaned assistant at index 91 is dropped, tail starts at user index 92
    expect(result.slice(1)).toEqual(messages.slice(-28));
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

    // Default is CLIENT_MAX_MESSAGES (80), orphaned assistant dropped → 79
    expect(result).toHaveLength(79);
    expect(result[0]).toEqual(messages[0]);
    expect(result.slice(1)).toEqual(messages.slice(-78));
  });

  it('drops orphaned assistant at window boundary', () => {
    const messages = makeMessages(10); // 0=user,1=asst,...,9=asst
    const result = windowMessagesForAPI(messages, 4);
    // Naive tail: messages.slice(-3) = [msg7(asst), msg8(user), msg9(asst)]
    // After fix: drops msg7(asst), tail = [msg8(user), msg9(asst)]
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(messages[0]); // first user preserved
    expect(result[1]).toEqual(messages[8]); // tail starts with user
    expect(result[2]).toEqual(messages[9]);
  });

  it('does not drop when tail already starts with user', () => {
    const messages = makeMessages(10);
    const result = windowMessagesForAPI(messages, 5);
    // Tail: messages.slice(-4) = [msg6(user), msg7(asst), msg8(user), msg9(asst)]
    // msg6 is user (even index), no drop needed
    expect(result).toHaveLength(5);
    expect(result[0]).toEqual(messages[0]);
    expect(result[1]).toEqual(messages[6]);
  });

  it('tail always starts with a user message across multiple sizes', () => {
    for (const total of [50, 51, 100, 101, 150, 151]) {
      const messages = makeMessages(total);
      const result = windowMessagesForAPI(messages, 20);
      expect(result[0].role).toBe('user'); // first message
      expect(result[1].role).toBe('user'); // tail must start with user
    }
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
