/**
 * Route tests for /api/agent-access/m365-agents (CRUD) and the chat-side
 * preflight /api/m365/agents/[id]/access. Store, access service, and Graph
 * probes are mocked at their module boundaries.
 */
import { NextRequest } from 'next/server';

import { parseJsonResponse } from '../helpers';

import {
  DELETE,
  GET,
  POST,
  PUT,
} from '@/app/api/agent-access/m365-agents/route';
import { GET as preflightGET } from '@/app/api/m365/agents/[id]/access/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const mockService = vi.hoisted(() => ({
  isEnabled: vi.fn(),
  ensureFresh: vi.fn(),
  invalidate: vi.fn(),
  getSnapshot: vi.fn(),
  getM365AgentById: vi.fn(),
  evaluateAccess: vi.fn(),
}));
const mockStore = vi.hoisted(() => ({
  listAllM365Agents: vi.fn(),
  readM365Agent: vi.fn(),
  writeM365Agent: vi.fn(),
  deleteM365Agent: vi.fn(),
  writeM365AgentHistoryEntry: vi.fn(),
  readConfig: vi.fn(),
  createAgentAccessBlobStorage: vi.fn(() => ({})),
}));
const mockAdminAuth = vi.hoisted(() => ({
  resolveAdminStatus: vi.fn(),
}));
const mockIndexService = vi.hoisted(() => ({
  purgeAgentFromIndex: vi.fn(),
  purgeSourcesFromIndex: vi.fn(),
  MAX_M365_AGENT_DOCUMENTS: 10,
}));
const mockSourceAccess = vi.hoisted(() => ({
  checkAgentSourceAccess: vi.fn(),
}));
const mockPlanner = vi.hoisted(() => ({
  planSources: vi.fn(),
  MAX_M365_AGENT_SOURCE_BYTES: 512 * 1024 * 1024,
}));

vi.mock('@/auth', () => ({ auth: mockAuth, getGraphAccessToken: vi.fn() }));
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
vi.mock('@/lib/services/m365/agentIndexService', () => mockIndexService);
vi.mock('@/lib/services/m365/agentIndexJobStore', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/lib/services/m365/agentIndexJobStore')
    >();
  return {
    ...actual,
    listIndexJobs: vi.fn(async () => new Map()),
    deleteIndexJob: vi.fn(async () => undefined),
  };
});
vi.mock('@/lib/services/m365/agentSourceAccess', () => mockSourceAccess);
vi.mock('@/lib/services/m365/agentSourcePlanner', () => mockPlanner);

const session = {
  user: { id: 'u1', mail: 'admin@example.org', name: 'Admin' },
  expires: new Date(Date.now() + 86_400_000).toISOString(),
};

const validSource = {
  driveId: 'drive1',
  itemId: 'item1',
  kind: 'file',
  title: 'Budget.xlsx',
  webUrl: 'https://contoso.sharepoint.com/budget.xlsx',
};

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    id: 'm365-abcdefabcdef',
    name: 'Budget agent',
    description: '',
    systemPrompt: '',
    chatModelId: null,
    embeddingModelId: 'text-embedding',
    ragConfig: { topK: 10 },
    sources: [
      {
        sourceId: 'src-11111111',
        driveId: 'drive1',
        itemId: 'item1',
        kind: 'file',
        title: 'Budget.xlsx',
        webUrl: 'https://contoso.sharepoint.com/budget.xlsx',
        status: 'indexed',
      },
    ],
    createdBy: 'admin@example.org',
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedBy: 'admin@example.org',
    updatedAt: '2026-07-29T00:00:00.000Z',
    ...overrides,
  };
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/agent-access/m365-agents', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
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
  mockStore.writeM365Agent.mockResolvedValue('"etag-1"');
  mockStore.writeM365AgentHistoryEntry.mockResolvedValue(undefined);
  mockPlanner.planSources.mockResolvedValue({
    plans: [],
    totalDocuments: 1,
    totalBytes: 1024,
    maxDocuments: 10,
    maxBytes: 512 * 1024 * 1024,
    overDocumentCap: false,
    overByteCap: false,
  });
});

