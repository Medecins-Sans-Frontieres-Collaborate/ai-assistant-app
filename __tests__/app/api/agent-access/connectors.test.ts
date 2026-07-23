import { NextRequest } from 'next/server';

import {
  AgentAccessConflictError,
  StoredMcpConnector,
  createAgentAccessBlobStorage,
  deleteConnector,
  listAllConnectors,
  readConfig,
  readConnector,
  writeConfig,
  writeConnector,
  writeConnectorHistoryEntry,
} from '@/lib/services/agentAccess/accessRulesStore';
import {
  AgentAccessConfig,
  MCP_CONNECTOR_SOURCE,
  McpConnector,
  canonicalAgentKey,
  connectorBlobPath,
} from '@/lib/services/agentAccess/types';

import { parseJsonResponse } from '../helpers';

import {
  DELETE,
  GET,
  POST,
  PUT,
} from '@/app/api/agent-access/connectors/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const serviceIsEnabled = vi.hoisted(() => vi.fn());
const serviceEnsureFresh = vi.hoisted(() => vi.fn());
const serviceGetSnapshot = vi.hoisted(() => vi.fn());
const serviceInvalidate = vi.hoisted(() => vi.fn());
const mockEnv = vi.hoisted(() => ({
  AGENT_ACCESS_CONTROL_ENABLED: true,
  AGENT_ACCESS_ADMINS: 'global@example.com',
  AUTH_SECRET: 'test-server-secret' as string | undefined,
  NEXTAUTH_SECRET: undefined as string | undefined,
}));

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/config/environment', () => ({ env: mockEnv }));
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: {
    getInstance: () => ({
      isEnabled: serviceIsEnabled,
      ensureFresh: serviceEnsureFresh,
      getSnapshot: serviceGetSnapshot,
      invalidate: serviceInvalidate,
    }),
  },
}));

// Keep AgentAccessConflictError (instanceof mapping to 409) real; mock only
// the blob accessors — same pattern as the prompt-agents route tests.
vi.mock(
  '@/lib/services/agentAccess/accessRulesStore',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@/lib/services/agentAccess/accessRulesStore')
      >();
    return {
      ...actual,
      createAgentAccessBlobStorage: vi.fn(),
      listAllConnectors: vi.fn(),
      readConnector: vi.fn(),
      writeConnector: vi.fn(),
      deleteConnector: vi.fn(),
      writeConnectorHistoryEntry: vi.fn(),
      readConfig: vi.fn(),
      writeConfig: vi.fn(),
    };
  },
);

const CONNECTOR_ID = 'connector-abc123def456';
const ETAG = '"etag-1"';
const VALID_URL =
  'https://acct123.suitetalk.api.netsuite.com/services/mcp/v1/all';

function makeConnector(overrides: Partial<McpConnector> = {}): McpConnector {
  return {
    version: 1,
    id: CONNECTOR_ID,
    name: 'Contoso NetSuite',
    description: '',
    url: VALID_URL,
    transport: 'streamable-http',
    authStyle: 'bearer',
    oauthScopes: [],
    createdBy: 'global@example.com',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedBy: 'global@example.com',
    updatedAt: '2026-07-18T00:00:00.000Z',
    ...overrides,
  };
}

