import { applyClaimQuotes } from '@/lib/utils/app/citationQuotes';

import { Citation } from '@/types/rag';

import { describe, expect, it } from 'vitest';

const SOURCE =
  'The company grants twenty-five (25) days of annual leave. “Carry-over” of unused days — up to five — requires manager approval.';

function citation(number: number, quote?: string): Citation {
  return {
    title: 'Handbook',
    date: '',
    url: 'https://x/handbook.pdf',
    number,
    ...(quote ? { quote } : {}),
  };
}

describe('applyClaimQuotes', () => {
  it('applies a quote that matches verbatim', () => {
    const result = applyClaimQuotes(
      [citation(1, 'fallback')],
      { '1': 'grants twenty-five (25) days of annual leave' },
      { '1': SOURCE },
    );
    expect(result[0].quote).toBe(
      'grants twenty-five (25) days of annual leave',
    );
  });

  it('normalizes curly quotes, dashes, and whitespace before matching', () => {
    const result = applyClaimQuotes(
      [citation(1, 'fallback')],
      // Straight quotes + hyphen + collapsed spacing vs the source's
      // typographic characters.
      {
        '1': '"Carry-over" of unused days - up to five - requires manager approval.',
      },
      { '1': SOURCE },
    );
    expect(result[0].quote).toBe(
      '"Carry-over" of unused days - up to five - requires manager approval.',
    );
  });

  it('rejects quotes not present in the source', () => {
    const result = applyClaimQuotes(
      [citation(1, 'fallback')],
      { '1': 'employees receive thirty days of leave' },
      { '1': SOURCE },
    );
    expect(result[0].quote).toBe('fallback');
  });

  it('rejects degenerate and oversized quotes', () => {
    const result = applyClaimQuotes(
      [citation(1, 'fallback'), citation(2, 'fallback2')],
      { '1': 'days', '2': 'x'.repeat(700) },
      { '1': SOURCE, '2': 'x'.repeat(700) },
    );
    expect(result[0].quote).toBe('fallback');
    expect(result[1].quote).toBe('fallback2');
  });

  it('is a no-op without both inputs', () => {
    const citations = [citation(1, 'fallback')];
    expect(applyClaimQuotes(citations, null, { '1': SOURCE })).toBe(citations);
    expect(applyClaimQuotes(citations, { '1': 'grants' }, null)).toBe(
      citations,
    );
  });
});