describe('/api/agent-access/m365-agents', () => {
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

  it('403s non-admins on create', async () => {
    mockAdminAuth.resolveAdminStatus.mockReturnValue({
      isGlobalAdmin: false,
      isLocalAdmin: false,
      editableAgentKeys: [],
    });
    const response = await POST(
      postRequest({ name: 'X', sources: [validSource] }),
    );
    expect(response.status).toBe(403);
  });

  it('rejects more than 10 sources', async () => {
    const sources = Array.from({ length: 11 }, (_, i) => ({
      ...validSource,
      itemId: `item${i}`,
    }));
    const response = await POST(postRequest({ name: 'X', sources }));
    expect(response.status).toBe(400);
  });

  it('rejects an agent-backed chatModelId', async () => {
    const response = await POST(
      postRequest({
        name: 'X',
        chatModelId: 'org-something',
        sources: [validSource],
      }),
    );
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(400);
    expect(body.error).toContain('chatModelId');
  });

  it('creates an agent with server-generated ids and pending sources', async () => {
    const response = await POST(
      postRequest({ name: 'Budget agent', sources: [validSource] }),
    );
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.data.agent.id).toMatch(/^m365-[a-f0-9]{12}$/);
    expect(body.data.agent.sources[0].sourceId).toMatch(/^src-[a-f0-9]{8}$/);
    expect(body.data.agent.sources[0].status).toBe('pending');
    expect(body.data.etag).toBe('"etag-1"');
    // Global admin creates never delegate.
    expect(mockStore.writeM365Agent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ version: 1 }),
      null,
    );
  });

  it('refuses a create whose sources expand past the document cap', async () => {
    mockPlanner.planSources.mockResolvedValue({
      plans: [],
      totalDocuments: 312,
      totalBytes: 1024,
      maxDocuments: 10,
      maxBytes: 512 * 1024 * 1024,
      overDocumentCap: true,
      overByteCap: false,
    });
    const response = await POST(
      postRequest({
        name: 'Big',
        sources: [{ ...validSource, kind: 'folder', recursive: true }],
      }),
    );
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(400);
    expect(body.error).toMatch(/312 documents/);
    expect(mockStore.writeM365Agent).not.toHaveBeenCalled();
  });

  it('still saves when the save-time plan itself fails (Graph outage)', async () => {
    mockPlanner.planSources.mockRejectedValue(new Error('throttled'));
    const response = await POST(
      postRequest({ name: 'X', sources: [validSource] }),
    );
    expect(response.status).toBe(200);
  });

  it('PUT flags a folder as pending again when its selection changes', async () => {
    const existing = makeAgent({
      sources: [
        {
          sourceId: 'src-11111111',
          driveId: 'drive1',
          itemId: 'folder1',
          kind: 'folder',
          title: 'Reports',
          webUrl: '',
          status: 'indexed',
          recursive: false,
          excludedItemIds: [],
        },
      ],
    });
    mockStore.readM365Agent.mockResolvedValue({
      m365Agent: existing,
      etag: '"etag-1"',
    });
    const response = await PUT(
      new NextRequest('http://localhost/api/agent-access/m365-agents', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'If-Match': '"etag-1"',
        },
        body: JSON.stringify({
          id: existing.id,
          name: 'Reports agent',
          sources: [
            {
              driveId: 'drive1',
              itemId: 'folder1',
              kind: 'folder',
              title: 'Reports',
              webUrl: '',
              recursive: true,
              excludedItemIds: ['sub1'],
              includeExtensions: ['PDF', 'docx'],
            },
          ],
        }),
      }),
    );
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    const [source] = body.data.agent.sources;
    expect(source.sourceId).toBe('src-11111111');
    expect(source.status).toBe('pending');
    expect(source.recursive).toBe(true);
    expect(source.excludedItemIds).toEqual(['sub1']);
    expect(source.includeExtensions).toEqual(['pdf', 'docx']);
  });

  it('PUT keeps sourceIds for unchanged sources and purges removed ones', async () => {
    const existing = makeAgent();
    mockStore.readM365Agent.mockResolvedValue({
      m365Agent: existing,
      etag: '"etag-1"',
    });
    const response = await PUT(
      new NextRequest('http://localhost/api/agent-access/m365-agents', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'If-Match': '"etag-1"',
        },
        body: JSON.stringify({
          id: existing.id,
          name: 'Renamed',
          sources: [
            { ...validSource, title: 'Budget v2.xlsx' },
            { ...validSource, itemId: 'item2', title: 'New doc.docx' },
          ],
        }),
      }),
    );
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    const [kept, added] = body.data.agent.sources;
    expect(kept.sourceId).toBe('src-11111111'); // same drive+item → id kept
    expect(kept.status).toBe('indexed');
    expect(kept.title).toBe('Budget v2.xlsx');
    expect(added.status).toBe('pending');
    expect(mockIndexService.purgeSourcesFromIndex).not.toHaveBeenCalled();
  });

  it('DELETE requires a strong If-Match and purges the index', async () => {
    mockStore.deleteM365Agent.mockResolvedValue(true);
    const noEtag = await DELETE(
      new NextRequest(
        'http://localhost/api/agent-access/m365-agents?id=m365-abcdefabcdef',
        { method: 'DELETE' },
      ),
    );
    expect(noEtag.status).toBe(400);

    const response = await DELETE(
      new NextRequest(
        'http://localhost/api/agent-access/m365-agents?id=m365-abcdefabcdef',
        { method: 'DELETE', headers: { 'If-Match': '"etag-1"' } },
      ),
    );
    expect(response.status).toBe(200);
    expect(mockIndexService.purgeAgentFromIndex).toHaveBeenCalledWith(
      'm365-abcdefabcdef',
    );
  });
});

