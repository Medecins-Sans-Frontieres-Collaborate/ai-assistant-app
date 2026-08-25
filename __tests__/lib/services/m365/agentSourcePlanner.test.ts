/**
 * Plan phase: metadata-only classification, exclusion/type filters, cap
 * accounting, and Graph enumeration (delta paging, ceiling, children
 * fallback, missing sources) with the admin's token.
 */
import { NextRequest } from 'next/server';

import type { M365ManifestItem } from '@/lib/services/agentAccess/types';
import {
  ENUMERATION_CEILING,
  MAX_M365_AGENT_DOCUMENTS,
  MAX_M365_SOURCE_FILE_BYTES,
  applySourceFilters,
  classifyItem,
  clearPlannerCacheForTests,
  planSource,
  planSources,
  summarizeCounts,
  summarizePlans,
} from '@/lib/services/m365/agentSourcePlanner';

import { getGraphAccessToken } from '@/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({ getGraphAccessToken: vi.fn() }));

const fetchMock = vi.fn();
const req = new NextRequest(
  'http://localhost/api/agent-access/m365-agents/plan',
);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function item(
  overrides: Partial<M365ManifestItem> & { itemId: string; name: string },
): M365ManifestItem {
  return {
    driveId: 'd',
    path: '',
    parentItemId: 'root',
    size: 1000,
    webUrl: '',
    tier: 'indexable',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPlannerCacheForTests();
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(getGraphAccessToken).mockResolvedValue({
    accessToken: 'tok',
    grantedScopes: [],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('classifyItem', () => {
  it('tiers by extension: documents index, media waits, the rest is skipped', () => {
    expect(classifyItem({ name: 'a.pdf', size: 10 })).toEqual({
      tier: 'indexable',
    });
    expect(classifyItem({ name: 'Deck.PPTX', size: 10 })).toEqual({
      tier: 'indexable',
    });
    expect(classifyItem({ name: 'notes.md', size: 10 })).toEqual({
      tier: 'indexable',
    });
    expect(classifyItem({ name: 'photo.png', size: 10 })).toEqual({
      tier: 'needsPreparation',
    });
    expect(classifyItem({ name: 'call.mp3', size: 10 })).toEqual({
      tier: 'needsPreparation',
    });
    expect(classifyItem({ name: 'town-hall.mp4', size: 10 })).toEqual({
      tier: 'needsPreparation',
    });
    expect(classifyItem({ name: 'logo.svg', size: 10 })).toEqual({
      tier: 'skipped',
      reason: 'unsupported',
    });
    expect(classifyItem({ name: 'Notebook.one', size: 10 })).toEqual({
      tier: 'skipped',
      reason: 'unsupported',
    });
    expect(classifyItem({ name: 'README', size: 10 })).toEqual({
      tier: 'skipped',
      reason: 'unsupported',
    });
  });

  it('lets Microsoft’s malware verdict and the denylist win over everything', () => {
    expect(classifyItem({ name: 'a.pdf', size: 10, malware: true })).toEqual({
      tier: 'skipped',
      reason: 'malware',
    });
    expect(classifyItem({ name: 'tool.exe', size: 10 })).toEqual({
      tier: 'skipped',
      reason: 'disallowedType',
    });
    expect(classifyItem({ name: 'archive.zip', size: 10 })).toEqual({
      tier: 'skipped',
      reason: 'disallowedType',
    });
    // MIME-based denial, but octet-stream alone never condemns a document.
    expect(
      classifyItem({
        name: 'a.pdf',
        size: 10,
        mimeType: 'application/x-msdownload',
      }),
    ).toEqual({ tier: 'skipped', reason: 'disallowedType' });
    expect(
      classifyItem({
        name: 'a.pdf',
        size: 10,
        mimeType: 'application/octet-stream',
      }),
    ).toEqual({ tier: 'indexable' });
  });

  it('applies the per-file size rules to indexable files only', () => {
    expect(classifyItem({ name: 'a.pdf', size: 0 })).toEqual({
      tier: 'skipped',
      reason: 'zeroBytes',
    });
    expect(
      classifyItem({ name: 'a.pdf', size: MAX_M365_SOURCE_FILE_BYTES + 1 }),
    ).toEqual({ tier: 'skipped', reason: 'tooLarge' });
    // Media over 25MB still waits for preparation (chunked transcription
    // handles size) — its tier is decided by type, not size.
    expect(
      classifyItem({ name: 'big.mp4', size: MAX_M365_SOURCE_FILE_BYTES * 4 }),
    ).toEqual({ tier: 'needsPreparation' });
  });
});

describe('applySourceFilters + summarizeCounts', () => {
  const folders = [
    { itemId: 'sub', name: 'Sub', path: 'Sub', parentItemId: 'root' },
    { itemId: 'subsub', name: 'Deep', path: 'Sub/Deep', parentItemId: 'sub' },
    { itemId: 'other', name: 'Other', path: 'Other', parentItemId: 'root' },
  ];
  const items = [
    item({ itemId: 'a', name: 'a.pdf' }),
    item({ itemId: 'b', name: 'b.docx', parentItemId: 'sub', path: 'Sub' }),
    item({
      itemId: 'c',
      name: 'c.pdf',
      parentItemId: 'subsub',
      path: 'Sub/Deep',
    }),
    item({ itemId: 'd', name: 'd.xlsx', parentItemId: 'other', path: 'Other' }),
    item({ itemId: 'e', name: 'e.mp4', tier: 'needsPreparation' }),
    item({
      itemId: 'f',
      name: 'f.zip',
      tier: 'skipped',
      reason: 'disallowedType',
    }),
  ];

  it('excludes a folder transitively and counts only what will be indexed', () => {
    const filtered = applySourceFilters(items, folders, {
      excludedItemIds: ['sub'],
    });
    const byId = new Map(filtered.map((i) => [i.itemId, i]));
    expect(byId.get('b')).toMatchObject({
      tier: 'skipped',
      reason: 'excluded',
    });
    expect(byId.get('c')).toMatchObject({
      tier: 'skipped',
      reason: 'excluded',
    });
    expect(byId.get('a')?.tier).toBe('indexable');
    expect(byId.get('d')?.tier).toBe('indexable');
    const counts = summarizeCounts(filtered);
    expect(counts).toMatchObject({
      indexable: 2,
      needsPreparation: 1,
      skipped: 3,
      bytes: 2000,
    });
  });

  it('applies the extension filter to unskipped files, case-insensitively', () => {
    const filtered = applySourceFilters(items, folders, {
      includeExtensions: ['PDF'],
    });
    const tiers = Object.fromEntries(
      filtered.map((i) => [i.itemId, i.reason ?? i.tier]),
    );
    expect(tiers).toEqual({
      a: 'indexable',
      b: 'typeFilter',
      c: 'indexable',
      d: 'typeFilter',
      e: 'typeFilter',
      f: 'disallowedType',
    });
  });

  it('carries index outcomes into the counts', () => {
    const counts = summarizeCounts([
      item({ itemId: 'a', name: 'a.pdf', status: 'indexed' }),
      item({ itemId: 'b', name: 'b.pdf', status: 'failed' }),
      item({ itemId: 'c', name: 'c.pdf', status: 'noText' }),
    ]);
    expect(counts).toMatchObject({
      indexable: 3,
      indexed: 1,
      failed: 1,
      noText: 1,
    });
  });
});

describe('planSource (Graph enumeration)', () => {
  const folderInput = {
    driveId: 'd',
    itemId: 'root',
    kind: 'folder' as const,
    recursive: true,
  };

  it('walks a recursive folder with /delta across pages and builds paths', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/delta') && !url.includes('page2')) {
        expect(url).toContain('malware');
        return Promise.resolve(
          json({
            value: [
              { id: 'root', name: 'Root', folder: {} },
              {
                id: 'sub',
                name: 'Sub',
                folder: {},
                parentReference: { id: 'root' },
              },
              {
                id: 'a',
                name: 'a.pdf',
                size: 10,
                file: { mimeType: 'application/pdf' },
                parentReference: { id: 'root' },
              },
            ],
            '@odata.nextLink': 'https://graph.microsoft.com/v1.0/delta?page2',
          }),
        );
      }
      if (url.includes('page2')) {
        return Promise.resolve(
          json({
            value: [
              {
                id: 'b',
                name: 'b.docx',
                size: 20,
                file: {},
                parentReference: { id: 'sub' },
              },
              { id: 'gone', name: 'old.pdf', deleted: {}, file: {} },
              {
                id: 'v',
                name: 'v.mp4',
                size: 5_000_000,
                file: {},
                parentReference: { id: 'sub' },
              },
            ],
            '@odata.deltaLink':
              'https://graph.microsoft.com/v1.0/delta?token=xyz',
          }),
        );
      }
      return Promise.resolve(json({ error: { message: 'unexpected' } }, 500));
    });

    const plan = await planSource(req, 'admin', folderInput);
    expect(plan.missing).toBe(false);
    expect(plan.truncated).toBe(false);
    expect(plan.deltaLink).toContain('token=xyz');
    expect(plan.folders).toEqual([
      { itemId: 'sub', name: 'Sub', path: 'Sub', parentItemId: 'root' },
    ]);
    expect(plan.items.map((i) => [i.itemId, i.path, i.tier])).toEqual([
      ['a', '', 'indexable'],
      ['b', 'Sub', 'indexable'],
      ['v', 'Sub', 'needsPreparation'],
    ]);
    expect(plan.counts).toMatchObject({
      indexable: 2,
      needsPreparation: 1,
      bytes: 30,
    });
    // Only delta calls — no per-folder children walks.
    expect(
      fetchMock.mock.calls.every((c) => String(c[0]).includes('delta')),
    ).toBe(true);
  });

  it('falls back to a recursive children walk when delta is refused', async () => {
    const listed: string[] = [];
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/delta')) {
        return Promise.resolve(
          json({ error: { message: 'not supported' } }, 400),
        );
      }
      listed.push(url);
      if (url.includes('/items/root/children')) {
        return Promise.resolve(
          json({
            value: [
              {
                id: 'sub',
                name: 'Sub',
                folder: {},
                parentReference: { id: 'root' },
              },
              {
                id: 'a',
                name: 'a.pdf',
                size: 1,
                file: {},
                parentReference: { id: 'root' },
              },
            ],
          }),
        );
      }
      if (url.includes('/items/sub/children')) {
        return Promise.resolve(
          json({
            value: [
              {
                id: 'b',
                name: 'b.pdf',
                size: 1,
                file: {},
                parentReference: { id: 'sub' },
              },
            ],
          }),
        );
      }
      return Promise.resolve(json({ value: [] }));
    });
    const plan = await planSource(req, 'admin', folderInput);
    expect(listed).toHaveLength(2);
    expect(plan.items.map((i) => i.itemId)).toEqual(['a', 'b']);
    expect(plan.items[1].path).toBe('Sub');
  });

  it('lists immediate children only for a non-recursive folder', async () => {
    fetchMock.mockImplementation((url: string) => {
      expect(url).toContain('/children');
      return Promise.resolve(
        json({
          value: [
            {
              id: 'sub',
              name: 'Sub',
              folder: {},
              parentReference: { id: 'root' },
            },
            {
              id: 'a',
              name: 'a.pdf',
              size: 1,
              file: {},
              parentReference: { id: 'root' },
            },
          ],
        }),
      );
    });
    const plan = await planSource(req, 'admin', {
      ...folderInput,
      recursive: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(plan.items.map((i) => i.itemId)).toEqual(['a']);
    expect(plan.folders.map((f) => f.itemId)).toEqual(['sub']);
  });

  it('stops at the enumeration ceiling and flags the plan as truncated', async () => {
    const page = (offset: number) => ({
      value: Array.from({ length: 200 }, (_, i) => ({
        id: `f${offset + i}`,
        name: `f${offset + i}.pdf`,
        size: 1,
        file: {},
        parentReference: { id: 'root' },
      })),
      '@odata.nextLink': `https://graph.microsoft.com/v1.0/delta?skip=${offset + 200}`,
    });
    fetchMock.mockImplementation((url: string) => {
      const match = /skip=(\d+)/.exec(url);
      return Promise.resolve(json(page(match ? Number(match[1]) : 0)));
    });
    const plan = await planSource(req, 'admin', folderInput);
    expect(plan.truncated).toBe(true);
    expect(plan.items).toHaveLength(ENUMERATION_CEILING);
    expect(fetchMock).toHaveBeenCalledTimes(ENUMERATION_CEILING / 200);
  });

  it('reports a source the admin cannot open as missing, not as an error', async () => {
    fetchMock.mockResolvedValue(json({ error: { message: 'nope' } }, 404));
    const plan = await planSource(req, 'admin', folderInput);
    expect(plan.missing).toBe(true);
    expect(plan.items).toEqual([]);
  });

  it('plans a file source from its own metadata', async () => {
    fetchMock.mockResolvedValue(
      json({
        id: 'doc',
        name: 'Handbook.docx',
        size: 4096,
        file: {
          mimeType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
        webUrl: 'https://contoso.sharepoint.com/Handbook.docx',
        parentReference: { id: 'parent' },
      }),
    );
    const plan = await planSource(req, 'admin', {
      driveId: 'd',
      itemId: 'doc',
      kind: 'file',
    });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      itemId: 'doc',
      tier: 'indexable',
      size: 4096,
    });
    expect(plan.counts.indexable).toBe(1);
  });

  it('reuses the cached enumeration when only filters change', async () => {
    fetchMock.mockResolvedValue(
      json({
        value: [
          {
            id: 'a',
            name: 'a.pdf',
            size: 1,
            file: {},
            parentReference: { id: 'root' },
          },
          {
            id: 'b',
            name: 'b.docx',
            size: 1,
            file: {},
            parentReference: { id: 'root' },
          },
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?token=1',
      }),
    );
    const first = await planSource(req, 'admin', folderInput);
    const second = await planSource(req, 'admin', {
      ...folderInput,
      includeExtensions: ['pdf'],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.counts.indexable).toBe(2);
    expect(second.counts.indexable).toBe(1);
  });
});

describe('summarizePlans / planSources', () => {
  it('flags the document cap from indexable counts only', () => {
    const plans = Array.from({ length: 2 }, () => ({
      missing: false,
      truncated: false,
      folders: [],
      items: [],
      counts: {
        indexable: MAX_M365_AGENT_DOCUMENTS,
        needsPreparation: 500,
        skipped: 500,
        bytes: 1,
      },
    }));
    const summary = summarizePlans(plans);
    expect(summary.totalDocuments).toBe(MAX_M365_AGENT_DOCUMENTS * 2);
    expect(summary.overDocumentCap).toBe(true);
    expect(summary.overByteCap).toBe(false);
    expect(summarizePlans([plans[0]]).overDocumentCap).toBe(false);
  });

  it('propagates a consent gap instead of swallowing it', async () => {
    vi.mocked(getGraphAccessToken).mockResolvedValue({
      error: 'No refresh token available',
    } as never);
    await expect(
      planSources(req, 'admin', [{ driveId: 'd', itemId: 'x', kind: 'file' }]),
    ).rejects.toMatchObject({ kind: 'not_connected' });
  });
});
