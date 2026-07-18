import { clearOauthDiscoveryCache } from '@/lib/services/mcp/mcpOauthDiscovery';

import {
  createMockRequest,
  createMockSession,
  parseJsonResponse,
} from './helpers';

import { GET as availabilityGET } from '@/app/api/mcp/oauth/availability/route';
import { POST as discoverPOST } from '@/app/api/mcp/oauth/discover/route';
import { POST as registerPOST } from '@/app/api/mcp/oauth/register/route';
import { POST as tokenPOST } from '@/app/api/mcp/oauth/token/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const mockDiscoverInfo = vi.hoisted(() => vi.fn());
const mockRegisterClient = vi.hoisted(() => vi.fn());
const mockExchange = vi.hoisted(() => vi.fn());
const mockRefresh = vi.hoisted(() => vi.fn());
const mockLookup = vi.hoisted(() => vi.fn());
const mockEnv = vi.hoisted(() => ({
  MCP_CUSTOM_SERVERS_ENABLED: false,
  NEXTAUTH_URL: 'https://assistant.msf.org',
  MCP_OAUTH_GITHUB_CLIENT_ID: undefined as string | undefined,
  MCP_OAUTH_GITHUB_CLIENT_SECRET: undefined as string | undefined,
  MCP_OAUTH_ASANA_CLIENT_ID: undefined as string | undefined,
  MCP_OAUTH_ASANA_CLIENT_SECRET: undefined as string | undefined,
}));

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/config/environment', () => ({ env: mockEnv }));
vi.mock('node:dns/promises', () => ({ lookup: mockLookup }));
vi.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({
  discoverOAuthServerInfo: mockDiscoverInfo,
  registerClient: mockRegisterClient,
  exchangeAuthorization: mockExchange,
  refreshAuthorization: mockRefresh,
}));

const asanaServer = { id: 'asana', name: 'Asana', catalogKey: 'asana' };

const publicMetadata = {
  issuer: 'https://auth.asana.example',
  authorization_endpoint: 'https://auth.asana.example/authorize',
  token_endpoint: 'https://auth.asana.example/token',
  registration_endpoint: 'https://auth.asana.example/register',
  scopes_supported: ['default'],
};