describe('GET /api/m365/agents/[id]/access (preflight)', () => {
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const request = new NextRequest(
    'http://localhost/api/m365/agents/m365-abcdefabcdef/access',
  );

  it('404s unknown ids and layer-1 denials identically', async () => {
    mockService.getM365AgentById.mockReturnValue(null);
    const unknown = await preflightGET(request, params('m365-abcdefabcdef'));
    expect(unknown.status).toBe(404);

    mockService.getM365AgentById.mockReturnValue(makeAgent());
    mockService.evaluateAccess.mockReturnValue({
      decision: 'deny',
      reason: 'not-allowed',
    });
    const denied = await preflightGET(request, params('m365-abcdefabcdef'));
    expect(denied.status).toBe(404);
  });

  it('reports per-source access with request-access hints on denials', async () => {
    const agent = makeAgent({
      sources: [
        makeAgent().sources[0],
        {
          sourceId: 'src-22222222',
          driveId: 'drive1',
          itemId: 'item2',
          kind: 'file',
          title: 'Ops Handbook.docx',
          webUrl: 'https://contoso.sharepoint.com/ops.docx',
          ownerDisplay: 'Maria R.',
          status: 'indexed',
        },
      ],
    });
    mockService.getM365AgentById.mockReturnValue(agent);
    mockService.evaluateAccess.mockReturnValue({
      decision: 'allow',
      reason: 'public',
    });
    mockSourceAccess.checkAgentSourceAccess.mockResolvedValue({
      accessibleSourceIds: ['src-11111111'],
      results: [
        { sourceId: 'src-11111111', accessible: true },
        { sourceId: 'src-22222222', accessible: false },
      ],
    });
    const response = await preflightGET(request, params('m365-abcdefabcdef'));
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.data.connected).toBe(true);
    const [ok, denied] = body.data.sources;
    expect(ok).toEqual({
      sourceId: 'src-11111111',
      title: 'Budget.xlsx',
      accessible: true,
    });
    expect(denied.accessible).toBe(false);
    expect(denied.webUrl).toContain('ops.docx');
    expect(denied.ownerDisplay).toBe('Maria R.');
  });

  it('maps a missing Graph session to connected:false', async () => {
    mockService.getM365AgentById.mockReturnValue(makeAgent());
    mockService.evaluateAccess.mockReturnValue({
      decision: 'allow',
      reason: 'public',
    });
    const { M365Error } = await import('@/lib/services/m365/graphApi');
    mockSourceAccess.checkAgentSourceAccess.mockRejectedValue(
      new M365Error('no session', 'not_connected', 401),
    );
    const response = await preflightGET(request, params('m365-abcdefabcdef'));
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.data.connected).toBe(false);
  });
});
