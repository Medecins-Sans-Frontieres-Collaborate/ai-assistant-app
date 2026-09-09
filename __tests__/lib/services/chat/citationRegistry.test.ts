import { CitationRegistry } from '@/lib/services/chat/citationRegistry';

import { describe, expect, it } from 'vitest';

/**
 * The failure mode this guards against: short-form inline markers
 * (`【3:0†source】`, label only, no URL) each minted their own number next
 * to their annotation's — the text ended up citing [1][3][5] while the
 * real sources sat on [2][4][6], with URL-less phantom entries breaking
 * the client's source list.
 */
describe('CitationRegistry', () => {
  it('pairs a short-form marker with the annotation that follows it', () => {
    const registry = new CitationRegistry();

    const n1 = registry.registerMarker('【3:0†source】', 'source', '');
    const a1 = registry.registerAnnotation(
      'https://wiki.example/delhi',
      '2026 Delhi protests',
    );

    expect(n1).toBe(1);
    expect(a1).toBe(1);
    expect(registry.entries).toEqual([
      {
        number: 1,
        title: '2026 Delhi protests',
        url: 'https://wiki.example/delhi',
        date: '',
      },
    ]);
  });

  it('keeps interleaved marker/annotation pairs on sequential numbers', () => {
    const registry = new CitationRegistry();

    registry.registerMarker('【3:0†source】', 'source', '');
    registry.registerAnnotation('https://a.example', 'A');
    registry.registerMarker('【3:1†source】', 'source', '');
    registry.registerAnnotation('https://b.example', 'B');
    registry.registerMarker('【3:2†source】', 'source', '');
    registry.registerAnnotation('https://c.example', 'C');

    expect(registry.entries.map((c) => [c.number, c.url])).toEqual([
      [1, 'https://a.example'],
      [2, 'https://b.example'],
      [3, 'https://c.example'],
    ]);
  });

  it('pairs batched markers with batched annotations in order', () => {
    const registry = new CitationRegistry();

    registry.registerMarker('【1:0†source】', 'source', '');
    registry.registerMarker('【1:1†source】', 'source', '');
    registry.registerAnnotation('https://a.example', 'A');
    registry.registerAnnotation('https://b.example', 'B');

    expect(registry.entries.map((c) => [c.number, c.url, c.title])).toEqual([
      [1, 'https://a.example', 'A'],
      [2, 'https://b.example', 'B'],
    ]);
  });

  it('reuses the number when the same URL is cited again', () => {
    const registry = new CitationRegistry();

    registry.registerMarker('【1:0†source】', 'source', '');
    registry.registerAnnotation('https://a.example', 'A');
    const again = registry.registerAnnotation('https://a.example', 'A');
    const inline = registry.registerMarker(
      'https://a.example',
      'A',
      'https://a.example',
    );

    expect(again).toBe(1);
    expect(inline).toBe(1);
    expect(registry.entries).toHaveLength(1);
  });

  it('long-form markers (with URL) share the annotation number by URL key', () => {
    const registry = new CitationRegistry();

    const n = registry.registerMarker(
      'https://a.example',
      'Title A',
      'https://a.example',
    );
    const a = registry.registerAnnotation('https://a.example', 'Title A');

    expect(n).toBe(1);
    expect(a).toBe(1);
    expect(registry.entries).toHaveLength(1);
  });

  it('mints a fresh number for an annotation-only source', () => {
    const registry = new CitationRegistry();

    registry.registerMarker('【1:0†source】', 'source', '');
    registry.registerAnnotation('https://a.example', 'A');
    const standalone = registry.registerAnnotation('https://b.example', 'B');

    expect(standalone).toBe(2);
    expect(registry.entries).toHaveLength(2);
  });
});
