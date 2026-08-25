/**
 * Phase 4 planner integration: prepared files flip to indexable when the
 * eTag matches, and a preparation since the last run counts as a change.
 */
import type {
  M365DerivedIndexEntry,
  M365ManifestItem,
} from '@/lib/services/agentAccess/types';
import {
  applyPreparedItems,
  applySourceFilters,
  carryOverOutcomes,
} from '@/lib/services/m365/agentSourcePlanner';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({ getGraphAccessToken: vi.fn() }));

function item(
  itemId: string,
  overrides: Partial<M365ManifestItem> = {},
): M365ManifestItem {
  return {
    itemId,
    driveId: 'd',
    name: `${itemId}.png`,
    path: '',
    parentItemId: 'root',
    size: 10,
    eTag: `"${itemId}-v1"`,
    webUrl: '',
    tier: 'needsPreparation',
    ...overrides,
  };
}

const entry = (
  eTag: string,
  kind: M365DerivedIndexEntry['kind'] = 'image',
): M365DerivedIndexEntry => ({
  eTag,
  kind,
  preparedAt: '2026-08-25T12:00:00.000Z',
  chars: 500,
  name: 'x',
});

describe('applyPreparedItems', () => {
  it('flips prepared media to indexable, ignores stale preparations', () => {
    const out = applyPreparedItems(
      [
        item('img'),
        item('stale'),
        item('doc', { name: 'doc.pdf', tier: 'indexable' }),
      ],
      {
        img: entry('"img-v1"'),
        stale: entry('"stale-v0"'),
        doc: entry('"doc-v1"', 'pdfOcr'),
      },
    );
    expect(out[0]).toMatchObject({
      tier: 'indexable',
      prepared: { kind: 'image' },
    });
    expect(out[1]).toMatchObject({ tier: 'needsPreparation' });
    expect(out[1].prepared).toBeUndefined();
    // OCR'd PDF: indexable already, now with prepared text attached.
    expect(out[2]).toMatchObject({
      tier: 'indexable',
      prepared: { kind: 'pdfOcr' },
    });
  });

  it('does not un-skip excluded or type-filtered files', () => {
    const filtered = applySourceFilters([item('img')], [], {
      includeExtensions: ['pdf'],
    });
    const out = applyPreparedItems(filtered, { img: entry('"img-v1"') });
    expect(out[0]).toMatchObject({ tier: 'skipped', reason: 'typeFilter' });
  });

  it('is a no-op without a derived index', () => {
    const items = [item('img')];
    expect(applyPreparedItems(items, undefined)).toBe(items);
  });
});

describe('carryOverOutcomes with preparation', () => {
  it('re-queues an item prepared since the last run even though its eTag is unchanged', () => {
    const base = [
      item('img', { tier: 'indexable', status: 'noText', indexedChunks: 0 }),
    ];
    const next = applyPreparedItems([item('img')], { img: entry('"img-v1"') });
    const { items, changes } = carryOverOutcomes(next, base);
    expect(items[0].status).toBe('pending');
    expect(changes).toMatchObject({ modified: 1, unchanged: 0 });
  });

  it('keeps the outcome when the same preparation was already indexed', () => {
    const prepared = applyPreparedItems([item('img')], {
      img: entry('"img-v1"'),
    });
    const base = [
      { ...prepared[0], status: 'indexed' as const, indexedChunks: 3 },
    ];
    const { items, changes } = carryOverOutcomes(prepared, base);
    expect(items[0]).toMatchObject({ status: 'indexed', indexedChunks: 3 });
    expect(changes).toMatchObject({ unchanged: 1 });
  });
});
