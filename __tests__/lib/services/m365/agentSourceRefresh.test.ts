/**
 * Phase 3 refresh planning: delta merge into the last listing, outcome
 * carry-over by eTag, and refreshSourcePlan's delta-link / fallback paths.
 */
import { NextRequest } from 'next/server';

import type {
  M365ManifestFolder,
  M365ManifestItem,
} from '@/lib/services/agentAccess/types';
import {
  applyDeltaToListing,
  carryOverOutcomes,
  refreshSourcePlan,
} from '@/lib/services/m365/agentSourcePlanner';

import { getGraphAccessToken } from '@/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({ getGraphAccessToken: vi.fn() }));

const fetchMock = vi.fn();
const req = new NextRequest('http://localhost/api/x');

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function item(
  itemId: string,
  overrides: Partial<M365ManifestItem> = {},
): M365ManifestItem {
  return {
    itemId,
    driveId: 'd',
    name: `${itemId}.pdf`,
    path: '',
    parentItemId: 'root',
    size: 10,
    eTag: `"${itemId}-v1"`,
    webUrl: '',
    tier: 'indexable',
    status: 'indexed',
    indexedChunks: 2,
    ...overrides,
  };
}

const baseFolders: M365ManifestFolder[] = [
  { itemId: 'sub', name: 'Sub', path: 'Sub', parentItemId: 'root' },
  { itemId: 'deep', name: 'Deep', path: 'Sub/Deep', parentItemId: 'sub' },
];
const baseItems: M365ManifestItem[] = [
  item('a'),
  item('b', { parentItemId: 'sub', path: 'Sub' }),
  item('c', { parentItemId: 'deep', path: 'Sub/Deep' }),
  item('x', {
    name: 'x.zip',
    tier: 'skipped',
    reason: 'disallowedType',
    status: undefined,
  }),
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(getGraphAccessToken).mockResolvedValue({
    accessToken: 'tok',
    grantedScopes: [],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('applyDeltaToListing', () => {
  it('applies adds, updates, deletes, folder renames and out-of-scope moves', () => {
    const merged = applyDeltaToListing(
      { folders: baseFolders, items: baseItems },
      'root',
      'd',
      [
        { id: 'root', name: 'Root', folder: {} },
        // renamed folder → children paths follow
        {
          id: 'sub',
          name: 'Renamed',
          folder: {},
          parentReference: { id: 'root' },
        },
        // updated file
        {
          id: 'a',
          name: 'a.pdf',
          size: 11,
          eTag: '"a-v2"',
          file: {},
          parentReference: { id: 'root' },
        },
        // new file in the deep folder
        {
          id: 'n',
          name: 'n.docx',
          size: 5,
          eTag: '"n"',
          file: {},
          parentReference: { id: 'deep' },
        },
        // deleted file
        { id: 'b', name: 'b.pdf', deleted: {} },
        // deleted subtree: folder 'deep' gone → 'c' and 'n' are unreachable
        // (simulated by moving it out of scope)
        {
          id: 'deep',
          name: 'Deep',
          folder: {},
          parentReference: { id: 'elsewhere' },
        },
      ],
    );
    expect(merged.folders).toEqual([
      { itemId: 'sub', name: 'Renamed', path: 'Renamed', parentItemId: 'root' },
    ]);
    expect(
      merged.items.map((i) => [i.itemId, i.path, i.eTag ?? '', i.tier]),
    ).toEqual([
      ['a', '', '"a-v2"', 'indexable'],
      ['x', '', '"x-v1"', 'skipped'],
    ]);
  });

  it('re-derives raw tiers so a lifted exclusion un-skips an item', () => {
    const merged = applyDeltaToListing(
      {
        folders: baseFolders,
        items: [
          item('e', { tier: 'skipped', reason: 'excluded', status: undefined }),
        ],
      },
      'root',
      'd',
      [],
    );
    expect(merged.items[0]).toMatchObject({ itemId: 'e', tier: 'indexable' });
    expect(merged.items[0].reason).toBeUndefined();
  });
});

describe('carryOverOutcomes', () => {
  it('keeps settled outcomes for unchanged eTags and re-queues the rest', () => {
    const next = [
      item('a', { status: undefined, indexedChunks: undefined }), // unchanged
      item('a2', { eTag: '"a2-v2"', status: undefined }), // modified
      item('f', { status: undefined }), // was failed → retry
      item('new', { status: undefined }), // added
      item('gone-type', {
        name: 'g.mp4',
        tier: 'needsPreparation',
        status: undefined,
      }),
    ];
    const base = [
      item('a'),
      item('a2', { eTag: '"a2-v1"' }),
      item('f', { status: 'failed', indexedChunks: 0, error: 'boom' }),
      item('gone-type'),
      item('deleted'),
    ];
    const { items, changes } = carryOverOutcomes(next, base);
    const byId = Object.fromEntries(items.map((i) => [i.itemId, i.status]));
    expect(byId).toEqual({
      a: 'indexed',
      a2: 'pending',
      f: 'pending',
      new: 'pending',
      'gone-type': undefined,
    });
    expect(items.find((i) => i.itemId === 'a')?.indexedChunks).toBe(2);
    expect(changes).toEqual({
      added: 1,
      modified: 2,
      removed: 2,
      unchanged: 1,
    });
  });
});

describe('refreshSourcePlan', () => {
  const input = {
    driveId: 'd',
    itemId: 'root',
    kind: 'folder' as const,
    recursive: true,
  };

  it('follows the stored delta link and carries outcomes — no full walk', async () => {
    fetchMock.mockImplementation((url: string) => {
      expect(url).toBe('https://graph.microsoft.com/v1.0/delta?token=old');
      return Promise.resolve(
        json({
          value: [
            { id: 'root', name: 'Root', folder: {} },
            {
              id: 'a',
              name: 'a.pdf',
              size: 12,
              eTag: '"a-v2"',
              file: {},
              parentReference: { id: 'root' },
            },
          ],
          '@odata.deltaLink':
            'https://graph.microsoft.com/v1.0/delta?token=new',
        }),
      );
    });
    const plan = await refreshSourcePlan(req, input, {
      deltaLink: 'https://graph.microsoft.com/v1.0/delta?token=old',
      truncated: false,
      folders: baseFolders,
      items: baseItems,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(plan.incremental).toBe(true);
    expect(plan.deltaLink).toContain('token=new');
    expect(plan.changes).toEqual({
      added: 0,
      modified: 1,
      removed: 0,
      unchanged: 2,
    });
    const statuses = Object.fromEntries(
      plan.items.map((i) => [i.itemId, i.status]),
    );
    expect(statuses).toEqual({
      a: 'pending',
      b: 'indexed',
      c: 'indexed',
      x: undefined,
    });
    expect(plan.counts.indexable).toBe(3);
  });

  it('falls back to a full walk when the delta link is rejected (resync)', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('token=old')) {
        return Promise.resolve(
          json({ error: { code: 'resyncRequired', message: 'gone' } }, 410),
        );
      }
      expect(url).toContain('/items/root/delta');
      return Promise.resolve(
        json({
          value: [
            {
              id: 'a',
              name: 'a.pdf',
              size: 10,
              eTag: '"a-v1"',
              file: {},
              parentReference: { id: 'root' },
            },
          ],
          '@odata.deltaLink':
            'https://graph.microsoft.com/v1.0/delta?token=fresh',
        }),
      );
    });
    const plan = await refreshSourcePlan(req, input, {
      deltaLink: 'https://graph.microsoft.com/v1.0/delta?token=old',
      truncated: false,
      folders: baseFolders,
      items: baseItems,
    });
    expect(plan.incremental).toBe(false);
    expect(plan.deltaLink).toContain('token=fresh');
    // 'a' unchanged (same eTag) keeps its outcome; b and c vanished.
    expect(plan.changes).toEqual({
      added: 0,
      modified: 0,
      removed: 2,
      unchanged: 1,
    });
    expect(plan.items.map((i) => i.itemId)).toEqual(['a']);
  });

  it('re-lists non-recursive folders in full and still carries outcomes', async () => {
    fetchMock.mockImplementation((url: string) => {
      expect(url).toContain('/children');
      return Promise.resolve(
        json({
          value: [
            {
              id: 'a',
              name: 'a.pdf',
              size: 10,
              eTag: '"a-v1"',
              file: {},
              parentReference: { id: 'root' },
            },
            {
              id: 'z',
              name: 'z.pdf',
              size: 3,
              eTag: '"z"',
              file: {},
              parentReference: { id: 'root' },
            },
          ],
        }),
      );
    });
    const plan = await refreshSourcePlan(
      req,
      { ...input, recursive: false },
      { truncated: false, folders: [], items: [item('a')] },
    );
    expect(plan.incremental).toBe(false);
    expect(plan.changes).toEqual({
      added: 1,
      modified: 0,
      removed: 0,
      unchanged: 1,
    });
  });

  it('propagates a lost session instead of silently re-walking', async () => {
    vi.mocked(getGraphAccessToken).mockResolvedValue({
      error: 'No refresh token available',
    } as never);
    await expect(
      refreshSourcePlan(req, input, {
        deltaLink: 'https://graph.microsoft.com/v1.0/delta?token=old',
        truncated: false,
        folders: [],
        items: [],
      }),
    ).rejects.toMatchObject({ kind: 'not_connected' });
  });
});
