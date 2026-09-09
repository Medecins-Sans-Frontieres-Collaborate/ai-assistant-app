/**
 * Layer-2 probe batching: sources are checked via Graph $batch (20
 * sub-requests per call), verdicts fail closed on anything but 2xx/403/404,
 * and results are cached per user+agent+updatedAt.
 */
import { NextRequest } from 'next/server';

import {
  checkAgentSourceAccess,
  clearAgentSourceAccessCache,
} from '@/lib/services/m365/agentSourceAccess';

import { getGraphAccessToken } from '@/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({ getGraphAccessToken: vi.fn() }));

const mockStore = vi.hoisted(() => ({
  createAgentAccessBlobStorage: vi.fn(() => ({})),
  readM365AgentManifest: vi.fn(),
}));
vi.mock('@/lib/services/agentAccess/accessRulesStore', () => mockStore);

const fetchMock = vi.fn();

const req = new NextRequest('http://localhost/api/chat');

function makeAgent(sourceCount: number) {
  return {
    version: 1 as const,
    id: 'm365-abcdefabcdef',
    name: 'Agent',
    description: '',
    systemPrompt: '',
    chatModelId: null,
    embeddingModelId: 'text-embedding',
    ragConfig: { topK: 10 },
    sources: Array.from({ length: sourceCount }, (_, i) => ({
      sourceId: `src-${i}`,
      driveId: 'drive1',
      itemId: `item${i}`,
      kind: 'file' as const,
      title: `Doc ${i}`,
      webUrl: '',
      status: 'indexed' as const,
    })),
    createdBy: 'a@x.org',
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedBy: 'a@x.org',
    updatedAt: '2026-07-29T00:00:00.000Z',
  };
}

