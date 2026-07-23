import { Session } from 'next-auth';

import type { McpConnector } from '@/lib/services/agentAccess/types';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const serviceMock = vi.hoisted(() => ({
  isEnabled: vi.fn(() => true),
  ensureFresh: vi.fn(async () => {}),
  getConnectorById: vi.fn<(id: string) => McpConnector | null>(() => null),
  evaluateAccess: vi.fn(() => ({ decision: 'allow', reason: 'no-rule' })),
}));
const emitAccessAudit = vi.hoisted(() => vi.fn());

vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: { getInstance: () => serviceMock },
  emitAccessAudit,
}));

const { createConnectorResolver } =
  await import('@/lib/services/mcp/connectorResolution');

const CONNECTOR: McpConnector = {
  version: 1,
  id: 'connector-abc123def456',
  name: 'Contoso NetSuite',
  description: '',
  url: 'https://acct123.suitetalk.api.netsuite.com/services/mcp/v1/all',
  transport: 'streamable-http',
  authStyle: 'bearer',
  oauthScopes: [],
  createdBy: 'admin@contoso.com',
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedBy: 'admin@contoso.com',
  updatedAt: '2026-07-18T00:00:00.000Z',
};

const session = {
  user: { id: 'u1', mail: 'user@contoso.com' },
} as unknown as Session;

