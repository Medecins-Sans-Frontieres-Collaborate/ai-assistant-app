import { trimBodyToByteBudget } from '@/lib/utils/shared/chat/bodyByteBudget';

import { Message } from '@/types/chat';

import { describe, expect, it } from 'vitest';

function userText(text: string): Message {
  return { role: 'user', content: text } as Message;
}

function assistantText(text: string): Message {
  return { role: 'assistant', content: text } as Message;
}

function userWithImage(text: string, imagePayload: string): Message {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      {
        type: 'image_url',
        image_url: { url: imagePayload, detail: 'auto' },
      },
    ],
  } as Message;
}

function makeBigBase64(byteCount: number): string {
  // A `data:image/...;base64,...` URL is dominated by its base64 payload.
  // Using a single character is enough — JSON.stringify counts every char.
  return `data:image/png;base64,${'A'.repeat(byteCount)}`;
}

describe('trimBodyToByteBudget', () => {
  it('returns the body unchanged when under budget', () => {
    const body = {
      model: 'm',
      messages: [userText('hi'), assistantText('hello')],
    };
    const { body: out, report } = trimBodyToByteBudget(body, 1_000_000);

    expect(out).toBe(body);
    expect(report.imagesStripped).toBe(0);
    expect(report.messagesDropped).toBe(0);
    expect(report.exceededBudget).toBe(false);
    expect(report.finalBytes).toBe(report.originalBytes);
  });

  it('strips images from older turns first, leaves current turn images intact', () => {
    const body = {
      model: 'm',
      messages: [
        userWithImage('look at this', makeBigBase64(2_000_000)),
        assistantText('I see it'),
        userWithImage('and this one', makeBigBase64(2_000_000)),
        assistantText('I see it too'),
        userText('what do they have in common?'),
      ],
    };

    const { body: out, report } = trimBodyToByteBudget(body, 100_000);

    // Both older-turn images should be stripped (placeholders inserted).
    expect(report.imagesStripped).toBeGreaterThan(0);
    expect(report.messagesDropped).toBe(0);
    expect(report.finalBytes).toBeLessThanOrEqual(100_000);
    expect(report.exceededBudget).toBe(false);

    // The latest user message (index 4) is preserved unchanged.
    expect(out.messages[4]).toEqual(body.messages[4]);

    // Older user turns no longer carry image_url blocks.
    const olderUserMsg = out.messages[0];
    if (Array.isArray(olderUserMsg.content)) {
      const hasImage = olderUserMsg.content.some(
        (item) => 'type' in item && item.type === 'image_url',
      );
      expect(hasImage).toBe(false);
    }
  });

  it('drops oldest non-anchor messages when image-stripping is insufficient', () => {
    // No images — only big text. Image phase is a no-op, phase 2 must drop.
    const big = 'x'.repeat(200_000);
    const body = {
      model: 'm',
      messages: [
        userText('first message — anchor'),
        assistantText(big),
        userText(big),
        assistantText(big),
        userText('latest user — anchor'),
      ],
    };

    const { body: out, report } = trimBodyToByteBudget(body, 250_000);

    expect(report.messagesDropped).toBeGreaterThan(0);
    expect(report.finalBytes).toBeLessThanOrEqual(250_000);
    expect(report.exceededBudget).toBe(false);

    // First message and latest user message are preserved.
    expect(out.messages[0]).toEqual(body.messages[0]);
    expect(out.messages[out.messages.length - 1]).toEqual(
      body.messages[body.messages.length - 1],
    );
  });

  it('preserves the first message and the latest user message as anchors', () => {
    const body = {
      model: 'm',
      messages: [
        userText('SYSTEM CONTEXT'),
        assistantText('a'.repeat(50_000)),
        userText('b'.repeat(50_000)),
        assistantText('c'.repeat(50_000)),
        userText('CURRENT QUESTION'),
      ],
    };

    const { body: out } = trimBodyToByteBudget(body, 5_000);

    expect(out.messages[0].content).toBe('SYSTEM CONTEXT');
    const last = out.messages[out.messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toBe('CURRENT QUESTION');
  });

  it('reports exceededBudget when the latest user turn alone is too big', () => {
    const body = {
      model: 'm',
      messages: [
        userText('first'),
        userWithImage('look', makeBigBase64(500_000)),
      ],
    };

    const { report } = trimBodyToByteBudget(body, 50_000);

    // Phase 1 can't strip images from the latest user message; phase 2 can't
    // drop the latest user message. So we surface exceededBudget=true and let
    // the server's existing error fire.
    expect(report.exceededBudget).toBe(true);
  });

  it('drops an orphaned assistant left at the boundary after phase 2', () => {
    const big = 'x'.repeat(200_000);
    const body = {
      model: 'm',
      messages: [
        userText('first'), // anchor 0
        assistantText('drop me'), // would leave next msg as boundary
        assistantText(big), // would be orphaned at boundary
        userText('latest'), // anchor end
      ],
    };

    const { body: out, report } = trimBodyToByteBudget(body, 50_000);

    // First message preserved, last preserved, no orphaned assistant after [0].
    expect(out.messages[0]).toEqual(body.messages[0]);
    expect(out.messages[out.messages.length - 1].role).toBe('user');
    if (out.messages.length >= 2) {
      expect(out.messages[1].role).not.toBe('assistant');
    }
    expect(report.messagesDropped).toBeGreaterThan(0);
  });

  it('does not mutate the input body or its messages array', () => {
    const messages = [
      userWithImage('look', makeBigBase64(500_000)),
      userText('current'),
    ];
    const body = { model: 'm', messages };
    const messagesSnapshot = [...messages];
    const originalContent = messages[0].content;

    trimBodyToByteBudget(body, 10_000);

    expect(body.messages).toBe(messages);
    expect(messages).toEqual(messagesSnapshot);
    expect(messages[0].content).toBe(originalContent);
  });
});
