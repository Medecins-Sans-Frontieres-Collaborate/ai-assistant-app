import { NextRequest } from 'next/server';

import type { McpConnector } from '@/lib/services/agentAccess/types';

import { parseJsonResponse } from './helpers';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const serviceMock = vi.hoisted(() => ({
  isEnabled: vi.fn(() => true),
  ensureFresh: vi.fn(async () => {}),
  getConnectors: vi.fn<() => McpConnector[]>(() => []),
  evaluateAccess: vi.fn(() => ({ decision: 'allow', reason: 'no-rule' })),
}));

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: { getInstance: () => serviceMock },
  emitAccessAudit: vi.fn(),
}));

const { GET } = await import('@/app/api/mcp/connectors/route');

function makeConnector(overrides: Partial<McpConnector> = {}): McpConnector {
  return {
    version: 1,
    id: 'connector-abc123def456',
    name: 'Contoso NetSuite',
    description: 'Look up records',
    url: 'https://acct123.suitetalk.api.netsuite.com/services/mcp/v1/all',
    transport: 'streamable-http',
    authStyle: 'bearer',
    oauthScopes: [],
    createdBy: 'admin@contoso.com',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedBy: 'admin@contoso.com',
    updatedAt: '2026-07-18T00:00:00.000Z',
    ...overrides,
  };
}

describe('GET /api/mcp/connectors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMock.isEnabled.mockReturnValue(true);
    serviceMock.getConnectors.mockReturnValue([]);
    serviceMock.evaluateAccess.mockReturnValue({
      decision: 'allow',
      reason: 'no-rule',
    });
    mockAuth.mockResolvedValue({
      user: { id: 'u1', mail: 'user@contoso.com' },
    });
  });

  it('401s an unauthenticated caller', async () => {
    mockAuth.mockResolvedValue(null);

    expect(
      (await GET(new NextRequest('http://localhost/api/mcp/connectors')))
        .status,
    ).toBe(401);
  });

  it('returns an empty list when the feature is disabled', async () => {
    serviceMock.isEnabled.mockReturnValue(false);

    const body = await parseJsonResponse(
      await GET(new NextRequest('http://localhost/api/mcp/connectors')),
    );

    expect(body.data.connectors).toEqual([]);
    expect(serviceMock.ensureFresh).not.toHaveBeenCalled();
  });

  it('never exposes the connector URL or OAuth client id', async () => {
    serviceMock.getConnectors.mockReturnValue([
      makeConnector({
        authStyle: 'oauth',
        oauthClientId: 'secret-client-id',
        oauthClientSecret: { v: 1, alg: 'A256GCM', iv: 'aXY=', ct: 'Y3Q=' },
      }),
    ]);

    const body = await parseJsonResponse(
      await GET(new NextRequest('http://localhost/api/mcp/connectors')),
    );
    const serialized = JSON.stringify(body);

    expect(serialized).not.toContain('suitetalk.api.netsuite.com');
    expect(serialized).not.toContain('secret-client-id');
    expect(serialized).not.toContain('A256GCM');
    // …but the client still learns it can start a flow.
    expect(body.data.connectors[0].oauthAppConfigured).toBe(true);
  });

  it('omits connectors this user is not permitted to use', async () => {
    const allowed = makeConnector({ id: 'connector-aaaaaaaaaaaa' });
    const denied = makeConnector({ id: 'connector-bbbbbbbbbbbb' });
    serviceMock.getConnectors.mockReturnValue([allowed, denied]);
    serviceMock.evaluateAccess.mockImplementation(
      ({ agentName }: { agentName: string }) =>
        agentName === allowed.id
          ? { decision: 'allow', reason: 'allow-domain' }
          : { decision: 'deny', reason: 'not-allowed' },
    );

    const body = await parseJsonResponse(
      await GET(new NextRequest('http://localhost/api/mcp/connectors')),
    );

    expect(body.data.connectors).toHaveLength(1);
    expect(body.data.connectors[0].id).toBe(allowed.id);
  });

  it('omits connectors when the ruleset is unavailable', async () => {
    // Listing something chat would then refuse to resolve is worse than
    // omitting it — the two paths must agree.
    serviceMock.getConnectors.mockReturnValue([makeConnector()]);
    serviceMock.evaluateAccess.mockReturnValue({
      decision: 'unavailable',
      reason: 'rules-unavailable',
    });

    const body = await parseJsonResponse(
      await GET(new NextRequest('http://localhost/api/mcp/connectors')),
    );

    expect(body.data.connectors).toEqual([]);
  });

  it('reports oauthAppConfigured false when no client id is stored', async () => {
    serviceMock.getConnectors.mockReturnValue([
      makeConnector({ authStyle: 'oauth' }),
    ]);

    const body = await parseJsonResponse(
      await GET(new NextRequest('http://localhost/api/mcp/connectors')),
    );

    expect(body.data.connectors[0].oauthAppConfigured).toBe(false);
  });

  it('passes presentation fields through for a bearer connector', async () => {
    serviceMock.getConnectors.mockReturnValue([
      makeConnector({ tokenHelpUrl: 'https://help.example.com/tokens' }),
    ]);

    const body = await parseJsonResponse(
      await GET(new NextRequest('http://localhost/api/mcp/connectors')),
    );

    expect(body.data.connectors[0]).toMatchObject({
      name: 'Contoso NetSuite',
      description: 'Look up records',
      authStyle: 'bearer',
      tokenHelpUrl: 'https://help.example.com/tokens',
      oauthAppConfigured: false,
    });
  });
});
