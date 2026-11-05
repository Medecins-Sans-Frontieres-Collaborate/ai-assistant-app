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
  PATCH,
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
  MAX_M365_AGENT_MAX_DOCUMENTS: 10,
  M365_AGENT_MAX_DOCUMENTS_CEILING: 200,
  roleMaxDocuments: (isGlobalAdmin: boolean) => (isGlobalAdmin ? 200 : 100),
  effectiveMaxDocuments: (override?: number | null) =>
    Math.min(override ?? 10, 200),
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
  it('lists only the delegated agent for a local admin who is not its creator', async () => {
    const { resolveAdminStatus } = await vi.importActual<
      typeof import('@/lib/services/agentAccess/adminAuth')
    >('@/lib/services/agentAccess/adminAuth');
    mockAdminAuth.resolveAdminStatus.mockImplementation(resolveAdminStatus);
    mockAuth.mockResolvedValue({
      ...session,
      user: {
        id: 'delegate-user',
        mail: 'delegate@example.org',
        name: 'Delegate',
      },
    });
    const config = {
      version: 1,
      localAdmins: [
        {
          email: 'delegate@example.org',
          agentKeys: ['m365-agent::m365-abcdefabcdef'],
        },
      ],
      updatedBy: 'admin@example.org',
      updatedAt: '2026-07-29T00:00:00.000Z',
    };
    mockStore.readConfig.mockResolvedValue({ config, etag: '"config-1"' });
    mockStore.listAllM365Agents.mockResolvedValue([
      {
        canonicalKey: 'm365-agent::m365-abcdefabcdef',
        m365Agent: makeAgent(),
        etag: '"agent-1"',
      },
      {
        canonicalKey: 'm365-agent::m365-111111111111',
        m365Agent: makeAgent({ id: 'm365-111111111111' }),
        etag: '"agent-2"',
      },
    ]);

    const response = await GET();
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.data.isGlobalAdmin).toBe(false);
    expect(body.data.m365Agents).toHaveLength(1);
    expect(body.data.m365Agents[0].agent).toMatchObject({
      id: 'm365-abcdefabcdef',
      createdBy: 'admin@example.org',
      sources: [{ itemId: 'item1' }],
    });
  });

  it('allows a delegated non-creator to replace sources but denies an undelegated agent', async () => {
    const { resolveAdminStatus } = await vi.importActual<
      typeof import('@/lib/services/agentAccess/adminAuth')
    >('@/lib/services/agentAccess/adminAuth');
    mockAdminAuth.resolveAdminStatus.mockImplementation(resolveAdminStatus);
    mockAuth.mockResolvedValue({
      ...session,
      user: {
        id: 'delegate-user',
        mail: 'delegate@example.org',
        name: 'Delegate',
      },
    });
    mockService.getSnapshot.mockReturnValue({
      config: {
        version: 1,
        localAdmins: [
          {
            email: 'delegate@example.org',
            agentKeys: ['m365-agent::m365-abcdefabcdef'],
          },
        ],
      },
      rulesUnavailable: false,
    });
    mockStore.readM365Agent.mockResolvedValue({
      m365Agent: makeAgent(),
      etag: '"etag-1"',
    });
    const requestFor = (id: string) =>
      new NextRequest('http://localhost/api/agent-access/m365-agents', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'If-Match': '"etag-1"' },
        body: JSON.stringify({
          id,
          name: 'Budget agent',
          sources: [{ ...validSource, itemId: 'replacement-file' }],
        }),
      });

    const allowed = await PUT(requestFor('m365-abcdefabcdef'));
    expect(allowed.status).toBe(200);
    expect(mockStore.writeM365Agent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        createdBy: 'admin@example.org',
        updatedBy: 'delegate@example.org',
        sources: [expect.objectContaining({ itemId: 'replacement-file' })],
      }),
      '"etag-1"',
    );
    mockStore.writeM365Agent.mockClear();
    const denied = await PUT(requestFor('m365-111111111111'));
    expect(denied.status).toBe(403);
    expect(mockStore.writeM365Agent).not.toHaveBeenCalled();
  });

  it.each([
    { cachedDelegation: true, expectedStatus: 200 },
    { cachedDelegation: false, expectedStatus: 200 },
  ])(
    'a failed management listing with cachedDelegation=$cachedDelegation returns $expectedStatus',
    async ({ cachedDelegation, expectedStatus }) => {
      const { resolveAdminStatus } = await vi.importActual<
        typeof import('@/lib/services/agentAccess/adminAuth')
      >('@/lib/services/agentAccess/adminAuth');
      mockAdminAuth.resolveAdminStatus.mockImplementation(resolveAdminStatus);
      mockAuth.mockResolvedValue({
        ...session,
        user: {
          id: 'delegate-user',
          mail: 'delegate@example.org',
          name: 'Delegate',
        },
      });
      mockService.getSnapshot.mockReturnValue({
        config: cachedDelegation
          ? {
              version: 1,
              localAdmins: [
                {
                  email: 'delegate@example.org',
                  agentKeys: ['m365-agent::m365-abcdefabcdef'],
                },
              ],
            }
          : null,
      });
      mockStore.readConfig.mockResolvedValue({
        config: {
          version: 1,
          localAdmins: [
            {
              email: 'delegate@example.org',
              agentKeys: ['m365-agent::m365-abcdefabcdef'],
            },
          ],
        },
        etag: '"config-1"',
      });
      mockStore.listAllM365Agents.mockRejectedValueOnce(
        new Error('M365 record storage unavailable'),
      );

      const response = await GET();
      expect(response.status).toBe(expectedStatus);
      const body = await parseJsonResponse(response);
      expect(body.data.m365AgentsUnavailable).toBe(true);
      expect(body.data.m365Agents).toEqual([]);
      // Management visibility does not depend on the caller's Graph access.
      expect(mockPlanner.planSources).not.toHaveBeenCalled();
    },
  );

  it('returns temporary unavailability, not a permission denial or stale authorization, when config cannot be read', async () => {
    mockStore.listAllM365Agents.mockResolvedValue([]);
    mockStore.readConfig.mockRejectedValueOnce(
      new Error('Permission store unavailable'),
    );
    const response = await GET();
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(503);
    expect(body.code).toBe('AGENT_ACCESS_CONFIG_UNAVAILABLE');
    expect(mockAdminAuth.resolveAdminStatus).not.toHaveBeenCalled();
  });

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

  it('rejects more sources than the global document ceiling', async () => {
    const sources = Array.from({ length: 201 }, (_, i) => ({
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

describe('per-agent document cap override', () => {
  const putRequest = (body: unknown) =>
    new NextRequest('http://localhost/api/agent-access/m365-agents', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': '"etag-1"' },
      body: JSON.stringify(body),
    });
  const asLocalAdmin = () =>
    mockAdminAuth.resolveAdminStatus.mockReturnValue({
      isGlobalAdmin: false,
      isLocalAdmin: true,
      editableAgentKeys: ['m365-agent::m365-abcdefabcdef'],
    });

  it.each(
    ['create', 'raise on update', 'keep stored override'].flatMap((operation) =>
      [51, 80, 81].map((documentCount) => ({ operation, documentCount })),
    ),
  )(
    '$operation: validates $documentCount files against an 80-file cap with the real planner',
    async ({ operation, documentCount }) => {
      const planner = await vi.importActual<
        typeof import('@/lib/services/m365/agentSourcePlanner')
      >('@/lib/services/m365/agentSourcePlanner');
      const { getGraphAccessToken } = await import('@/auth');
      vi.mocked(getGraphAccessToken).mockResolvedValue({
        accessToken: 'test-token',
        grantedScopes: [],
      });
      const sources = Array.from({ length: documentCount }, (_, index) => ({
        ...validSource,
        itemId: `file-${index}`,
        title: `Document-${index}.pdf`,
      }));
      const graphFetch = vi.fn(async (url: string) => {
        const itemId = new URL(url).pathname.split('/').pop()!;
        return new Response(
          JSON.stringify({
            id: itemId,
            name: `${itemId}.pdf`,
            size: 1024,
            file: {},
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      });
      planner.clearPlannerCacheForTests();
      vi.stubGlobal('fetch', graphFetch);
      mockPlanner.planSources.mockImplementation(planner.planSources);
      try {
        // Reuse metadata cached under the old cap, as happens when the
        // editor raises its limit after planning the selected files.
        const oldPlan = await planner.planSources(
          postRequest({}),
          session.user.id,
          sources.map((source) => ({ ...source, kind: 'file' as const })),
          { maxDocuments: 50 },
        );
        expect(oldPlan.overDocumentCap).toBe(true);
        expect(graphFetch).toHaveBeenCalledTimes(documentCount);

        const storedOverride = operation === 'keep stored override';
        const existing = makeAgent(
          storedOverride
            ? {
                maxDocumentsOverride: 80,
                maxDocumentsOverrideBy: 'global@example.org',
              }
            : {},
        );
        mockStore.readM365Agent.mockResolvedValue({
          m365Agent: existing,
          etag: '"etag-1"',
        });
        const body = {
          name: 'Document agent',
          sources,
          ...(!storedOverride && { maxDocumentsOverride: 80 }),
        };
        const response =
          operation === 'create'
            ? await POST(postRequest(body))
            : await PUT(putRequest({ ...body, id: existing.id }));

        expect(graphFetch).toHaveBeenCalledTimes(documentCount);
        const result = await parseJsonResponse(response);
        if (documentCount <= 80) {
          expect(response.status).toBe(200);
          expect(result.data.agent.maxDocumentsOverride).toBe(80);
          expect(result.data.agent.sources).toHaveLength(documentCount);
          expect(mockStore.writeM365Agent).toHaveBeenCalledOnce();
          if (storedOverride) {
            expect(result.data.agent.maxDocumentsOverrideBy).toBe(
              'global@example.org',
            );
          }
        } else {
          expect(response.status).toBe(400);
          expect(result.error).toBe(
            'Sources expand to 81 documents; at most 80 are allowed',
          );
          expect(mockStore.writeM365Agent).not.toHaveBeenCalled();
        }
      } finally {
        planner.clearPlannerCacheForTests();
        vi.unstubAllGlobals();
        mockPlanner.planSources.mockReset();
      }
    },
  );

  it('lets a local admin raise the cap up to their ceiling and stamps who did it', async () => {
    asLocalAdmin();
    const existing = makeAgent();
    mockStore.readM365Agent.mockResolvedValue({
      m365Agent: existing,
      etag: '"etag-1"',
    });
    const response = await PUT(
      putRequest({
        id: existing.id,
        name: 'Budget agent',
        sources: [
          {
            driveId: 'drive1',
            itemId: 'item1',
            kind: 'file',
            title: 'Budget.xlsx',
            webUrl: 'https://contoso.sharepoint.com/budget.xlsx',
          },
        ],
        maxDocumentsOverride: 100,
      }),
    );
    expect(response.status).toBe(200);
    const written = mockStore.writeM365Agent.mock.calls[0][1];
    expect(written).toMatchObject({
      maxDocumentsOverride: 100,
      maxDocumentsOverrideBy: 'admin@example.org',
    });
    expect(written.maxDocumentsOverrideAt).toEqual(expect.any(String));
    // The save-time plan judged against the raised cap.
    expect(mockPlanner.planSources.mock.calls[0][3]).toEqual({
      maxDocuments: 100,
    });
  });

  it('refuses a local admin above the local ceiling with a typed code', async () => {
    asLocalAdmin();
    const response = await POST(
      postRequest({
        name: 'X',
        sources: [validSource],
        maxDocumentsOverride: 150,
      }),
    );
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(400);
    expect(body.code).toBe('M365_CAP_ABOVE_ROLE');
    expect(body.error).toContain('100');
    expect(mockStore.writeM365Agent).not.toHaveBeenCalled();
  });

  it('lets a global admin go up to the global ceiling, not past it', async () => {
    const ok = await POST(
      postRequest({
        name: 'X',
        sources: [validSource],
        maxDocumentsOverride: 200,
      }),
    );
    expect(ok.status).toBe(200);
    const tooHigh = await POST(
      postRequest({
        name: 'X',
        sources: [validSource],
        maxDocumentsOverride: 250,
      }),
    );
    expect(tooHigh.status).toBe(400);
  });

  it('PUT: a local admin re-saving keeps a global admin’s higher raise, but cannot set one', async () => {
    asLocalAdmin();
    const existing = makeAgent({
      maxDocumentsOverride: 180,
      maxDocumentsOverrideBy: 'global@example.org',
      maxDocumentsOverrideAt: '2026-09-14T00:00:00.000Z',
    });
    mockStore.readM365Agent.mockResolvedValue({
      m365Agent: existing,
      etag: '"etag-1"',
    });
    const source = {
      driveId: 'drive1',
      itemId: 'item1',
      kind: 'file',
      title: 'Budget.xlsx',
      webUrl: 'https://contoso.sharepoint.com/budget.xlsx',
    };
    const kept = await PUT(
      putRequest({
        id: existing.id,
        name: 'Budget agent',
        sources: [source],
        maxDocumentsOverride: 180,
      }),
    );
    expect(kept.status).toBe(200);
    expect(mockStore.writeM365Agent.mock.calls[0][1]).toMatchObject({
      maxDocumentsOverride: 180,
      maxDocumentsOverrideBy: 'global@example.org',
    });

    const raised = await PUT(
      putRequest({
        id: existing.id,
        name: 'Budget agent',
        sources: [source],
        maxDocumentsOverride: 190,
      }),
    );
    expect(raised.status).toBe(400);

    const cleared = await PUT(
      putRequest({
        id: existing.id,
        name: 'Budget agent',
        sources: [source],
        maxDocumentsOverride: null,
      }),
    );
    expect(cleared.status).toBe(200);
    const written = mockStore.writeM365Agent.mock.calls[1][1];
    expect(written.maxDocumentsOverride).toBeUndefined();
    expect(written.maxDocumentsOverrideBy).toBeUndefined();
  });

  it('PUT without the field keeps the stored override (an older client cannot wipe a raise)', async () => {
    const existing = makeAgent({
      maxDocumentsOverride: 180,
      maxDocumentsOverrideBy: 'global@example.org',
      maxDocumentsOverrideAt: '2026-09-14T00:00:00.000Z',
    });
    mockStore.readM365Agent.mockResolvedValue({
      m365Agent: existing,
      etag: '"etag-1"',
    });
    const response = await PUT(
      putRequest({
        id: existing.id,
        name: 'Budget agent',
        sources: [
          {
            driveId: 'drive1',
            itemId: 'item1',
            kind: 'file',
            title: 'Budget.xlsx',
            webUrl: 'https://contoso.sharepoint.com/budget.xlsx',
          },
        ],
      }),
    );
    expect(response.status).toBe(200);
    expect(mockStore.writeM365Agent.mock.calls[0][1]).toMatchObject({
      maxDocumentsOverride: 180,
      maxDocumentsOverrideBy: 'global@example.org',
    });
  });

  it('GET serves the role ceilings and the caller’s role', async () => {
    mockStore.listAllM365Agents?.mockResolvedValue?.([]);
    const response = await GET();
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.data.maxDocumentsCeilings).toEqual({
      localAdmin: 100,
      globalAdmin: 200,
    });
    expect(body.data.isGlobalAdmin).toBe(true);
  });
});

describe('independent document limit updates', () => {
  const capRequest = (body: unknown, etag = '"etag-1"') =>
    new NextRequest('http://localhost/api/agent-access/m365-agents', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'If-Match': etag },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    mockStore.readM365Agent.mockResolvedValue({
      m365Agent: makeAgent(),
      etag: '"etag-1"',
    });
  });

  it('persists only the cap and audit history without planning or indexing sources', async () => {
    const existing = makeAgent({
      autoOcr: true,
      systemPrompt: 'Keep this prompt',
    });
    mockStore.readM365Agent.mockResolvedValue({
      m365Agent: existing,
      etag: '"etag-1"',
    });
    const response = await PATCH(
      capRequest({ id: existing.id, maxDocumentsOverride: 80 }),
    );
    expect(response.status).toBe(200);
    const body = await parseJsonResponse(response);
    expect(body.data).toMatchObject({
      etag: '"etag-1"',
      agent: { maxDocumentsOverride: 80 },
    });
    const written = mockStore.writeM365Agent.mock.calls[0][1];
    expect(written).toMatchObject({
      ...existing,
      maxDocumentsOverride: 80,
      maxDocumentsOverrideBy: 'admin@example.org',
      maxDocumentsOverrideAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(mockPlanner.planSources).not.toHaveBeenCalled();
    expect(mockIndexService.purgeSourcesFromIndex).not.toHaveBeenCalled();
    expect(mockStore.writeM365AgentHistoryEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ m365Agent: written }),
    );
  });

  it('resets only the override on an explicit null request', async () => {
    const existing = makeAgent({
      maxDocumentsOverride: 80,
      maxDocumentsOverrideBy: 'global@example.org',
    });
    mockStore.readM365Agent.mockResolvedValue({
      m365Agent: existing,
      etag: '"etag-1"',
    });
    const response = await PATCH(
      capRequest({ id: existing.id, maxDocumentsOverride: null }),
    );
    expect(response.status).toBe(200);
    const written = mockStore.writeM365Agent.mock.calls[0][1];
    expect(written.maxDocumentsOverride).toBeUndefined();
    expect(written.maxDocumentsOverrideBy).toBeUndefined();
    expect(written.sources).toEqual(existing.sources);
  });

  it.each([
    {},
    { maxDocumentsOverride: 0 },
    { maxDocumentsOverride: 80.5 },
    { maxDocumentsOverride: 80, name: 'Unrelated edit' },
  ])('rejects an invalid or mixed cap update: %j', async (fields) => {
    const response = await PATCH(
      capRequest({ id: 'm365-abcdefabcdef', ...fields }),
    );
    expect(response.status).toBe(400);
    expect(mockStore.writeM365Agent).not.toHaveBeenCalled();
  });

  it('rejects stale writes before a cap check can misreport the default limit', async () => {
    mockStore.readM365Agent.mockResolvedValue({
      m365Agent: makeAgent({ maxDocumentsOverride: 80 }),
      etag: '"new-etag"',
    });
    const cap = await PATCH(
      capRequest({ id: 'm365-abcdefabcdef', maxDocumentsOverride: 100 }),
    );
    expect(cap.status).toBe(409);
    const save = await PUT(
      new NextRequest('http://localhost/api/agent-access/m365-agents', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'If-Match': '"etag-1"' },
        body: JSON.stringify({
          id: 'm365-abcdefabcdef',
          name: 'Old draft',
          sources: [validSource],
          maxDocumentsOverride: null,
        }),
      }),
    );
    expect(save.status).toBe(409);
    expect(mockPlanner.planSources).not.toHaveBeenCalled();
    expect(mockStore.writeM365Agent).not.toHaveBeenCalled();
  });

  it('enforces delegated edit permissions and the local role ceiling', async () => {
    mockAdminAuth.resolveAdminStatus.mockReturnValue({
      isGlobalAdmin: false,
      isLocalAdmin: true,
      editableAgentKeys: [],
    });
    const denied = await PATCH(
      capRequest({ id: 'm365-abcdefabcdef', maxDocumentsOverride: 80 }),
    );
    expect(denied.status).toBe(403);
    mockAdminAuth.resolveAdminStatus.mockReturnValue({
      isGlobalAdmin: false,
      isLocalAdmin: true,
      editableAgentKeys: ['m365-agent::m365-abcdefabcdef'],
    });
    const aboveRole = await PATCH(
      capRequest({ id: 'm365-abcdefabcdef', maxDocumentsOverride: 150 }),
    );
    expect(aboveRole.status).toBe(400);
    expect((await parseJsonResponse(aboveRole)).code).toBe(
      'M365_CAP_ABOVE_ROLE',
    );
    expect(mockStore.writeM365Agent).not.toHaveBeenCalled();
  });
});
