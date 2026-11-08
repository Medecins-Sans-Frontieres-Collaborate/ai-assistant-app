import {
  extractJsonObject,
  fallbackDecisionMaxTokens,
  toAnthropicMessages,
} from '@/lib/services/chat/routing/structuredDecisionFallback';

import { describe, expect, it } from 'vitest';

describe('extractJsonObject', () => {
  it('returns a bare object unchanged', () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it('strips reasoning, fences and preamble', () => {
    expect(
      extractJsonObject(
        '<think>maybe {"no":1}</think>\nHere you go:\n```json\n{"a":{"b":2}}\n```',
      ),
    ).toBe('{"a":{"b":2}}');
  });

  it('returns undefined for text with no valid object', () => {
    expect(extractJsonObject('no decision')).toBeUndefined();
    expect(extractJsonObject('{not json}')).toBeUndefined();
    expect(extractJsonObject(null)).toBeUndefined();
  });
});

describe('toAnthropicMessages', () => {
  it('separates system text and merges same-role turns', () => {
    expect(
      toAnthropicMessages([
        { role: 'system', content: 'route' },
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
        { role: 'assistant', content: 'c' },
      ]),
    ).toEqual({
      system: 'route',
      messages: [
        { role: 'user', content: 'a\n\nb' },
        { role: 'assistant', content: 'c' },
      ],
    });
  });

  it('starts with a user turn even when history opens with the assistant', () => {
    const { messages } = toAnthropicMessages([
      { role: 'assistant', content: 'earlier answer' },
      { role: 'user', content: 'now this' },
    ]);
    expect(messages[0].role).toBe('user');
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });
});

describe('fallbackDecisionMaxTokens', () => {
  it('gives a chat model several times the auxiliary budget, at least 2000', () => {
    expect(fallbackDecisionMaxTokens(290, undefined)).toBe(2000);
    expect(fallbackDecisionMaxTokens(800, undefined)).toBe(3200);
  });

  it('never exceeds the model limit', () => {
    expect(fallbackDecisionMaxTokens(800, 1024)).toBe(1024);
  });
});
