/**
 * Ranking semantics for drive search: tier assignment (token-aware +
 * fuzzy), recency ordering within tiers, and the filename-query merge.
 */
import {
  mergeSearchResults,
  nameMatchTier,
  rankSearchEntries,
} from '@/lib/services/m365/driveSearch';

import type { M365DriveEntry } from '@/types/m365';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({ getGraphAccessToken: vi.fn() }));

function entry(
  itemId: string,
  name: string,
  lastModified?: string,
): M365DriveEntry {
  return {
    driveId: 'd1',
    itemId,
    name,
    isFolder: false,
    ...(lastModified && { lastModified }),
  };
}

describe('nameMatchTier', () => {
  it('assigns tiers by match quality', () => {
    expect(nameMatchTier('geo.pptx', 'geo.pptx')).toBe(0);
    expect(nameMatchTier('geo.pptx', 'geo')).toBe(1);
    expect(nameMatchTier('geo_report_v2.pptx', 'geo report')).toBe(2);
    expect(nameMatchTier('my-geo-notes.txt', 'geo')).toBe(2);
    expect(nameMatchTier('theogeon.txt', 'geo')).toBe(3);
    expect(nameMatchTier('budget.xlsx', 'budgte')).toBe(4);
    expect(nameMatchTier('minutes.docx', 'geo')).toBe(5);
  });

  it('needs 4+ chars before fuzzy fires', () => {
    // 'geo' vs 'gio' is 1 edit but the query is too short to trust.
    expect(nameMatchTier('gio.txt', 'geo')).toBe(5);
    expect(nameMatchTier('giorgio.txt', 'georgio')).toBe(4);
  });
});

describe('rankSearchEntries', () => {
  it('sorts by tier, then recency desc, then stable input order', () => {
    const ranked = rankSearchEntries(
      [
        entry('old-token', 'geo-old.txt', '2024-01-01T00:00:00Z'),
        entry('content', 'minutes.docx', '2026-07-30T00:00:00Z'),
        entry('new-token', 'geo-new.txt', '2026-07-01T00:00:00Z'),
        entry('exact', 'geo', '2020-01-01T00:00:00Z'),
      ],
      'geo',
    );
    expect(ranked.map((e) => e.itemId)).toEqual([
      // Exact beats everything despite being oldest; within the token tier
      // the newer file wins; content matches sink.
      'exact',
      'new-token',
      'old-token',
      'content',
    ]);
    expect(ranked.map((e) => e.match)).toEqual([
      'name',
      'name',
      'name',
      'content',
    ]);
  });
});

describe('mergeSearchResults', () => {
  it('puts filename hits first and dedupes against the content window', () => {
    const nameHits = [entry('a', 'geo.pptx', '2026-01-01T00:00:00Z')];
    const window = [
      entry('a', 'geo.pptx', '2026-01-01T00:00:00Z'),
      entry('b', 'minutes.docx', '2026-07-01T00:00:00Z'),
    ];
    const merged = mergeSearchResults(nameHits, window, 'geo');
    expect(merged.map((e) => e.itemId)).toEqual(['a', 'b']);
    expect(merged[0].match).toBe('name');
    expect(merged[1].match).toBe('content');
  });
});
