import { NextRequest } from 'next/server';

import { parseJsonResponse } from '../helpers';

import { GET } from '@/app/api/agent-access/m365-agents/changes/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const mockService = vi.hoisted(() => ({
  isEnabled: vi.fn(),
  ensureFresh: vi.fn(),
  getSnapshot: vi.fn(),
}));
const mockAdminAuth = vi.hoisted(() => ({ resolveAdminStatus: vi.fn() }));
const mockStore = vi.hoisted(() => ({
  createAgentAccessBlobStorage: vi.fn(() => ({})),
  readM365Agent: vi.fn(),
  readM365AgentManifest: vi.fn(),
}));
const mockIndex = vi.hoisted(() => ({ previewRefresh: vi.fn() }));

vi.mock('@/auth', () => ({ auth: mockAuth, getGraphAccessToken: vi.fn() }));
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: { getInstance: () => mockService },
}));
vi.mock('@/lib/services/agentAccess/adminAuth', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/lib/services/agentAccess/adminAuth')
    >();
  return { ...actual, ...mockAdminAuth };
});
vi.mock('@/lib/services/agentAccess/accessRulesStore', () => mockStore);
vi.mock('@/lib/services/m365/agentIndexService', () => mockIndex);

const AGENT_ID = 'm365-abcdefabcdef';
const request = () =>
  new NextRequest(
    `http://localhost/api/agent-access/m365-agents/changes?id=${AGENT_ID}`,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({
    user: { id: 'u1', mail: 'admin@example.org' },
    expires: '',
  } as never);
  mockService.isEnabled.mockReturnValue(true);
  mockService.ensureFresh.mockResolvedValue(undefined);
  mockService.getSnapshot.mockReturnValue({
    config: { version: 1, localAdmins: [] },
  });
  mockAdminAuth.resolveAdminStatus.mockReturnValue({
    isGlobalAdmin: true,
    isLocalAdmin: false,
    editableAgentKeys: '*',
  });
  mockStore.readM365Agent.mockResolvedValue({
    m365Agent: { id: AGENT_ID, sources: [] },
    etag: '"e"',
  });
});

describe('GET /api/agent-access/m365-agents/changes', () => {
  it('returns null preview when the agent has no manifest', async () => {
    mockStore.readM365AgentManifest.mockResolvedValue(null);
    const body = await parseJsonResponse(await GET(request()));
    expect(body.data).toEqual({ preview: null, lastIndexedAt: null });
    expect(mockIndex.previewRefresh).not.toHaveBeenCalled();
  });

  it('previews the refresh against the manifest with the caller’s token', async () => {
    mockStore.readM365AgentManifest.mockResolvedValue({
      version: 1,
      agentId: AGENT_ID,
      updatedAt: '2026-08-25T09:00:00.000Z',
      sources: [],
    });
    mockIndex.previewRefresh.mockResolvedValue({
      sources: [],
      changes: { added: 2, modified: 1, removed: 0, unchanged: 7 },
    });
    const body = await parseJsonResponse(await GET(request()));
    expect(body.data.lastIndexedAt).toBe('2026-08-25T09:00:00.000Z');
    expect(body.data.preview.changes.added).toBe(2);
    expect(mockIndex.previewRefresh).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: AGENT_ID }),
      'u1',
      expect.objectContaining({ agentId: AGENT_ID }),
    );
  });

  it('gates on admin status', async () => {
    mockAdminAuth.resolveAdminStatus.mockReturnValue({
      isGlobalAdmin: false,
      isLocalAdmin: false,
      editableAgentKeys: [],
    });
    expect((await GET(request())).status).toBe(403);
  });
});
