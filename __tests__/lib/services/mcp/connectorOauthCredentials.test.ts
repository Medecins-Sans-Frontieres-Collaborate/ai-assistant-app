import type { McpConnector } from '@/lib/services/agentAccess/types';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  AUTH_SECRET: 'test-server-secret' as string | undefined,
  NEXTAUTH_SECRET: undefined as string | undefined,
  MCP_CUSTOM_SERVERS_ENABLED: false,
  MCP_OAUTH_GITHUB_CLIENT_ID: undefined as string | undefined,
  MCP_OAUTH_GITHUB_CLIENT_SECRET: undefined as string | undefined,
  MCP_OAUTH_ASANA_CLIENT_ID: undefined as string | undefined,
  MCP_OAUTH_ASANA_CLIENT_SECRET: undefined as string | undefined,
  MCP_OAUTH_TABLEAU_CLIENT_ID: undefined as string | undefined,
  MCP_OAUTH_TABLEAU_CLIENT_SECRET: undefined as string | undefined,
  MCP_OAUTH_SALESFORCE_CLIENT_ID: undefined as string | undefined,
  MCP_OAUTH_SALESFORCE_CLIENT_SECRET: undefined as string | undefined,
  MCP_OAUTH_HOOTSUITE_CLIENT_ID: undefined as string | undefined,
  MCP_OAUTH_HOOTSUITE_CLIENT_SECRET: undefined as string | undefined,
}));

const serviceMock = vi.hoisted(() => ({
  isEnabled: vi.fn(() => true),
  ensureFresh: vi.fn(async () => {}),
  getConnectorById: vi.fn<(id: string) => McpConnector | null>(() => null),
  getCatalogOauthApp: vi.fn<
    (
      key: string,
    ) => import('@/lib/services/agentAccess/types').CatalogOauthApp | null
  >(() => null),
}));

vi.mock('@/config/environment', () => ({ env: mockEnv }));
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: { getInstance: () => serviceMock },
  emitAccessAudit: vi.fn(),
}));

const { McpOauthError, getOauthClientCredentials } =
  await import('@/lib/services/mcp/mcpOauthDiscovery');
const { sealConnectorSecret } =
  await import('@/lib/services/agentAccess/connectorSecretCrypto');

const CONNECTOR_ID = 'connector-abc123def456';

function makeConnector(overrides: Partial<McpConnector> = {}): McpConnector {
  return {
    version: 1,
    id: CONNECTOR_ID,
    name: 'Contoso NetSuite',
    description: '',
    url: 'https://acct123.suitetalk.api.netsuite.com/services/mcp/v1/all',
    transport: 'streamable-http',
    authStyle: 'oauth',
    oauthScopes: [],
    createdBy: 'admin@contoso.com',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedBy: 'admin@contoso.com',
    updatedAt: '2026-07-18T00:00:00.000Z',
    ...overrides,
  };
}

