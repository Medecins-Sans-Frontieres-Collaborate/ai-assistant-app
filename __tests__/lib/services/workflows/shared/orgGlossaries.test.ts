import {
  requestedGuideIds,
  resolveOrgGlossaries,
} from '@/lib/services/workflows/shared/orgGlossaries';

import { describe, expect, it, vi } from 'vitest';

const mockResolveSlotGuide = vi.hoisted(() => vi.fn());
vi.mock('@/lib/services/workflows/shared/guideResolution', () => ({
  resolveSlotGuide: mockResolveSlotGuide,
}));

const A = 'guide-aaaaaaaaaaaa';
const B = 'guide-bbbbbbbbbbbb';
const C = 'guide-cccccccccccc';
const D = 'guide-dddddddddddd';

describe('requestedGuideIds', () => {
  it('prefers the array, deduped and order-preserving', () => {
    expect(
      requestedGuideIds({ glossaryGuideIds: [B, A, B], glossaryGuideId: C }),
    ).toEqual([B, A]);
  });

  it('falls back to the legacy single id', () => {
    expect(requestedGuideIds({ glossaryGuideId: A })).toEqual([A]);
    expect(requestedGuideIds({})).toEqual([]);
  });

  it('drops malformed ids rather than passing them to the resolver', () => {
    expect(
      requestedGuideIds({ glossaryGuideIds: ['../x', 42, ` ${A} `] }),
    ).toEqual([A]);
  });

  it('reports more than the cap as a client error', () => {
    expect(requestedGuideIds({ glossaryGuideIds: [A, B, C, D] })).toBeNull();
    expect(requestedGuideIds({ glossaryGuideIds: [A, B, C] })).toHaveLength(3);
  });
});

describe('resolveOrgGlossaries', () => {
  it('concatenates entries in request order (first guide wins on merge)', async () => {
    mockResolveSlotGuide.mockImplementation(async ({ guideId }) => ({
      guide: {
        payload: {
          kind: 'terminology',
          entries: [{ source: 'IDP', target: `from-${guideId}` }],
        },
      },
    }));
    const result = await resolveOrgGlossaries('u@example.com', [A, B]);
    expect(result).toEqual({
      entries: [
        { source: 'IDP', target: `from-${A}` },
        { source: 'IDP', target: `from-${B}` },
      ],
    });
  });

  it('fails the whole request when any guide fails to resolve', async () => {
    mockResolveSlotGuide
      .mockResolvedValueOnce({
        guide: { payload: { kind: 'terminology', entries: [] } },
      })
      .mockResolvedValueOnce({ error: 'Guide is not available' });
    expect(await resolveOrgGlossaries(undefined, [A, B])).toEqual({
      error: 'Guide is not available',
    });
  });
});
