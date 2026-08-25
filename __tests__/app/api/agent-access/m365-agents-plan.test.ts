/**
 * Route tests for POST /api/agent-access/m365-agents/plan: admin gating,
 * body validation, and pass-through of the planner's cap accounting.
 */
import { NextRequest } from 'next/server';

import { M365Error } from '@/lib/services/m365/graphApi';

import { parseJsonResponse } from '../helpers';

import { POST } from '@/app/api/agent-access/m365-agents/plan/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const mockService = vi.hoisted(() => ({
  isEnabled: vi.fn(),
  ensureFresh: vi.fn(),
  getSnapshot: vi.fn(),
}));
const mockAdminAuth = vi.hoisted(() => ({ resolveAdminStatus: vi.fn() }));
const mockPlanner = vi.hoisted(() => ({ planSources: vi.fn() }));

vi.mock('@/auth', () => ({ auth: mockAuth, getGraphAccessToken: vi.fn() }));
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: { getInstance: () => mockService },
}));
vi.mock('@/lib/services/agentAccess/adminAuth', () => mockAdminAuth);
vi.mock('@/lib/services/m365/agentSourcePlanner', () => mockPlanner);

const session = {
  user: { id: 'u1', mail: 'admin@example.org', name: 'Admin' },
  expires: new Date(Date.now() + 86_400_000).toISOString(),
};

function request(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/agent-access/m365-agents/plan', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const folder = {
  driveId: 'drive1',
  itemId: 'folder1',
  kind: 'folder',
  recursive: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(session as never);
  mockService.isEnabled.mockReturnValue(true);
  mockService.ensureFresh.mockResolvedValue(undefined);
  mockService.getSnapshot.mockReturnValue({
    config: { version: 1, localAdmins: [] },
  });
  mockAdminAuth.resolveAdminStatus.mockReturnValue({
    isGlobalAdmin: false,
    isLocalAdmin: true,
    editableAgentKeys: [],
  });
});

describe('POST /api/agent-access/m365-agents/plan', () => {
  it('404s while disabled, 401s without a session, 403s non-admins', async () => {
    mockService.isEnabled.mockReturnValue(false);
    expect((await POST(request({ sources: [folder] }))).status).toBe(404);

    mockService.isEnabled.mockReturnValue(true);
    mockAuth.mockResolvedValue(null as never);
    expect((await POST(request({ sources: [folder] }))).status).toBe(401);

    mockAuth.mockResolvedValue(session as never);
    mockAdminAuth.resolveAdminStatus.mockReturnValue({
      isGlobalAdmin: false,
      isLocalAdmin: false,
      editableAgentKeys: [],
    });
    expect((await POST(request({ sources: [folder] }))).status).toBe(403);
    expect(mockPlanner.planSources).not.toHaveBeenCalled();
  });

  it('rejects malformed bodies before touching Graph', async () => {
    expect((await POST(request({ sources: [] }))).status).toBe(400);
    expect(
      (await POST(request({ sources: [{ ...folder, itemId: '../x' }] })))
        .status,
    ).toBe(400);
    expect(
      (
        await POST(
          request({ sources: [{ ...folder, includeExtensions: ['p df'] }] }),
        )
      ).status,
    ).toBe(400);
    expect(mockPlanner.planSources).not.toHaveBeenCalled();
  });

  it('returns the plan with per-source ids and cap accounting', async () => {
    mockPlanner.planSources.mockResolvedValue({
      plans: [
        {
          missing: false,
          truncated: false,
          folders: [],
          items: [],
          counts: { indexable: 3, needsPreparation: 1, skipped: 2, bytes: 99 },
        },
      ],
      totalDocuments: 3,
      totalBytes: 99,
      maxDocuments: 50,
      maxBytes: 1,
      overDocumentCap: false,
      overByteCap: true,
    });
    const response = await POST(request({ sources: [folder] }));
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.data.overByteCap).toBe(true);
    expect(body.data.plans[0]).toMatchObject({
      driveId: 'drive1',
      itemId: 'folder1',
      counts: { indexable: 3 },
    });
    expect(mockPlanner.planSources).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      [expect.objectContaining({ recursive: true, excludedItemIds: [] })],
    );
  });

  it('maps a missing M365 session to the typed connect error', async () => {
    mockPlanner.planSources.mockRejectedValue(
      new M365Error('no session', 'not_connected', 401),
    );
    const response = await POST(request({ sources: [folder] }));
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(401);
    expect(body.code).toBe('M365_NOT_CONNECTED');
  });
});
