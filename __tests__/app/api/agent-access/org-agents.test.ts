/**
 * Route tests for /api/agent-access/org-agents (CRUD). Store, access
 * service, and the search validation module are mocked at their module
 * boundaries; the static organization-agents.json is the real one, so the
 * override tests pin against its known 'msf_communications' id.
 */
import { NextRequest } from 'next/server';

import { parseJsonResponse } from '../helpers';

import {
  DELETE,
  GET,
  POST,
  PUT,
} from '@/app/api/agent-access/org-agents/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const mockService = vi.hoisted(() => ({
  isEnabled: vi.fn(),
  ensureFresh: vi.fn(),
  invalidate: vi.fn(),
  getSnapshot: vi.fn(),
}));
const mockStore = vi.hoisted(() => ({
  listAllOrgAgents: vi.fn(),
  readOrgAgent: vi.fn(),
  writeOrgAgent: vi.fn(),
  deleteOrgAgent: vi.fn(),
  writeOrgAgentHistoryEntry: vi.fn(),
  readConfig: vi.fn(),
  createAgentAccessBlobStorage: vi.fn(() => ({})),
}));
const mockAdminAuth = vi.hoisted(() => ({
  resolveAdminStatus: vi.fn(),
}));
const mockValidation = vi.hoisted(() => ({
  validateOrgAgentIndex: vi.fn(),
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
vi.mock('@/lib/services/orgAgents/orgAgentSearchValidation', () => ({
  ...mockValidation,
}));

const session = {
  user: { id: 'u1', mail: 'admin@example.org', name: 'Admin' },
  expires: new Date(Date.now() + 86_400_000).toISOString(),
};

const OK_VALIDATION = {
  status: 'ok',
  checkedAt: '2026-07-30T00:00:00.000Z',
  documentCount: 42,
};

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    id: 'orgr-abcdefabcdef',
    name: 'Field manuals',
    description: '',
    icon: 'IconHexagon',
    color: '#4190f2',
    category: '',
    maintainedBy: '',
    systemPrompt: '',
    sources: [],
    searchIndex: 'field-manuals',
    semanticConfig: '',
    topK: 10,
    baseModelId: null,
    allowWebSearch: false,
    allowCodeInterpreter: false,
    enabled: true,
    validation: OK_VALIDATION,
    createdBy: 'admin@example.org',
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedBy: 'admin@example.org',
    updatedAt: '2026-07-30T00:00:00.000Z',
    ...overrides,
  };
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/agent-access/org-agents', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function putRequest(body: unknown, etag = '"etag-1"'): NextRequest {
  return new NextRequest('http://localhost/api/agent-access/org-agents', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'If-Match': etag },
  });
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
  mockStore.readConfig.mockResolvedValue(null);
  mockStore.writeOrgAgent.mockResolvedValue('"etag-1"');
  mockStore.writeOrgAgentHistoryEntry.mockResolvedValue(undefined);
  mockValidation.validateOrgAgentIndex.mockResolvedValue(OK_VALIDATION);
});

