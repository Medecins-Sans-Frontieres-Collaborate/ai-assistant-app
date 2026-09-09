import { NextRequest } from 'next/server';

import { PreparationError } from '@/lib/services/m365/agentPreparationService';

import { parseJsonResponse } from '../helpers';

import { POST } from '@/app/api/agent-access/m365-agents/prepare/route';
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
}));
const mockPrep = vi.hoisted(() => ({ prepareAgentItem: vi.fn() }));

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
vi.mock(
  '@/lib/services/m365/agentPreparationService',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@/lib/services/m365/agentPreparationService')
      >();
    return { ...actual, ...mockPrep };
  },
);

const AGENT_ID = 'm365-abcdefabcdef';
const body = { id: AGENT_ID, driveId: 'drive1', itemId: 'item1' };
const post = (b: unknown) =>
  new NextRequest('http://localhost/api/agent-access/m365-agents/prepare', {
    method: 'POST',
    body: JSON.stringify(b),
    headers: { 'Content-Type': 'application/json' },
  });

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
  mockPrep.prepareAgentItem.mockResolvedValue({
    status: 'prepared',
    kind: 'image',
    itemId: 'item1',
    name: 'a.png',
    eTag: '"v"',
    chars: 12,
  });
});

describe('POST /api/agent-access/m365-agents/prepare', () => {
  it('validates the body and gates on admin status', async () => {
    expect((await POST(post({ id: AGENT_ID }))).status).toBe(400);
    mockAdminAuth.resolveAdminStatus.mockReturnValue({
      isGlobalAdmin: false,
      isLocalAdmin: false,
      editableAgentKeys: [],
    });
    expect((await POST(post(body))).status).toBe(403);
    expect(mockPrep.prepareAgentItem).not.toHaveBeenCalled();
  });

  it('returns the preparation outcome', async () => {
    const response = await POST(post(body));
    const parsed = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(parsed.data.outcome).toMatchObject({
      status: 'prepared',
      kind: 'image',
    });
    expect(mockPrep.prepareAgentItem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ user: expect.objectContaining({ id: 'u1' }) }),
      expect.anything(),
      expect.objectContaining({ id: AGENT_ID }),
      { driveId: 'drive1', itemId: 'item1' },
    );
  });

  it('maps admin-facing refusals to their status with a code', async () => {
    mockPrep.prepareAgentItem.mockRejectedValue(
      new PreparationError('Daily limit reached', 429),
    );
    const response = await POST(post(body));
    const parsed = await parseJsonResponse(response);
    expect(response.status).toBe(429);
    expect(parsed.code).toBe('M365_PREPARE_REFUSED');
    expect(parsed.error).toBe('Daily limit reached');
  });
});
