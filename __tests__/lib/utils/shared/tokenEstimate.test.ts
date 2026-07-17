import {
  CHARS_PER_TOKEN,
  estimateMessageTokens,
  estimateTokensFromText,
} from '@/lib/utils/shared/tokenEstimate';

import { describe, expect, it } from 'vitest';

describe('estimateTokensFromText', () => {
  it('applies the chars-per-token heuristic, rounding up', () => {
    expect(estimateTokensFromText('a'.repeat(4 * CHARS_PER_TOKEN))).toBe(4);
    expect(estimateTokensFromText('a'.repeat(CHARS_PER_TOKEN + 1))).toBe(2);
  });

  it('returns 0 for empty text', () => {
    expect(estimateTokensFromText('')).toBe(0);
  });
});

describe('estimateMessageTokens', () => {
  it('handles plain string content', () => {
    expect(estimateMessageTokens('a'.repeat(8))).toBe(8 / CHARS_PER_TOKEN);
  });

  it('handles single text-content objects', () => {
    expect(estimateMessageTokens({ type: 'text', text: 'a'.repeat(8) })).toBe(
      8 / CHARS_PER_TOKEN,
    );
  });

  it('sums ALL text parts of mixed content, ignoring files/images', () => {
    expect(
      estimateMessageTokens([
        { type: 'text', text: 'a'.repeat(8) },
        {
          type: 'file_url',
          url: 'blob://x',
          name: 'f.pdf',
          type_: undefined,
        } as never,
        { type: 'text', text: 'b'.repeat(8) },
      ]),
    ).toBe(16 / CHARS_PER_TOKEN);
  });

  it('counts thinking text as completion output', () => {
    expect(estimateMessageTokens('a'.repeat(8), 'b'.repeat(8))).toBe(
      16 / CHARS_PER_TOKEN,
    );
  });

  it('returns 0 for content without text', () => {
    expect(estimateMessageTokens([])).toBe(0);
  });
});