describe('/api/mcp/oauth/*', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearOauthDiscoveryCache();
    mockEnv.MCP_CUSTOM_SERVERS_ENABLED = false;
    mockEnv.MCP_OAUTH_GITHUB_CLIENT_ID = undefined;
    mockEnv.MCP_OAUTH_GITHUB_CLIENT_SECRET = undefined;
    mockEnv.MCP_OAUTH_ASANA_CLIENT_ID = undefined;
    mockEnv.MCP_OAUTH_ASANA_CLIENT_SECRET = undefined;
    mockAuth.mockResolvedValue(createMockSession());
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    mockDiscoverInfo.mockResolvedValue({
      authorizationServerUrl: 'https://auth.asana.example',
      authorizationServerMetadata: publicMetadata,
    });
  });

  it('discover returns the authorization endpoint for a catalog server', async () => {
    const res = await discoverPOST(
      createMockRequest({ method: 'POST', body: { server: asanaServer } }),
    );
    const json = await parseJsonResponse(res);

    expect(res.status).toBe(200);
    expect(json.data.authorizationEndpoint).toBe(
      'https://auth.asana.example/authorize',
    );
    expect(json.data.registrationSupported).toBe(true);
    // Discovery ran against the CATALOG url, not anything client-sent.
    expect(mockDiscoverInfo.mock.calls[0][0]).toBe('https://mcp.asana.com/sse');
  });

  it('rejects requests carrying endpoint-shaped fields (open-relay prevention)', async () => {
    const res = await tokenPOST(
      createMockRequest({
        method: 'POST',
        body: {
          server: asanaServer,
          grant: {
            type: 'refresh_token',
            refreshToken: 'rt',
            clientId: 'c1',
            // an attacker-steered endpoint must be rejected by .strict()
            tokenEndpoint: 'https://attacker.example/token',
          },
        },
      }),
    );

    expect(res.status).toBe(400);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('rejects discovered endpoints that point at private addresses', async () => {
    mockDiscoverInfo.mockResolvedValue({
      authorizationServerUrl: 'https://auth.asana.example',
      authorizationServerMetadata: {
        ...publicMetadata,
        token_endpoint: 'https://169.254.169.254/token',
      },
    });

    const res = await discoverPOST(
      createMockRequest({ method: 'POST', body: { server: asanaServer } }),
    );
    const json = await parseJsonResponse(res);

    expect(res.status).toBe(502);
    expect(json.code).toBe('OAUTH_DISCOVERY_REJECTED');
  });

  it('register builds client metadata server-side with the CONFIGURED origin', async () => {
    mockRegisterClient.mockResolvedValue({ client_id: 'dcr-123' });

    const res = await registerPOST(
      createMockRequest({
        method: 'POST',
        body: { server: asanaServer },
        // A spoofed Host header must not leak into the redirect URI.
        headers: { host: 'attacker.example' },
      }),
    );
    const json = await parseJsonResponse(res);

    expect(res.status).toBe(200);
    expect(json.data.clientId).toBe('dcr-123');
    const clientMetadata = mockRegisterClient.mock.calls[0][1].clientMetadata;
    expect(clientMetadata.redirect_uris).toEqual([
      'https://assistant.msf.org/mcp-oauth-callback',
    ]);
    expect(clientMetadata.token_endpoint_auth_method).toBe('none');
  });

  it('register errors clearly when the provider lacks DCR', async () => {
    mockDiscoverInfo.mockResolvedValue({
      authorizationServerUrl: 'https://auth.asana.example',
      authorizationServerMetadata: {
        ...publicMetadata,
        registration_endpoint: undefined,
      },
    });

    const res = await registerPOST(
      createMockRequest({ method: 'POST', body: { server: asanaServer } }),
    );
    const json = await parseJsonResponse(res);

    expect(res.status).toBe(502);
    expect(json.code).toBe('OAUTH_DCR_UNSUPPORTED');
  });

  it('token exchanges an authorization code and passes tokens through', async () => {
    mockExchange.mockResolvedValue({
      access_token: 'at-1',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'rt-1',
    });

    const res = await tokenPOST(
      createMockRequest({
        method: 'POST',
        body: {
          server: asanaServer,
          grant: {
            type: 'authorization_code',
            code: 'code-1',
            codeVerifier: 'verifier-1',
            clientId: 'dcr-123',
          },
        },
      }),
    );
    const json = await parseJsonResponse(res);

    expect(res.status).toBe(200);
    expect(json.data.tokens.access_token).toBe('at-1');
    const args = mockExchange.mock.calls[0][1];
    expect(args.redirectUri).toBe(
      'https://assistant.msf.org/mcp-oauth-callback',
    );
    expect(args.authorizationCode).toBe('code-1');
  });

  it('maps invalid_grant to a stable OAUTH_INVALID_GRANT code without echoing secrets', async () => {
    mockRefresh.mockRejectedValue(
      new Error(
        'Token refresh failed: invalid_grant (refresh token rt-secret expired)',
      ),
    );

    const res = await tokenPOST(
      createMockRequest({
        method: 'POST',
        body: {
          server: asanaServer,
          grant: {
            type: 'refresh_token',
            refreshToken: 'rt-secret',
            clientId: 'c1',
          },
        },
      }),
    );
    const json = await parseJsonResponse(res);

    expect(res.status).toBe(400);
    expect(json.code).toBe('OAUTH_INVALID_GRANT');
    expect(JSON.stringify(json)).not.toContain('rt-secret');
  });

  it('custom servers are gated off when MCP_CUSTOM_SERVERS_ENABLED=false', async () => {
    const res = await discoverPOST(
      createMockRequest({
        method: 'POST',
        body: {
          server: { id: 'c1', name: 'Mine', url: 'https://mcp.example.com' },
        },
      }),
    );

    expect(res.status).toBe(403);
    expect(mockDiscoverInfo).not.toHaveBeenCalled();
  });

  it('all three routes 401 without a session', async () => {
    mockAuth.mockResolvedValue(null);
    const body = { server: asanaServer };

    for (const route of [discoverPOST, registerPOST]) {
      const res = await route(createMockRequest({ method: 'POST', body }));
      expect(res.status).toBe(401);
    }
    const res = await tokenPOST(
      createMockRequest({
        method: 'POST',
        body: {
          ...body,
          grant: { type: 'refresh_token', refreshToken: 'rt', clientId: 'c' },
        },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('register returns the pre-registered client id WITHOUT the secret and skips DCR', async () => {
    mockEnv.MCP_OAUTH_GITHUB_CLIENT_ID = 'gh-static-id';
    mockEnv.MCP_OAUTH_GITHUB_CLIENT_SECRET = 'gh-static-secret';

    const res = await registerPOST(
      createMockRequest({
        method: 'POST',
        body: {
          server: { id: 'github', name: 'GitHub', catalogKey: 'github' },
        },
      }),
    );
    const json = await parseJsonResponse(res);

    expect(res.status).toBe(200);
    expect(json.data.clientId).toBe('gh-static-id');
    expect(JSON.stringify(json)).not.toContain('gh-static-secret');
    expect(mockRegisterClient).not.toHaveBeenCalled();
    // Static registration doesn't even need discovery.
    expect(mockDiscoverInfo).not.toHaveBeenCalled();
  });

  it('token injects the static client secret server-side, ignoring any browser-sent one', async () => {
    mockEnv.MCP_OAUTH_GITHUB_CLIENT_ID = 'gh-static-id';
    mockEnv.MCP_OAUTH_GITHUB_CLIENT_SECRET = 'gh-static-secret';
    mockExchange.mockResolvedValue({
      access_token: 'at',
      token_type: 'Bearer',
    });

    const res = await tokenPOST(
      createMockRequest({
        method: 'POST',
        body: {
          server: { id: 'github', name: 'GitHub', catalogKey: 'github' },
          grant: {
            type: 'authorization_code',
            code: 'code-1',
            codeVerifier: 'v',
            clientId: 'gh-static-id',
            clientSecret: 'browser-supplied-should-be-ignored',
          },
        },
      }),
    );

    expect(res.status).toBe(200);
    const clientInformation = mockExchange.mock.calls[0][1].clientInformation;
    expect(clientInformation).toEqual({
      client_id: 'gh-static-id',
      client_secret: 'gh-static-secret',
    });
  });

  it('register without DCR support and no static client returns OAUTH_DCR_UNSUPPORTED', async () => {
    mockDiscoverInfo.mockResolvedValue({
      authorizationServerUrl: 'https://github.com/login/oauth',
      authorizationServerMetadata: {
        authorization_endpoint: 'https://github.com/login/oauth/authorize',
        token_endpoint: 'https://github.com/login/oauth/access_token',
      },
    });

    const res = await registerPOST(
      createMockRequest({
        method: 'POST',
        body: {
          server: { id: 'github', name: 'GitHub', catalogKey: 'github' },
        },
      }),
    );
    const json = await parseJsonResponse(res);

    expect(res.status).toBe(502);
    expect(json.code).toBe('OAUTH_DCR_UNSUPPORTED');
  });
  it('token passes a browser-sent secret through for a NON-static clientId (own app)', async () => {
    // A deployment app exists, but the user connected with their OWN app.
    mockEnv.MCP_OAUTH_GITHUB_CLIENT_ID = 'gh-static-id';
    mockEnv.MCP_OAUTH_GITHUB_CLIENT_SECRET = 'gh-static-secret';
    mockExchange.mockResolvedValue({
      access_token: 'at',
      token_type: 'Bearer',
    });
    mockDiscoverInfo.mockResolvedValue({
      authorizationServerUrl: 'https://github.com/login/oauth',
      authorizationServerMetadata: {
        authorization_endpoint: 'https://github.com/login/oauth/authorize',
        token_endpoint: 'https://github.com/login/oauth/access_token',
      },
    });

    const res = await tokenPOST(
      createMockRequest({
        method: 'POST',
        body: {
          server: { id: 'github', name: 'GitHub', catalogKey: 'github' },
          grant: {
            type: 'authorization_code',
            code: 'code-1',
            codeVerifier: 'v',
            clientId: 'users-own-app-id',
            clientSecret: 'users-own-app-secret',
          },
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(mockExchange.mock.calls[0][1].clientInformation).toEqual({
      client_id: 'users-own-app-id',
      client_secret: 'users-own-app-secret',
    });
  });

  describe('GET /availability', () => {
    it('reports every oauth-capable catalog key as unavailable with no env apps', async () => {
      const res = await availabilityGET();
      const body = await parseJsonResponse(res);

      expect(res.status).toBe(200);
      expect(body.data.availability).toEqual({ github: false, asana: false });
    });

    it('reports only the connectors whose app is configured', async () => {
      mockEnv.MCP_OAUTH_ASANA_CLIENT_ID = 'asana-static-id';

      const body = await parseJsonResponse(await availabilityGET());

      expect(body.data.availability).toEqual({ github: false, asana: true });
    });

    it('never leaks the client id or secret — booleans only', async () => {
      mockEnv.MCP_OAUTH_GITHUB_CLIENT_ID = 'gh-static-id';
      mockEnv.MCP_OAUTH_GITHUB_CLIENT_SECRET = 'gh-static-secret';

      const raw = JSON.stringify(
        await parseJsonResponse(await availabilityGET()),
      );

      expect(raw).not.toContain('gh-static-id');
      expect(raw).not.toContain('gh-static-secret');
    });

    it('requires a session', async () => {
      mockAuth.mockResolvedValue(null);

      expect((await availabilityGET()).status).toBe(401);
    });
  });
});
