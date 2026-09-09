/**
 * Route tests for GET /api/agent-access/history — the entity-agnostic audit
 * trail listing. Store and access service are mocked at their boundaries.
 */
import { NextRequest } from 'next/server';

import { parseJsonResponse } from '../helpers';

import { GET } from '@/app/api/agent-access/history/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const mockService = vi.hoisted(() => ({
  isEnabled: vi.fn(),
  ensureFresh: vi.fn(),
  getSnapshot: vi.fn(),
}));
const mockStore = vi.hoisted(() => ({
  listHistoryEntries: vi.fn(),
  createAgentAccessBlobStorage: vi.fn(() => ({})),
}));
const mockAdminAuth = vi.hoisted(() => ({
  resolveAdminStatus: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: { getInstance: () => mockService },
  emitAccessAudit: vi.fn(),
}));
vi.mock(
  '@/lib/services/agentAccess/accessRulesStore',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@/lib/services/agentAccess/accessRulesStore')
      >();
    return { ...actual, ...mockStore };
  },
);
vi.mock('@/lib/services/agentAccess/adminAuth', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/lib/services/agentAccess/adminAuth')
    >();
  return { ...actual, ...mockAdminAuth };
});

const session = {
  user: { id: 'u1', mail: 'admin@example.org', name: 'Admin' },
  expires: new Date(Date.now() + 86_400_000).toISOString(),
};

const KEY = 'org-agent::orgr-abcdefabcdef';

function request(key: string | null): NextRequest {
  const url = new URL('http://localhost/api/agent-access/history');
  if (key !== null) url.searchParams.set('key', key);
  return new NextRequest(url);
}

function entry(updatedAt: string, action: 'upsert' | 'delete' = 'upsert') {
  return {
    version: 1 as const,
    canonicalKey: KEY,
    action,
    updatedBy: 'admin@example.org',
    updatedAt,
    orgAgent: action === 'upsert' ? { id: 'orgr-abcdefabcdef' } : null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(session as never);
  mockService.isEnabled.mockReturnValue(true);
  mockService.ensureFresh.mockResolvedValue(undefined);
  mockService.getSnapshot.mockReturnValue({
    config: { version: 1, localAdmins: [] },
    rulesUnavailable: false,
  });
  mockAdminAuth.resolveAdminStatus.mockReturnValue({
    isGlobalAdmin: true,
    isLocalAdmin: false,
    editableAgentKeys: '*',
  });
  mockStore.listHistoryEntries.mockResolvedValue([]);
});

describe('GET /api/agent-access/history', () => {
  it('404s everyone while the feature is disabled', async () => {
    mockService.isEnabled.mockReturnValue(false);
    const response = await GET(request(KEY));
    expect(response.status).toBe(404);
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it('401s without a session and 400s a malformed key', async () => {
    mockAuth.mockResolvedValue(null as never);
    expect((await GET(request(KEY))).status).toBe(401);

    mockAuth.mockResolvedValue(session as never);
    expect((await GET(request(null))).status).toBe(400);
    expect((await GET(request('no-separator'))).status).toBe(400);
  });

  it('403s non-admins and local admins outside their delegated keys', async () => {
    mockAdminAuth.resolveAdminStatus.mockReturnValue({
      isGlobalAdmin: false,
      isLocalAdmin: false,
      editableAgentKeys: [],
    });
    expect((await GET(request(KEY))).status).toBe(403);

    mockAdminAuth.resolveAdminStatus.mockReturnValue({
      isGlobalAdmin: false,
      isLocalAdmin: true,
      editableAgentKeys: ['org-agent::other-key'],
    });
    expect((await GET(request(KEY))).status).toBe(403);
  });

  it('serves entries for the key and reports truncation at the cap', async () => {
    mockStore.listHistoryEntries.mockResolvedValue(
      Array.from({ length: 60 }, (_, i) => ({
        blobPath: `p${i}`,
        entry: entry(
          `2026-07-${String(30 - (i % 28)).padStart(2, '0')}T00:00:0${i % 10}.000Z`,
        ),
      })),
    );
    const response = await GET(request(KEY));
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.data.entries).toHaveLength(50);
    expect(body.data.truncated).toBe(true);
    expect(mockStore.listHistoryEntries).toHaveBeenCalledWith(
      expect.anything(),
      KEY,
    );
  });

  it('passes delete tombstones through with their null payload', async () => {
    mockStore.listHistoryEntries.mockResolvedValue([
      { blobPath: 'p1', entry: entry('2026-07-30T01:00:00.000Z', 'delete') },
    ]);
    const response = await GET(request(KEY));
    const body = await parseJsonResponse(response);
    expect(body.data.entries[0]).toMatchObject({
      action: 'delete',
      orgAgent: null,
    });
  });
});
