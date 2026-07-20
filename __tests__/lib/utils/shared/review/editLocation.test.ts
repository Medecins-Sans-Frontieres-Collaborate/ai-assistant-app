import {
  locateEdits,
  resolvePreviewText,
  stripMarkdownMarkers,
} from '@/lib/utils/shared/review/editLocation';

import { describe, expect, it } from 'vitest';

describe('locateEdits', () => {
  it('locates each edit at its occurrence', () => {
    const text = 'The quick brown fox jumps over the lazy dog.';
    expect(
      locateEdits(text, [
        { id: 'a', before: 'quick' },
        { id: 'b', before: 'lazy dog' },
      ]),
    ).toEqual([
      { id: 'a', start: 4, end: 9 },
      { id: 'b', start: 35, end: 43 },
    ]);
  });

  it('returns spans sorted by position regardless of input order', () => {
    const text = 'alpha beta gamma';
    const located = locateEdits(text, [
      { id: 'late', before: 'gamma' },
      { id: 'early', before: 'alpha' },
    ]);
    expect(located.map((l) => l.id)).toEqual(['early', 'late']);
  });

  it('gives two edits with the same before distinct occurrences', () => {
    const text = 'cost is cost';
    const located = locateEdits(text, [
      { id: 'a', before: 'cost' },
      { id: 'b', before: 'cost' },
    ]);
    expect(located).toHaveLength(2);
    expect(located[0]).toEqual({ id: 'a', start: 0, end: 4 });
    expect(located[1]).toEqual({ id: 'b', start: 8, end: 12 });
  });

  it('leaves an edit unlocated when its only occurrence is claimed', () => {
    const located = locateEdits('cost', [
      { id: 'a', before: 'cost' },
      { id: 'b', before: 'cost' },
    ]);
    expect(located.map((l) => l.id)).toEqual(['a']);
  });

  it('never returns overlapping spans', () => {
    const located = locateEdits('abcdef', [
      { id: 'a', before: 'abcd' },
      { id: 'b', before: 'cdef' },
    ]);
    expect(located).toHaveLength(1);
    expect(located[0].id).toBe('a');
  });

  it('skips edits that are absent or empty', () => {
    expect(
      locateEdits('hello world', [
        { id: 'missing', before: 'goodbye' },
        { id: 'empty', before: '' },
        { id: 'found', before: 'world' },
      ]).map((l) => l.id),
    ).toEqual(['found']);
  });

  it('handles no edits and empty text', () => {
    expect(locateEdits('text', [])).toEqual([]);
    expect(locateEdits('', [{ id: 'a', before: 'x' }])).toEqual([]);
  });
});

describe('stripMarkdownMarkers', () => {
  it('removes inline emphasis and code markers', () => {
    expect(stripMarkdownMarkers('**Total** is `42` and _final_')).toBe(
      'Total is 42 and final',
    );
  });

  it('removes leading block markers per line', () => {
    expect(stripMarkdownMarkers('## Heading\n- item\n> quote\n1. first')).toBe(
      'Heading\nitem\nquote\nfirst',
    );
  });
});

describe('resolvePreviewText', () => {
  it('prefers the raw form when it appears verbatim', () => {
    expect(resolvePreviewText('a **b** c', '**b**', '**B**')).toEqual({
      before: '**b**',
      after: '**B**',
    });
  });

  it('strips both sides together when only the stripped form appears', () => {
    // Diffing a stripped `before` against a raw `after` would render
    // phantom `**` insertions in the preview.
    expect(
      resolvePreviewText('the Total line', '**Total**', '**Sum**'),
    ).toEqual({ before: 'Total', after: 'Sum' });
  });

  it('returns null when neither form is findable', () => {
    expect(resolvePreviewText('hello', '**absent**', 'x')).toBeNull();
    expect(resolvePreviewText('hello', '', 'x')).toBeNull();
  });
});