/** Batch response echoing per-id statuses from the provided map. */
function batchResponse(statusFor: (index: number) => number) {
  return (url: string, init?: RequestInit) => {
    expect(url).toContain('/$batch');
    const body = JSON.parse(String(init?.body));
    return Promise.resolve(
      new Response(
        JSON.stringify({
          responses: body.requests.map((r: { id: string }) => ({
            id: r.id,
            status: statusFor(Number(r.id)),
          })),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAgentSourceAccessCache();
  // Default: no manifest → legacy immediate-children semantics.
  mockStore.readM365AgentManifest.mockResolvedValue(null);
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(getGraphAccessToken).mockResolvedValue({
    accessToken: 'tok',
    grantedScopes: [],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('checkAgentSourceAccess ($batch probes)', () => {
  it('splits 50 sources into 3 batch calls and maps verdicts', async () => {
    // Even indices accessible; odd denied; index 8 (otherwise accessible)
    // throttled — must fail closed.
    fetchMock.mockImplementation(
      batchResponse((i) => (i === 8 ? 429 : i % 2 === 0 ? 200 : 403)),
    );
    const access = await checkAgentSourceAccess(req, 'u1', makeAgent(50));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const sizes = fetchMock.mock.calls.map(
      (call) => JSON.parse(String(call[1]?.body)).requests.length,
    );
    expect(sizes).toEqual([20, 20, 10]);
    expect(access.results).toHaveLength(50);
    expect(access.accessibleSourceIds).toContain('src-0');
    expect(access.accessibleSourceIds).not.toContain('src-1');
    // Throttled probe fails closed for that source only.
    expect(access.accessibleSourceIds).not.toContain('src-8');
    expect(access.accessibleSourceIds).toHaveLength(24);
  });

  it('treats 404 as inaccessible and caches the verdict per user', async () => {
    fetchMock.mockImplementation(batchResponse(() => 404));
    const agent = makeAgent(2);
    const first = await checkAgentSourceAccess(req, 'u1', agent);
    expect(first.accessibleSourceIds).toEqual([]);
    await checkAgentSourceAccess(req, 'u1', agent);
    expect(fetchMock).toHaveBeenCalledTimes(1); // cached
    await checkAgentSourceAccess(req, 'u2', agent);
    expect(fetchMock).toHaveBeenCalledTimes(2); // per-user entry
  });

  it('propagates a consent gap instead of denying', async () => {
    vi.mocked(getGraphAccessToken).mockResolvedValue({
      accessToken: null,
      grantedScopes: [],
      error: 'AADSTS65001: consent required',
    });
    await expect(
      checkAgentSourceAccess(req, 'u1', makeAgent(1)),
    ).rejects.toMatchObject({ kind: 'consent_missing' });
  });

  it('lists security-trimmed children for accessible folder sources only', async () => {
    const agent = makeAgent(3);
    agent.sources[1] = { ...agent.sources[1], kind: 'folder' as const };
    agent.sources[2] = { ...agent.sources[2], kind: 'folder' as const };
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/children')) {
        // Only the accessible folder (item1) may be listed.
        expect(url).toContain('item1');
        return Promise.resolve(
          new Response(
            JSON.stringify({
              value: [
                { id: 'childFile1' },
                { id: 'childFolder', folder: {} },
                { id: 'childFile2' },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      // Batch probe: file + first folder accessible, second folder denied.
      return batchResponse((i) => (i === 2 ? 403 : 200))(url, init);
    });

    const access = await checkAgentSourceAccess(req, 'u1', agent);
    expect(access.accessibleSourceIds).toEqual(['src-0', 'src-1']);
    // Child files only — subfolders don't carry chunks of their own.
    expect(access.accessibleFolderItems).toEqual([
      { driveId: 'drive1', itemId: 'childFile1' },
      { driveId: 'drive1', itemId: 'childFile2' },
    ]);
    const childrenCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('/children'),
    );
    expect(childrenCalls).toHaveLength(1);
  });

  it('probes manifest-backed folders per INDEXED item instead of listing children', async () => {
    const agent = makeAgent(2);
    agent.sources[1] = {
      ...agent.sources[1],
      kind: 'folder' as const,
      recursive: true,
    };
    mockStore.readM365AgentManifest.mockResolvedValue({
      version: 1,
      agentId: agent.id,
      updatedAt: '2026-08-25T00:00:00.000Z',
      sources: [
        {
          sourceId: 'src-1',
          truncated: false,
          folders: [],
          items: [
            {
              itemId: 'deep1',
              driveId: 'drive1',
              name: 'a.pdf',
              tier: 'indexable',
              status: 'indexed',
            },
            {
              itemId: 'deep2',
              driveId: 'drive1',
              name: 'b.pdf',
              tier: 'indexable',
              status: 'indexed',
            },
            {
              itemId: 'failed',
              driveId: 'drive1',
              name: 'c.pdf',
              tier: 'indexable',
              status: 'failed',
            },
            {
              itemId: 'video',
              driveId: 'drive1',
              name: 'd.mp4',
              tier: 'needsPreparation',
            },
          ],
        },
      ],
    });
    const probed: string[] = [];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      expect(url).not.toContain('/children');
      const body = JSON.parse(String(init?.body));
      for (const r of body.requests) probed.push(r.url);
      return batchResponse((i) => {
        const target = body.requests[i]?.url ?? '';
        return target.includes('deep2') ? 403 : 200;
      })(url, init);
    });

    const access = await checkAgentSourceAccess(req, 'u1', agent);
    expect(access.accessibleSourceIds).toEqual(['src-0', 'src-1']);
    // Only indexed items are probed (not failed/unprepared ones), and the
    // denied one is trimmed.
    expect(probed.filter((u) => u.includes('/items/'))).toHaveLength(2 + 2);
    expect(probed.some((u) => u.includes('failed'))).toBe(false);
    expect(access.accessibleFolderItems).toEqual([
      { driveId: 'drive1', itemId: 'deep1' },
    ]);
  });

  it('falls back to the legacy listing for folders absent from the manifest', async () => {
    const agent = makeAgent(2);
    agent.sources[1] = { ...agent.sources[1], kind: 'folder' as const };
    mockStore.readM365AgentManifest.mockResolvedValue({
      version: 1,
      agentId: agent.id,
      updatedAt: '2026-08-25T00:00:00.000Z',
      sources: [],
    });
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/children')) {
        return Promise.resolve(
          new Response(JSON.stringify({ value: [{ id: 'child1' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return batchResponse(() => 200)(url, init);
    });
    const access = await checkAgentSourceAccess(req, 'u1', agent);
    expect(access.accessibleFolderItems).toEqual([
      { driveId: 'drive1', itemId: 'child1' },
    ]);
  });

  it('fails closed for a folder whose children listing fails', async () => {
    const agent = makeAgent(2);
    agent.sources[1] = { ...agent.sources[1], kind: 'folder' as const };
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/children')) {
        return Promise.resolve(new Response('boom', { status: 500 }));
      }
      return batchResponse(() => 200)(url, init);
    });

    const access = await checkAgentSourceAccess(req, 'u1', agent);
    // The folder source stays "accessible" (probe passed) but contributes
    // no readable items — retrieval for it yields nothing.
    expect(access.accessibleSourceIds).toEqual(['src-0', 'src-1']);
    expect(access.accessibleFolderItems).toEqual([]);
  });

  it('fails closed for sources missing from the batch response', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      // Drop the last sub-response entirely.
      const responses = body.requests
        .slice(0, -1)
        .map((r: { id: string }) => ({ id: r.id, status: 200 }));
      return Promise.resolve(
        new Response(JSON.stringify({ responses }), { status: 200 }),
      );
    });
    const access = await checkAgentSourceAccess(req, 'u1', makeAgent(3));
    expect(access.accessibleSourceIds).toEqual(['src-0', 'src-1']);
  });
});