function stored(connector: McpConnector): StoredMcpConnector {
  return {
    canonicalKey: canonicalAgentKey(MCP_CONNECTOR_SOURCE, connector.id),
    blobPath: connectorBlobPath(connector.id),
    connector,
    etag: ETAG,
  };
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest(
    'https://app.example.com/api/agent-access/connectors',
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
}

function putRequest(body: unknown, ifMatch: string | null = ETAG): NextRequest {
  return new NextRequest(
    'https://app.example.com/api/agent-access/connectors',
    {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: ifMatch === null ? {} : { 'if-match': ifMatch },
    },
  );
}

function deleteRequest(id: string, ifMatch: string | null = ETAG): NextRequest {
  return new NextRequest(
    `https://app.example.com/api/agent-access/connectors?id=${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
      headers: ifMatch === null ? {} : { 'if-match': ifMatch },
    },
  );
}

const validBody = {
  name: 'Contoso NetSuite',
  url: VALID_URL,
  transport: 'streamable-http',
  authStyle: 'bearer',
};

const emptyConfig: AgentAccessConfig = {
  version: 1,
  localAdmins: [],
  updatedBy: 'global@example.com',
  updatedAt: '2026-07-18T00:00:00.000Z',
};

describe('/api/agent-access/connectors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.AGENT_ACCESS_CONTROL_ENABLED = true;
    mockEnv.AUTH_SECRET = 'test-server-secret';
    mockEnv.NEXTAUTH_SECRET = undefined;
    serviceIsEnabled.mockReturnValue(true);
    serviceGetSnapshot.mockReturnValue({ config: emptyConfig });
    mockAuth.mockResolvedValue({
      user: { id: 'u1', mail: 'global@example.com' },
    });
    vi.mocked(createAgentAccessBlobStorage).mockReturnValue({} as never);
    vi.mocked(listAllConnectors).mockResolvedValue([]);
    vi.mocked(readConfig).mockResolvedValue({
      config: emptyConfig,
      etag: '"cfg"',
    });
    vi.mocked(writeConnector).mockResolvedValue(ETAG);
    vi.mocked(deleteConnector).mockResolvedValue(true);
    vi.mocked(writeConnectorHistoryEntry).mockResolvedValue(undefined);
  });

  describe('gating', () => {
    it('404s for everyone while the feature is disabled', async () => {
      serviceIsEnabled.mockReturnValue(false);

      expect((await GET()).status).toBe(404);
      expect((await POST(postRequest(validBody))).status).toBe(404);
    });

    it('401s an unauthenticated caller', async () => {
      mockAuth.mockResolvedValue(null);

      expect((await GET()).status).toBe(401);
    });

    it('403s an authenticated non-admin', async () => {
      mockAuth.mockResolvedValue({
        user: { id: 'u2', mail: 'nobody@example.com' },
      });

      expect((await GET()).status).toBe(403);
      expect((await POST(postRequest(validBody))).status).toBe(403);
    });
  });

  describe('GET', () => {
    it('never exposes the sealed secret — only hasClientSecret', async () => {
      const connector = makeConnector({
        authStyle: 'oauth',
        oauthClientId: 'client-id',
        oauthClientSecret: {
          v: 1,
          alg: 'A256GCM',
          iv: 'aXY=',
          ct: 'Y3Q=',
        },
      });
      vi.mocked(listAllConnectors).mockResolvedValue([stored(connector)]);

      const body = await parseJsonResponse(await GET());
      const serialized = JSON.stringify(body);

      expect(body.data.connectors[0].connector.hasClientSecret).toBe(true);
      expect(
        body.data.connectors[0].connector.oauthClientSecret,
      ).toBeUndefined();
      // Belt-and-braces: no fragment of the envelope anywhere in the payload.
      expect(serialized).not.toContain('A256GCM');
      expect(serialized).not.toContain('Y3Q=');
    });

    it('reports hasClientSecret false when none is stored', async () => {
      vi.mocked(listAllConnectors).mockResolvedValue([stored(makeConnector())]);

      const body = await parseJsonResponse(await GET());

      expect(body.data.connectors[0].connector.hasClientSecret).toBe(false);
    });

    it('tells the client whether secret sealing is available', async () => {
      mockEnv.AUTH_SECRET = undefined;

      const body = await parseJsonResponse(await GET());

      expect(body.data.secretSealingAvailable).toBe(false);
    });

    it('degrades to an empty flagged listing on a storage outage', async () => {
      vi.mocked(listAllConnectors).mockRejectedValue(new Error('storage down'));

      const res = await GET();
      const body = await parseJsonResponse(res);

      expect(res.status).toBe(200);
      expect(body.data.connectorsUnavailable).toBe(true);
      expect(body.data.connectors).toEqual([]);
    });

    it('shows a local admin only their delegated connectors', async () => {
      const mine = makeConnector();
      const theirs = makeConnector({ id: 'connector-999999999999' });
      vi.mocked(listAllConnectors).mockResolvedValue([
        stored(mine),
        stored(theirs),
      ]);
      const config: AgentAccessConfig = {
        ...emptyConfig,
        localAdmins: [
          {
            email: 'local@example.com',
            agentKeys: [canonicalAgentKey(MCP_CONNECTOR_SOURCE, mine.id)],
          },
        ],
      };
      vi.mocked(readConfig).mockResolvedValue({ config, etag: '"cfg"' });
      mockAuth.mockResolvedValue({
        user: { id: 'u3', mail: 'local@example.com' },
      });

      const body = await parseJsonResponse(await GET());

      expect(body.data.connectors).toHaveLength(1);
      expect(body.data.connectors[0].connector.id).toBe(mine.id);
    });
  });

  describe('POST', () => {
    it('creates a bearer connector', async () => {
      const res = await POST(postRequest(validBody));
      const body = await parseJsonResponse(res);

      expect(res.status).toBe(200);
      expect(body.data.connector.url).toBe(VALID_URL);
      expect(body.data.canonicalKey).toMatch(/^mcp-connector::connector-/);
      expect(writeConnector).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ authStyle: 'bearer' }),
        null,
      );
    });

    it('seals the oauth client secret before it reaches storage', async () => {
      await POST(
        postRequest({
          ...validBody,
          authStyle: 'oauth',
          oauthClientId: 'client-id',
          oauthClientSecret: 'super-secret-value',
        }),
      );

      const written = vi.mocked(writeConnector).mock.calls[0][1];
      expect(written.oauthClientSecret).toMatchObject({ alg: 'A256GCM' });
      expect(JSON.stringify(written)).not.toContain('super-secret-value');
    });

    it('refuses the oauth style with 503 when no server secret is configured', async () => {
      mockEnv.AUTH_SECRET = undefined;
      mockEnv.NEXTAUTH_SECRET = undefined;

      const res = await POST(
        postRequest({
          ...validBody,
          authStyle: 'oauth',
          oauthClientId: 'client-id',
          oauthClientSecret: 'super-secret-value',
        }),
      );
      const body = await parseJsonResponse(res);

      expect(res.status).toBe(503);
      expect(body.code ?? body.error?.code).toBe(
        'CONNECTOR_SECRETS_UNCONFIGURED',
      );
      expect(writeConnector).not.toHaveBeenCalled();
    });

    it('still allows bearer connectors when sealing is unavailable', async () => {
      mockEnv.AUTH_SECRET = undefined;

      expect((await POST(postRequest(validBody))).status).toBe(200);
    });

    it.each([
      ['http (not https)', 'http://example.com/mcp'],
      ['loopback', 'https://127.0.0.1/mcp'],
      ['link-local metadata', 'https://169.254.169.254/mcp'],
      ['private range', 'https://10.0.0.5/mcp'],
    ])('rejects a %s url', async (_label, url) => {
      const res = await POST(postRequest({ ...validBody, url }));

      expect(res.status).toBe(400);
      expect(writeConnector).not.toHaveBeenCalled();
    });

    it('rejects oauth fields on a non-oauth connector', async () => {
      const res = await POST(
        postRequest({ ...validBody, oauthClientId: 'sneaky' }),
      );

      expect(res.status).toBe(400);
    });

    it('requires a client id and secret for oauth', async () => {
      expect(
        (await POST(postRequest({ ...validBody, authStyle: 'oauth' }))).status,
      ).toBe(400);
      expect(
        (
          await POST(
            postRequest({
              ...validBody,
              authStyle: 'oauth',
              oauthClientId: 'client-id',
            }),
          )
        ).status,
      ).toBe(400);
    });

    describe('explicit oauth endpoint URLs', () => {
      const oauthBody = {
        ...validBody,
        authStyle: 'oauth',
        oauthClientId: 'client-id',
        oauthClientSecret: 'secret',
      };
      const AUTH_URL =
        'https://acct123.app.netsuite.com/app/login/oauth2/authorize.nl';
      const TOKEN_URL =
        'https://acct123.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token';

      it('stores the authorization/token/refresh trio', async () => {
        const res = await POST(
          postRequest({
            ...oauthBody,
            oauthAuthorizationUrl: AUTH_URL,
            oauthTokenUrl: TOKEN_URL,
            oauthRefreshUrl: TOKEN_URL,
          }),
        );
        const body = await parseJsonResponse(res);

        expect(res.status).toBe(200);
        expect(writeConnector).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            oauthAuthorizationUrl: AUTH_URL,
            oauthTokenUrl: TOKEN_URL,
            oauthRefreshUrl: TOKEN_URL,
          }),
          null,
        );
        // Round-tripped to the editor (unlike the secret).
        expect(body.data.connector.oauthTokenUrl).toBe(TOKEN_URL);
      });

      it('accepts the pair without a refresh URL', async () => {
        const res = await POST(
          postRequest({
            ...oauthBody,
            oauthAuthorizationUrl: AUTH_URL,
            oauthTokenUrl: TOKEN_URL,
          }),
        );

        expect(res.status).toBe(200);
      });

      it.each([
        ['authorization URL alone', { oauthAuthorizationUrl: AUTH_URL }],
        ['token URL alone', { oauthTokenUrl: TOKEN_URL }],
        ['refresh URL alone', { oauthRefreshUrl: TOKEN_URL }],
      ])('rejects a %s', async (_label, fields) => {
        const res = await POST(postRequest({ ...oauthBody, ...fields }));

        expect(res.status).toBe(400);
        expect(writeConnector).not.toHaveBeenCalled();
      });

      // A still-templated {accountid} host parses as a legal URL and is the
      // EDITOR's job to block, matching the main server URL's contract.
      it.each([
        ['http token URL', 'http://acct.netsuite.com/token'],
        ['loopback token URL', 'https://127.0.0.1/token'],
        ['link-local metadata token URL', 'https://169.254.169.254/token'],
      ])('rejects a %s', async (_label, tokenUrl) => {
        const res = await POST(
          postRequest({
            ...oauthBody,
            oauthAuthorizationUrl: AUTH_URL,
            oauthTokenUrl: tokenUrl,
          }),
        );

        expect(res.status).toBe(400);
        expect(writeConnector).not.toHaveBeenCalled();
      });

      it('rejects endpoint URLs on a non-oauth connector', async () => {
        const res = await POST(
          postRequest({ ...validBody, oauthTokenUrl: TOKEN_URL }),
        );

        expect(res.status).toBe(400);
      });
    });

    it('rejects unknown fields', async () => {
      const res = await POST(
        postRequest({ ...validBody, somethingElse: 'nope' }),
      );

      expect(res.status).toBe(400);
    });

    it('delegates a local admin creation to its creator', async () => {
      const config: AgentAccessConfig = {
        ...emptyConfig,
        localAdmins: [{ email: 'local@example.com', agentKeys: [] }],
      };
      serviceGetSnapshot.mockReturnValue({ config });
      vi.mocked(readConfig).mockResolvedValue({ config, etag: '"cfg"' });
      vi.mocked(writeConfig).mockResolvedValue('"cfg2"');
      mockAuth.mockResolvedValue({
        user: { id: 'u3', mail: 'local@example.com' },
      });

      const res = await POST(postRequest(validBody));

      expect(res.status).toBe(200);
      expect(writeConfig).toHaveBeenCalled();
      const updated = vi.mocked(writeConfig).mock.calls[0][1];
      expect(updated.localAdmins[0].agentKeys[0]).toMatch(
        /^mcp-connector::connector-/,
      );
    });

    it('rolls the create back when delegation cannot be recorded', async () => {
      const config: AgentAccessConfig = {
        ...emptyConfig,
        localAdmins: [{ email: 'local@example.com', agentKeys: [] }],
      };
      serviceGetSnapshot.mockReturnValue({ config });
      // Delegation target vanished between authorization and write.
      vi.mocked(readConfig).mockResolvedValue(null);
      mockAuth.mockResolvedValue({
        user: { id: 'u3', mail: 'local@example.com' },
      });

      const res = await POST(postRequest(validBody));

      expect(res.status).toBe(503);
      expect(deleteConnector).toHaveBeenCalled();
    });
  });

  describe('PUT', () => {
    beforeEach(() => {
      vi.mocked(readConnector).mockResolvedValue({
        connector: makeConnector(),
        etag: ETAG,
      });
    });

    it('requires a quoted strong ETag', async () => {
      expect(
        (await PUT(putRequest({ ...validBody, id: CONNECTOR_ID }, null)))
          .status,
      ).toBe(400);
      expect(
        (await PUT(putRequest({ ...validBody, id: CONNECTOR_ID }, '*'))).status,
      ).toBe(400);
      expect(
        (await PUT(putRequest({ ...validBody, id: CONNECTOR_ID }, 'W/"weak"')))
          .status,
      ).toBe(400);
    });

    it('rejects an id that is not a server-generated connector id', async () => {
      const res = await PUT(putRequest({ ...validBody, id: '../config' }));

      expect(res.status).toBe(400);
      expect(writeConnector).not.toHaveBeenCalled();
    });

    it('keeps the stored secret when the field is omitted', async () => {
      const sealed = { v: 1, alg: 'A256GCM', iv: 'aXY=', ct: 'Y3Q=' } as const;
      vi.mocked(readConnector).mockResolvedValue({
        connector: makeConnector({
          authStyle: 'oauth',
          oauthClientId: 'client-id',
          oauthClientSecret: sealed,
        }),
        etag: ETAG,
      });

      const res = await PUT(
        putRequest({
          ...validBody,
          id: CONNECTOR_ID,
          authStyle: 'oauth',
          oauthClientId: 'client-id',
        }),
      );

      expect(res.status).toBe(200);
      expect(
        vi.mocked(writeConnector).mock.calls[0][1].oauthClientSecret,
      ).toEqual(sealed);
    });

    it('reseals when a new secret is supplied', async () => {
      vi.mocked(readConnector).mockResolvedValue({
        connector: makeConnector({
          authStyle: 'oauth',
          oauthClientId: 'client-id',
          oauthClientSecret: { v: 1, alg: 'A256GCM', iv: 'aXY=', ct: 'Y3Q=' },
        }),
        etag: ETAG,
      });

      await PUT(
        putRequest({
          ...validBody,
          id: CONNECTOR_ID,
          authStyle: 'oauth',
          oauthClientId: 'client-id',
          oauthClientSecret: 'rotated-secret',
        }),
      );

      const written = vi.mocked(writeConnector).mock.calls[0][1];
      expect(written.oauthClientSecret?.ct).not.toBe('Y3Q=');
      expect(JSON.stringify(written)).not.toContain('rotated-secret');
    });

    it('drops the secret when switching away from oauth', async () => {
      vi.mocked(readConnector).mockResolvedValue({
        connector: makeConnector({
          authStyle: 'oauth',
          oauthClientId: 'client-id',
          oauthClientSecret: { v: 1, alg: 'A256GCM', iv: 'aXY=', ct: 'Y3Q=' },
        }),
        etag: ETAG,
      });

      await PUT(putRequest({ ...validBody, id: CONNECTOR_ID }));

      const written = vi.mocked(writeConnector).mock.calls[0][1];
      expect(written.oauthClientSecret).toBeUndefined();
      expect(written.oauthClientId).toBeUndefined();
    });

    it('drops stored oauth endpoint URLs when switching away from oauth', async () => {
      vi.mocked(readConnector).mockResolvedValue({
        connector: makeConnector({
          authStyle: 'oauth',
          oauthClientId: 'client-id',
          oauthClientSecret: { v: 1, alg: 'A256GCM', iv: 'aXY=', ct: 'Y3Q=' },
          oauthAuthorizationUrl: 'https://acct.app.netsuite.com/authorize',
          oauthTokenUrl: 'https://acct.suitetalk.api.netsuite.com/token',
          oauthRefreshUrl: 'https://acct.suitetalk.api.netsuite.com/token',
        }),
        etag: ETAG,
      });

      await PUT(putRequest({ ...validBody, id: CONNECTOR_ID }));

      const written = vi.mocked(writeConnector).mock.calls[0][1];
      expect(written.oauthAuthorizationUrl).toBeUndefined();
      expect(written.oauthTokenUrl).toBeUndefined();
      expect(written.oauthRefreshUrl).toBeUndefined();
    });

    it('clears stored oauth endpoint URLs omitted from an oauth update', async () => {
      // Unlike the secret, these round-trip to the editor — omission is the
      // admin's intent (fall back to discovery), not "keep what is stored".
      vi.mocked(readConnector).mockResolvedValue({
        connector: makeConnector({
          authStyle: 'oauth',
          oauthClientId: 'client-id',
          oauthClientSecret: { v: 1, alg: 'A256GCM', iv: 'aXY=', ct: 'Y3Q=' },
          oauthAuthorizationUrl: 'https://acct.app.netsuite.com/authorize',
          oauthTokenUrl: 'https://acct.suitetalk.api.netsuite.com/token',
        }),
        etag: ETAG,
      });

      await PUT(
        putRequest({
          ...validBody,
          id: CONNECTOR_ID,
          authStyle: 'oauth',
          oauthClientId: 'client-id',
        }),
      );

      const written = vi.mocked(writeConnector).mock.calls[0][1];
      expect(written.oauthAuthorizationUrl).toBeUndefined();
      expect(written.oauthTokenUrl).toBeUndefined();
    });

    it('404s an unknown connector', async () => {
      vi.mocked(readConnector).mockResolvedValue(null);

      expect(
        (await PUT(putRequest({ ...validBody, id: CONNECTOR_ID }))).status,
      ).toBe(404);
    });

    it('403s a local admin editing a key they do not hold', async () => {
      const config: AgentAccessConfig = {
        ...emptyConfig,
        localAdmins: [{ email: 'local@example.com', agentKeys: [] }],
      };
      serviceGetSnapshot.mockReturnValue({ config });
      mockAuth.mockResolvedValue({
        user: { id: 'u3', mail: 'local@example.com' },
      });

      const res = await PUT(putRequest({ ...validBody, id: CONNECTOR_ID }));

      expect(res.status).toBe(403);
      expect(writeConnector).not.toHaveBeenCalled();
    });

    it('maps a CAS conflict to 409', async () => {
      vi.mocked(writeConnector).mockRejectedValue(
        new AgentAccessConflictError(),
      );

      const res = await PUT(putRequest({ ...validBody, id: CONNECTOR_ID }));
      const body = await parseJsonResponse(res);

      expect(res.status).toBe(409);
      expect(body.code ?? body.error?.code).toBe('AGENT_ACCESS_CONFLICT');
    });
  });

  describe('DELETE', () => {
    it('requires a quoted strong ETag', async () => {
      expect((await DELETE(deleteRequest(CONNECTOR_ID, null))).status).toBe(
        400,
      );
      expect((await DELETE(deleteRequest(CONNECTOR_ID, '*'))).status).toBe(400);
    });

    it('rejects a malformed id', async () => {
      expect((await DELETE(deleteRequest('../config'))).status).toBe(400);
      expect(deleteConnector).not.toHaveBeenCalled();
    });

    it('deletes and records a tombstone', async () => {
      const res = await DELETE(deleteRequest(CONNECTOR_ID));

      expect(res.status).toBe(200);
      expect(writeConnectorHistoryEntry).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'delete', connector: null }),
      );
    });

    it('404s when the blob was already gone', async () => {
      vi.mocked(deleteConnector).mockResolvedValue(false);

      expect((await DELETE(deleteRequest(CONNECTOR_ID))).status).toBe(404);
    });
  });
});