describe('getOauthClientCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.AUTH_SECRET = 'test-server-secret';
    serviceMock.isEnabled.mockReturnValue(true);
    serviceMock.getCatalogOauthApp.mockReturnValue(null);
    mockEnv.MCP_OAUTH_GITHUB_CLIENT_ID = undefined;
    mockEnv.MCP_OAUTH_GITHUB_CLIENT_SECRET = undefined;
  });

  describe('catalog entries', () => {
    it('returns the env-configured app', async () => {
      mockEnv.MCP_OAUTH_GITHUB_CLIENT_ID = 'gh-id';
      mockEnv.MCP_OAUTH_GITHUB_CLIENT_SECRET = 'gh-secret';

      await expect(
        getOauthClientCredentials({ catalogKey: 'github' }),
      ).resolves.toEqual({ clientId: 'gh-id', clientSecret: 'gh-secret' });
    });

    it('returns null when no app is configured, leaving DCR as the fallback', async () => {
      mockEnv.MCP_OAUTH_GITHUB_CLIENT_ID = undefined;

      await expect(
        getOauthClientCredentials({ catalogKey: 'github' }),
      ).resolves.toBeNull();
    });
  });

  describe('catalog entries — admin records (Admin → Connectors)', () => {
    const adminApp = {
      version: 1 as const,
      id: 'github',
      clientId: 'admin-client',
      createdBy: 'global@example.com',
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedBy: 'global@example.com',
      updatedAt: '2026-08-20T00:00:00.000Z',
    };

    it('prefers an admin-stored app over the env pair', async () => {
      mockEnv.MCP_OAUTH_GITHUB_CLIENT_ID = 'env-client';
      mockEnv.MCP_OAUTH_GITHUB_CLIENT_SECRET = 'env-secret';
      serviceMock.getCatalogOauthApp.mockReturnValue({
        ...adminApp,
        clientSecret: sealConnectorSecret('github', 'admin-secret'),
      });

      await expect(
        getOauthClientCredentials({ catalogKey: 'github' }),
      ).resolves.toEqual({
        clientId: 'admin-client',
        clientSecret: 'admin-secret',
      });
    });

    it('supports secretless (public-client) admin records', async () => {
      serviceMock.getCatalogOauthApp.mockReturnValue(adminApp);

      await expect(
        getOauthClientCredentials({ catalogKey: 'github' }),
      ).resolves.toEqual({ clientId: 'admin-client' });
    });

    it('falls back to env when agent access control is disabled', async () => {
      serviceMock.isEnabled.mockReturnValue(false);
      mockEnv.MCP_OAUTH_GITHUB_CLIENT_ID = 'env-client';

      await expect(
        getOauthClientCredentials({ catalogKey: 'github' }),
      ).resolves.toEqual({ clientId: 'env-client', clientSecret: undefined });
      expect(serviceMock.getCatalogOauthApp).not.toHaveBeenCalled();
    });

    it('surfaces an unreadable sealed secret as CONNECTOR_SECRET_UNREADABLE instead of falling back to env', async () => {
      mockEnv.MCP_OAUTH_GITHUB_CLIENT_ID = 'env-client';
      serviceMock.getCatalogOauthApp.mockReturnValue({
        ...adminApp,
        // Sealed under a DIFFERENT id — the AAD check must fail.
        clientSecret: sealConnectorSecret('asana', 'admin-secret'),
      });

      await expect(
        getOauthClientCredentials({ catalogKey: 'github' }),
      ).rejects.toMatchObject({ code: 'CONNECTOR_SECRET_UNREADABLE' });
    });
  });

  describe('admin connectors', () => {
    it('unseals the stored client secret', async () => {
      serviceMock.getConnectorById.mockReturnValue(
        makeConnector({
          oauthClientId: 'connector-client-id',
          oauthClientSecret: sealConnectorSecret(CONNECTOR_ID, 'the-secret'),
        }),
      );

      await expect(
        getOauthClientCredentials({ connectorId: CONNECTOR_ID }),
      ).resolves.toEqual({
        clientId: 'connector-client-id',
        clientSecret: 'the-secret',
      });
    });

    it('treats a connector with an id but no secret as a public client', async () => {
      serviceMock.getConnectorById.mockReturnValue(
        makeConnector({ oauthClientId: 'connector-client-id' }),
      );

      await expect(
        getOauthClientCredentials({ connectorId: CONNECTOR_ID }),
      ).resolves.toEqual({ clientId: 'connector-client-id' });
    });

    it('returns null for a connector with no OAuth app, allowing DCR', async () => {
      serviceMock.getConnectorById.mockReturnValue(makeConnector());

      await expect(
        getOauthClientCredentials({ connectorId: CONNECTOR_ID }),
      ).resolves.toBeNull();
    });

    it('returns null for an unknown connector', async () => {
      serviceMock.getConnectorById.mockReturnValue(null);

      await expect(
        getOauthClientCredentials({ connectorId: CONNECTOR_ID }),
      ).resolves.toBeNull();
    });

    it('raises a distinct error when the secret cannot be unsealed', async () => {
      // The shape of an AUTH_SECRET rotation: falling back to DCR here would
      // authenticate as the wrong client and fail confusingly at the vendor.
      serviceMock.getConnectorById.mockReturnValue(
        makeConnector({
          oauthClientId: 'connector-client-id',
          oauthClientSecret: sealConnectorSecret(CONNECTOR_ID, 'the-secret'),
        }),
      );
      mockEnv.AUTH_SECRET = 'a-rotated-secret';

      await expect(
        getOauthClientCredentials({ connectorId: CONNECTOR_ID }),
      ).rejects.toThrow(McpOauthError);
      await expect(
        getOauthClientCredentials({ connectorId: CONNECTOR_ID }),
      ).rejects.toMatchObject({ code: 'CONNECTOR_SECRET_UNREADABLE' });
    });

    it('never leaks the plaintext secret through the error', async () => {
      serviceMock.getConnectorById.mockReturnValue(
        makeConnector({
          oauthClientId: 'connector-client-id',
          oauthClientSecret: sealConnectorSecret(
            CONNECTOR_ID,
            'super-secret-value',
          ),
        }),
      );
      mockEnv.AUTH_SECRET = 'a-rotated-secret';

      // Assert on the caught value directly — `rejects.not.toThrow(...)`
      // passes vacuously and would not catch a leak.
      const error = await getOauthClientCredentials({
        connectorId: CONNECTOR_ID,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(McpOauthError);
      expect(
        JSON.stringify({ ...(error as object), message: String(error) }),
      ).not.toContain('super-secret-value');
    });

    it('prefers the connector when both keys are somehow present', async () => {
      mockEnv.MCP_OAUTH_GITHUB_CLIENT_ID = 'gh-id';
      serviceMock.getConnectorById.mockReturnValue(
        makeConnector({ oauthClientId: 'connector-client-id' }),
      );

      await expect(
        getOauthClientCredentials({
          catalogKey: 'github',
          connectorId: CONNECTOR_ID,
        }),
      ).resolves.toEqual({ clientId: 'connector-client-id' });
    });
  });
});
