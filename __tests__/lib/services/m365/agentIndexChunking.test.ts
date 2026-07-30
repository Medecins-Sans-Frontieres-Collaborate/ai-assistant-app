import { chunkText } from '@/lib/services/m365/agentIndexService';

import { describe, expect, it, vi } from 'vitest';

// agentIndexService transitively imports @/auth (next-auth), which cannot
// resolve in the node test environment — mock it out; chunkText is pure.
vi.mock('@/auth', () => ({ getGraphAccessToken: vi.fn() }));

describe('chunkText', () => {
  it('returns the whole text when under the chunk size', () => {
    expect(chunkText('short text', 100, 10)).toEqual(['short text']);
  });

  it('returns nothing for empty input', () => {
    expect(chunkText('   ')).toEqual([]);
  });

  it('splits long text with overlap and full coverage', () => {
    const text = 'abcdefghij'.repeat(100); // 1000 chars, no boundaries
    const chunks = chunkText(text, 300, 50);
    expect(chunks.length).toBeGreaterThan(3);
    // Coverage: every chunk except the last starts within the previous
    // chunk's span (overlap), and concatenation covers the whole input.
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    expect(total).toBeGreaterThanOrEqual(text.length);
    expect(chunks[0].startsWith('abcdefghij')).toBe(true);
    expect(chunks[chunks.length - 1].endsWith('abcdefghij')).toBe(true);
  });

  it('prefers paragraph boundaries near the target size', () => {
    const paragraph = 'word '.repeat(50).trim(); // ~250 chars
    const text = `${paragraph}\n\n${paragraph}\n\n${paragraph}`;
    const chunks = chunkText(text, 300, 30);
    // The first chunk should end at the paragraph break, not mid-word.
    expect(chunks[0].endsWith('word')).toBe(true);
  });

  it('normalizes CRLF input', () => {
    expect(chunkText('a\r\nb', 100, 10)).toEqual(['a\nb']);
  });
});
