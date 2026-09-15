import { assessPlannedSources } from '@/lib/services/m365/agentIndexService';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({ getGraphAccessToken: vi.fn() }));
vi.mock('@/config/environment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/environment')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      M365_AGENT_MAX_DOCUMENTS: 5,
      M365_AGENT_MAX_DOCUMENTS_CEILING: 8,
    },
  };
});

const item = (i: number, tier: 'indexable' | 'skipped' = 'indexable') =>
  ({
    itemId: `i${i}`,
    driveId: 'd',
    name: `f${i}.pdf`,
    size: 10,
    tier,
  }) as never;

describe('assessPlannedSources', () => {
  it('counts only indexable items against the effective cap', () => {
    const verdict = assessPlannedSources(
      [
        {
          sourceId: 's1',
          truncated: false,
          items: [item(1), item(2), item(3, 'skipped')],
        },
      ],
      { maxDocumentsOverride: undefined },
    );
    expect(verdict).toMatchObject({
      totalDocuments: 2,
      maxDocuments: 5,
      overCap: false,
      totalBytes: 20,
    });
    expect(verdict.truncatedSourceId).toBeUndefined();
  });

  it('reports over-cap against the override, bounded by the ceiling, and names a truncated source', () => {
    const items = Array.from({ length: 7 }, (_, i) => item(i));
    const raised = assessPlannedSources(
      [{ sourceId: 's1', truncated: false, items }],
      { maxDocumentsOverride: 7 },
    );
    expect(raised.overCap).toBe(false);
    const clamped = assessPlannedSources(
      [
        {
          sourceId: 's1',
          truncated: false,
          items: [...items, item(7), item(8)],
        },
      ],
      { maxDocumentsOverride: 50 },
    );
    expect(clamped).toMatchObject({ maxDocuments: 8, overCap: true });
    const truncated = assessPlannedSources(
      [
        { sourceId: 's1', truncated: false, items: [] },
        { sourceId: 's2', truncated: true, items: [] },
      ],
      { maxDocumentsOverride: undefined },
    );
    expect(truncated.truncatedSourceId).toBe('s2');
  });
});
