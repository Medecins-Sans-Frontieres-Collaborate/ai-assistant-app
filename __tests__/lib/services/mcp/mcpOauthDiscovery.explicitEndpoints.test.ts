import type { ResolvedMcpServer } from '@/config/mcpCatalog';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The admin-stored-endpoints path of resolveOauthContext: a connector that
 * carries explicit OAuth endpoints (NetSuite publishes no discovery metadata)
 * must produce its context WITHOUT any network discovery, while every stored
 * endpoint still passes the same public-https re-validation as a discovered
 * one — hand-edited blobs included.
 */

const discoverOAuthServerInfo = vi.hoisted(() => vi.fn());
const assertPublicHost = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({
  discoverOAuthServerInfo,
}));
vi.mock('@/lib/services/mcp/mcpUrlGuard', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/mcp/mcpUrlGuard')>();
  return {
    ...actual,
    // Shape checks stay real; only the DNS resolution is stubbed out.
    assertPublicHost,
    guardedFetch: vi.fn(),
  };
});
vi.mock('@/config/environment', () => ({
  env: { MCP_CUSTOM_SERVERS_ENABLED: false },
}));

const { McpOauthError, clearOauthDiscoveryCache, resolveOauthContext } =
  await import('@/lib/services/mcp/mcpOauthDiscovery');

const AUTH_URL =
  'https://acct123.app.netsuite.com/app/login/oauth2/authorize.nl';
const TOKEN_URL =
  'https://acct123.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token';

function connectorResolver(
  endpoints: ResolvedMcpServer['oauthEndpoints'],
): (connectorId: string) => ResolvedMcpServer | null {
  return () => ({
    id: 'connector-abc123def456',
    label: 'Contoso NetSuite',
    url: 'https://acct123.suitetalk.api.netsuite.com/services/mcp/v1/all',
    transport: 'streamable-http',
    auth: { style: 'oauth' },
    trusted: true,
    oauthEndpoints: endpoints,
  });
}

const entry = {
  id: 'srv1',
  name: 'NetSuite',
  connectorId: 'connector-abc123def456',
};

describe('resolveOauthContext with admin-stored endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearOauthDiscoveryCache();
  });

  it('builds the context from the stored endpoints without network discovery', async () => {
    const context = await resolveOauthContext(entry, {
      resolveConnector: connectorResolver({
        authorizationUrl: AUTH_URL,
        tokenUrl: TOKEN_URL,
      }),
    });

    expect(context.metadata).toEqual({
      authorization_endpoint: AUTH_URL,
      token_endpoint: TOKEN_URL,
    });
    expect(context.authorizationServerUrl).toBe(
      'https://acct123.suitetalk.api.netsuite.com',
    );
    expect(context.refreshTokenEndpoint).toBeUndefined();
    expect(discoverOAuthServerInfo).not.toHaveBeenCalled();
  });

  it('surfaces a refresh endpoint only when it differs from the token URL', async () => {
    const distinct = await resolveOauthContext(entry, {
      resolveConnector: connectorResolver({
        authorizationUrl: AUTH_URL,
        tokenUrl: TOKEN_URL,
        refreshUrl: 'https://acct123.suitetalk.api.netsuite.com/refresh',
      }),
    });
    expect(distinct.refreshTokenEndpoint).toBe(
      'https://acct123.suitetalk.api.netsuite.com/refresh',
    );

    const same = await resolveOauthContext(entry, {
      resolveConnector: connectorResolver({
        authorizationUrl: AUTH_URL,
        tokenUrl: TOKEN_URL,
        refreshUrl: TOKEN_URL,
      }),
    });
    expect(same.refreshTokenEndpoint).toBeUndefined();
  });

  it.each([
    [
      'http authorization URL',
      { authorizationUrl: 'http://x.example.com/a', tokenUrl: TOKEN_URL },
    ],
    [
      'loopback token URL',
      { authorizationUrl: AUTH_URL, tokenUrl: 'https://127.0.0.1/token' },
    ],
    [
      'private-range refresh URL',
      {
        authorizationUrl: AUTH_URL,
        tokenUrl: TOKEN_URL,
        refreshUrl: 'https://10.0.0.5/r',
      },
    ],
  ])(
    'rejects a %s even though it was admin-stored',
    async (_label, endpoints) => {
      await expect(
        resolveOauthContext(entry, {
          resolveConnector: connectorResolver(endpoints),
        }),
      ).rejects.toMatchObject({ code: 'OAUTH_DISCOVERY_REJECTED' });
      expect(discoverOAuthServerInfo).not.toHaveBeenCalled();
    },
  );

  it('still runs discovery for a connector without stored endpoints', async () => {
    discoverOAuthServerInfo.mockResolvedValue({
      authorizationServerUrl: 'https://auth.example.com',
      authorizationServerMetadata: {
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
      },
    });

    const context = await resolveOauthContext(entry, {
      resolveConnector: connectorResolver(undefined),
    });

    expect(discoverOAuthServerInfo).toHaveBeenCalledOnce();
    expect(context.metadata.token_endpoint).toBe(
      'https://auth.example.com/token',
    );
  });

  it('is an McpOauthError that the routes can map to a client-safe response', async () => {
    const failure = resolveOauthContext(entry, {
      resolveConnector: connectorResolver({
        authorizationUrl: AUTH_URL,
        tokenUrl: 'https://169.254.169.254/token',
      }),
    });

    await expect(failure).rejects.toBeInstanceOf(McpOauthError);
    await expect(failure).rejects.toMatchObject({ status: 502 });
  });
});