describe('createConnectorResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMock.isEnabled.mockReturnValue(true);
    serviceMock.getConnectorById.mockReturnValue(CONNECTOR);
    serviceMock.evaluateAccess.mockReturnValue({
      decision: 'allow',
      reason: 'no-rule',
    });
  });

  it('resolves a permitted connector as trusted', async () => {
    const resolve = await createConnectorResolver(session);
    const resolved = resolve(CONNECTOR.id);

    expect(resolved).toMatchObject({
      id: CONNECTOR.id,
      label: 'Contoso NetSuite',
      url: CONNECTOR.url,
      transport: 'streamable-http',
      auth: { style: 'bearer' },
      trusted: true,
    });
  });

  it('denies everything when the access feature is disabled', async () => {
    // No rules engine means no way to know who may use a connector, so
    // nobody may — this must NOT degrade to "allow everyone".
    serviceMock.isEnabled.mockReturnValue(false);

    const resolve = await createConnectorResolver(session);

    expect(resolve(CONNECTOR.id)).toBeNull();
    expect(serviceMock.ensureFresh).not.toHaveBeenCalled();
  });

  it('returns null for an unknown connector id', async () => {
    serviceMock.getConnectorById.mockReturnValue(null);

    const resolve = await createConnectorResolver(session);

    expect(resolve('connector-000000000000')).toBeNull();
  });

  it('returns null when the rule denies this user', async () => {
    serviceMock.evaluateAccess.mockReturnValue({
      decision: 'deny',
      reason: 'not-allowed',
    });

    const resolve = await createConnectorResolver(session);

    expect(resolve(CONNECTOR.id)).toBeNull();
  });

  it('FAILS CLOSED when the ruleset is unavailable', async () => {
    // Discovery paths pass through on 'unavailable'; reaching a connector URL
    // is invocation, so it must not.
    serviceMock.evaluateAccess.mockReturnValue({
      decision: 'unavailable',
      reason: 'rules-unavailable',
    });

    const resolve = await createConnectorResolver(session);

    expect(resolve(CONNECTOR.id)).toBeNull();
  });

  it('evaluates against the connector pseudo-source and audits the decision', async () => {
    const resolve = await createConnectorResolver(session);
    resolve(CONNECTOR.id);

    expect(serviceMock.evaluateAccess).toHaveBeenCalledWith({
      userMail: 'user@contoso.com',
      source: 'mcp-connector',
      agentName: CONNECTOR.id,
    });
    expect(emitAccessAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userMail: 'user@contoso.com',
        decision: 'allow',
        source: 'mcp-connector',
      }),
    );
  });

  it('audits denials too, not just allows', async () => {
    serviceMock.evaluateAccess.mockReturnValue({
      decision: 'deny',
      reason: 'not-allowed',
    });

    const resolve = await createConnectorResolver(session);
    resolve(CONNECTOR.id);

    expect(emitAccessAudit).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'deny', reason: 'not-allowed' }),
    );
  });

  it('passes undefined mail through for a session without one', async () => {
    // The rules engine denies restricted agents on missing mail; the resolver
    // must hand it the real (absent) value rather than inventing one.
    const resolve = await createConnectorResolver({
      user: { id: 'u1' },
    } as unknown as Session);
    resolve(CONNECTOR.id);

    expect(serviceMock.evaluateAccess).toHaveBeenCalledWith(
      expect.objectContaining({ userMail: undefined }),
    );
  });

  it('maps the oauth auth style with its scopes', async () => {
    serviceMock.getConnectorById.mockReturnValue({
      ...CONNECTOR,
      authStyle: 'oauth',
      oauthScopes: ['read', 'write'],
    });

    const resolve = await createConnectorResolver(session);

    expect(resolve(CONNECTOR.id)?.auth).toEqual({
      style: 'oauth',
      scopes: ['read', 'write'],
    });
  });

  it('omits empty oauth scopes rather than sending an empty array', async () => {
    serviceMock.getConnectorById.mockReturnValue({
      ...CONNECTOR,
      authStyle: 'oauth',
      oauthScopes: [],
    });

    const resolve = await createConnectorResolver(session);

    expect(resolve(CONNECTOR.id)?.auth).toEqual({
      style: 'oauth',
      scopes: undefined,
    });
  });

  it('carries admin-stored oauth endpoints onto the resolved server', async () => {
    serviceMock.getConnectorById.mockReturnValue({
      ...CONNECTOR,
      authStyle: 'oauth',
      oauthAuthorizationUrl:
        'https://acct123.app.netsuite.com/app/login/oauth2/authorize.nl',
      oauthTokenUrl:
        'https://acct123.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token',
      oauthRefreshUrl:
        'https://acct123.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token',
    });

    const resolve = await createConnectorResolver(session);

    expect(resolve(CONNECTOR.id)?.oauthEndpoints).toEqual({
      authorizationUrl:
        'https://acct123.app.netsuite.com/app/login/oauth2/authorize.nl',
      tokenUrl:
        'https://acct123.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token',
      refreshUrl:
        'https://acct123.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token',
    });
  });

  it('omits oauthEndpoints entirely when the connector stores none', async () => {
    serviceMock.getConnectorById.mockReturnValue({
      ...CONNECTOR,
      authStyle: 'oauth',
    });

    const resolve = await createConnectorResolver(session);

    expect(resolve(CONNECTOR.id)).not.toHaveProperty('oauthEndpoints');
  });

  it('drops half-configured endpoints (hand-edited blob) instead of resolving them', async () => {
    // Write-time validation enforces the pair; a blob edited underneath the
    // admin API must not produce a flow with only one explicit endpoint.
    serviceMock.getConnectorById.mockReturnValue({
      ...CONNECTOR,
      authStyle: 'oauth',
      oauthTokenUrl: 'https://acct123.suitetalk.api.netsuite.com/token',
    });

    const resolve = await createConnectorResolver(session);

    expect(resolve(CONNECTOR.id)).not.toHaveProperty('oauthEndpoints');
  });

  it('maps the none auth style', async () => {
    serviceMock.getConnectorById.mockReturnValue({
      ...CONNECTOR,
      authStyle: 'none',
    });

    const resolve = await createConnectorResolver(session);

    expect(resolve(CONNECTOR.id)?.auth).toEqual({ style: 'none' });
  });

  it('refreshes the snapshot once, not per resolved entry', async () => {
    const resolve = await createConnectorResolver(session);
    resolve(CONNECTOR.id);
    resolve(CONNECTOR.id);
    resolve(CONNECTOR.id);

    expect(serviceMock.ensureFresh).toHaveBeenCalledTimes(1);
  });
});