describe('/api/agent-access/org-agents', () => {
  it('404s everyone while the feature is disabled', async () => {
    mockService.isEnabled.mockReturnValue(false);
    const response = await GET();
    expect(response.status).toBe(404);
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it('401s without a session', async () => {
    mockAuth.mockResolvedValue(null as never);
    const response = await GET();
    expect(response.status).toBe(401);
  });

  it('GET serves records plus the static override targets', async () => {
    mockStore.listAllOrgAgents.mockResolvedValue([
      {
        canonicalKey: 'org-agent::orgr-abcdefabcdef',
        blobPath: 'x',
        orgAgent: makeAgent(),
        etag: '"etag-1"',
      },
    ]);
    const response = await GET();
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.data.orgAgents).toHaveLength(1);
    expect(body.data.staticAgentIds).toContain('msf_communications');
    expect(body.data.canCreate).toBe(true);
  });

  it('403s LOCAL admins on create (global-only, unlike m365 agents)', async () => {
    mockAdminAuth.resolveAdminStatus.mockReturnValue({
      isGlobalAdmin: false,
      isLocalAdmin: true,
      editableAgentKeys: ['org-agent::orgr-abcdefabcdef'],
    });
    const response = await POST(postRequest({ name: 'X', searchIndex: 'idx' }));
    expect(response.status).toBe(403);
  });

  it('rejects an unknown overrideId and a malformed index name', async () => {
    const badOverride = await POST(
      postRequest({
        name: 'X',
        searchIndex: 'idx',
        overrideId: 'not_a_static_agent',
      }),
    );
    expect(badOverride.status).toBe(400);

    const badIndex = await POST(
      postRequest({ name: 'X', searchIndex: 'Bad/Name' }),
    );
    expect(badIndex.status).toBe(400);
  });

  it('rejects an agent-backed baseModelId', async () => {
    const response = await POST(
      postRequest({ name: 'X', searchIndex: 'idx', baseModelId: 'byom-abc' }),
    );
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(400);
    expect(body.error).toContain('baseModelId');
  });

  it('creates an agent, persisting the validation outcome', async () => {
    const response = await POST(
      postRequest({ name: 'Field manuals', searchIndex: 'field-manuals' }),
    );
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.data.agent.id).toMatch(/^orgr-[a-f0-9]{12}$/);
    expect(body.data.agent.validation).toEqual(OK_VALIDATION);
    expect(mockValidation.validateOrgAgentIndex).toHaveBeenCalledWith(
      'field-manuals',
      '',
    );
    expect(mockStore.writeOrgAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ version: 1 }),
      null,
    );
  });

  it('saves a record whose validation FAILED (staging) — outcome persisted', async () => {
    mockValidation.validateOrgAgentIndex.mockResolvedValue({
      status: 'failed',
      checkedAt: '2026-07-30T00:00:00.000Z',
      error: "Index 'missing' does not exist",
    });
    const response = await POST(
      postRequest({ name: 'Staging', searchIndex: 'missing' }),
    );
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.data.agent.validation.status).toBe('failed');
  });

  it('creates an OVERRIDE record under the static agent id', async () => {
    const response = await POST(
      postRequest({
        name: 'MSF Communications (updated)',
        searchIndex: 'comms-index',
        overrideId: 'msf_communications',
      }),
    );
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.data.agent.id).toBe('msf_communications');
    expect(body.data.canonicalKey).toBe('org-agent::msf_communications');
  });

  it('PUT re-validates and accepts static-id records; rejects alien ids', async () => {
    mockStore.readOrgAgent.mockResolvedValue({
      orgAgent: makeAgent({ id: 'msf_communications' }),
      etag: '"etag-1"',
    });
    const response = await PUT(
      putRequest({
        id: 'msf_communications',
        name: 'Renamed',
        searchIndex: 'comms-v2',
      }),
    );
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.data.agent.searchIndex).toBe('comms-v2');
    expect(mockValidation.validateOrgAgentIndex).toHaveBeenCalledWith(
      'comms-v2',
      '',
    );

    const alien = await PUT(
      putRequest({ id: 'random-id', name: 'X', searchIndex: 'idx' }),
    );
    expect(alien.status).toBe(400);
  });

  it('DELETE requires a strong If-Match', async () => {
    mockStore.deleteOrgAgent.mockResolvedValue(true);
    const noEtag = await DELETE(
      new NextRequest(
        'http://localhost/api/agent-access/org-agents?id=orgr-abcdefabcdef',
        { method: 'DELETE' },
      ),
    );
    expect(noEtag.status).toBe(400);

    const response = await DELETE(
      new NextRequest(
        'http://localhost/api/agent-access/org-agents?id=orgr-abcdefabcdef',
        { method: 'DELETE', headers: { 'If-Match': '"etag-1"' } },
      ),
    );
    expect(response.status).toBe(200);
    expect(mockStore.deleteOrgAgent).toHaveBeenCalledWith(
      expect.anything(),
      'orgr-abcdefabcdef',
      '"etag-1"',
    );
  });
});
