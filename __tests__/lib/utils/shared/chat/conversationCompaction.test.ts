import { getCompactionBoundary } from '@/lib/utils/shared/chat/conversationCompaction';
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

describe('getCompactionBoundary', () => {
  it('returns 0 when under the limit', () => {
    expect(getCompactionBoundary(makeMessages(10), 80)).toBe(0);
  });

  it('returns 0 when exactly at the limit', () => {
    expect(getCompactionBoundary(makeMessages(80), 80)).toBe(0);
  });

  it('returns 0 when maxMessages <= 0 (windowing disabled)', () => {
    expect(getCompactionBoundary(makeMessages(100), 0)).toBe(0);
    expect(getCompactionBoundary(makeMessages(100), -5)).toBe(0);
  });

  it('returns the window start when the tail begins with a user message', () => {
    // 10 msgs @ 5: tail = slice(-4) starts at index 6 (user, even) — no orphan
    expect(getCompactionBoundary(makeMessages(10), 5)).toBe(6);
  });

  it('moves past an orphaned assistant at the window start', () => {
    // 10 msgs @ 4: tail = slice(-3) starts at index 7 (assistant) → dropped
    expect(getCompactionBoundary(makeMessages(10), 4)).toBe(8);
  });

  it('matches the default-window drop (100 msgs @ 80 → boundary 22)', () => {
    // Window start 21 is an assistant (odd) → orphan dropped → boundary 22,
    // mirroring the 79-message result asserted in messageWindowing.test.ts
    expect(getCompactionBoundary(makeMessages(100), 80)).toBe(22);
  });

  it('can reach messages.length when the entire tail is an orphaned assistant', () => {
    // 10 msgs @ 2: tail = slice(-1) = [msg9 (assistant)] → dropped; window
    // keeps only messages[0], so everything after 0 is "dropped middle"
    expect(getCompactionBoundary(makeMessages(10), 2)).toBe(10);
  });

  it('handles the degenerate maxMessages === 1 window', () => {
    // windowMessagesForAPI keeps only the last message (message 0 included
    // in the drop); boundary is the last index
    expect(getCompactionBoundary(makeMessages(10), 1)).toBe(9);
  });

  it('agrees with windowMessagesForAPI on drop count and window start (parity)', () => {
    for (const total of [10, 50, 51, 100, 101, 150, 151]) {
      for (const maxN of [2, 4, 5, 20, 30, 80]) {
        const messages = makeMessages(total);
        const boundary = getCompactionBoundary(messages, maxN);
        const windowed = windowMessagesForAPI(messages, maxN);
        const dropped = messages.length - windowed.length;

        if (boundary === 0) {
          expect(dropped).toBe(0);
          continue;
        }
        // Window = messages[0] + tail starting at `boundary`, so the dropped
        // middle is exactly messages 1..boundary-1
        expect(boundary - 1).toBe(dropped);
        if (boundary < messages.length) {
          expect(windowed[1]).toBe(messages[boundary]);
        } else {
          expect(windowed).toHaveLength(1);
        }
      }
    }
  });
});
