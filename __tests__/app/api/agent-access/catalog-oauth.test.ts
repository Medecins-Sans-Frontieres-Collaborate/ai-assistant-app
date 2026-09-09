import { NextRequest } from 'next/server';

import {
  deleteCatalogOauthApp,
  listAllCatalogOauthApps,
  readCatalogOauthApp,
  writeCatalogOauthApp,
  writeCatalogOauthAppHistoryEntry,
} from '@/lib/services/agentAccess/accessRulesStore';
import {
  CATALOG_OAUTH_SOURCE,
  CatalogOauthApp,
  canonicalAgentKey,
  catalogOauthBlobPath,
} from '@/lib/services/agentAccess/types';

import { parseJsonResponse } from '../helpers';

import { DELETE, GET, PUT } from '@/app/api/agent-access/catalog-oauth/route';
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
  // getStaticOauthClient reads these for the env-fallback layer.
  MCP_OAUTH_GITHUB_CLIENT_ID: undefined as string | undefined,
  MCP_OAUTH_GITHUB_CLIENT_SECRET: undefined as string | undefined,
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
      listAllCatalogOauthApps: vi.fn(),
      readCatalogOauthApp: vi.fn(),
      writeCatalogOauthApp: vi.fn(),
      deleteCatalogOauthApp: vi.fn(),
      writeCatalogOauthAppHistoryEntry: vi.fn(),
    };
  },
);

const ETAG = '"etag-1"';

function makeApp(overrides: Partial<CatalogOauthApp> = {}): CatalogOauthApp {
  return {
    version: 1,
    id: 'github',
    clientId: 'Iv1.deadbeef',
    createdBy: 'global@example.com',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedBy: 'global@example.com',
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
}

function putRequest(
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest('http://localhost/api/agent-access/catalog-oauth', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function deleteRequest(
  catalogKey: string,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(
    `http://localhost/api/agent-access/catalog-oauth?catalogKey=${catalogKey}`,
    { method: 'DELETE', headers },
  );
}

function signInAs(mail: string | undefined) {
  mockAuth.mockResolvedValue(mail ? { user: { mail } } : null);
}

beforeEach(() => {
  vi.clearAllMocks();
  serviceIsEnabled.mockReturnValue(true);
  serviceEnsureFresh.mockResolvedValue(undefined);
  serviceGetSnapshot.mockReturnValue({ config: null });
  mockEnv.AUTH_SECRET = 'test-server-secret';
  mockEnv.MCP_OAUTH_GITHUB_CLIENT_ID = undefined;
  mockEnv.MCP_OAUTH_GITHUB_CLIENT_SECRET = undefined;
  signInAs('global@example.com');
  vi.mocked(listAllCatalogOauthApps).mockResolvedValue([]);
  vi.mocked(readCatalogOauthApp).mockResolvedValue(null);
  vi.mocked(writeCatalogOauthApp).mockResolvedValue('"etag-2"');
  vi.mocked(deleteCatalogOauthApp).mockResolvedValue(true);
  vi.mocked(writeCatalogOauthAppHistoryEntry).mockResolvedValue(undefined);
});

describe('catalog-oauth route gating', () => {
  it('404s while the feature is disabled, before auth', async () => {
    serviceIsEnabled.mockReturnValue(false);
    const response = await GET();
    expect(response.status).toBe(404);
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it('401s without a session', async () => {
    signInAs(undefined);
    expect((await GET()).status).toBe(401);
  });

  it('403s for a non-admin', async () => {
    signInAs('someone@example.com');
    expect((await GET()).status).toBe(403);
  });

  it('403s for a LOCAL admin — deployment config is global-admin only', async () => {
    signInAs('local@example.com');
    serviceGetSnapshot.mockReturnValue({
      config: {
        version: 1,
        localAdmins: [{ email: 'local@example.com', agentKeys: ['a::b'] }],
      },
    });
    expect((await GET()).status).toBe(403);
  });
});

describe('catalog-oauth GET', () => {
  it('lists every OAuth-capable catalog entry with layered configured state', async () => {
    mockEnv.MCP_OAUTH_GITHUB_CLIENT_ID = 'env-client';
    vi.mocked(listAllCatalogOauthApps).mockResolvedValue([
      {
        canonicalKey: canonicalAgentKey(CATALOG_OAUTH_SOURCE, 'asana'),
        blobPath: catalogOauthBlobPath('asana'),
        app: makeApp({ id: 'asana', clientId: 'asana-admin-client' }),
        etag: ETAG,
      },
    ]);

    const response = await GET();
    expect(response.status).toBe(200);
    const { data } = await parseJsonResponse(response);
    const byKey = new Map(
      (
        data.entries as Array<{
          catalogKey: string;
          envConfigured: boolean;
          adminConfigured: boolean;
          clientId: string | null;
          etag: string | null;
        }>
      ).map((e) => [e.catalogKey, e]),
    );

    // github: env layer only
    expect(byKey.get('github')).toMatchObject({
      envConfigured: true,
      adminConfigured: false,
      clientId: null,
      etag: null,
    });
    // asana: admin record (clientId echoed — it is not a secret)
    expect(byKey.get('asana')).toMatchObject({
      envConfigured: false,
      adminConfigured: true,
      clientId: 'asana-admin-client',
      etag: ETAG,
    });
    // secrets never appear anywhere in the payload
    expect(JSON.stringify(data)).not.toContain('clientSecret');
  });

  it('degrades to storageUnavailable instead of 500 on a listing failure', async () => {
    vi.mocked(listAllCatalogOauthApps).mockRejectedValue(new Error('boom'));
    const response = await GET();
    expect(response.status).toBe(200);
    const { data } = await parseJsonResponse(response);
    expect(data.storageUnavailable).toBe(true);
  });
});

describe('catalog-oauth PUT', () => {
  it('creates a record, sealing the secret under the catalog key', async () => {
    const response = await PUT(
      putRequest({
        catalogKey: 'github',
        clientId: 'Iv1.deadbeef',
        clientSecret: 'shhh',
      }),
    );
    expect(response.status).toBe(200);
    const { data } = await parseJsonResponse(response);
    expect(data.hasClientSecret).toBe(true);

    const written = vi.mocked(writeCatalogOauthApp).mock
      .calls[0][1] as CatalogOauthApp;
    expect(written.id).toBe('github');
    expect(written.clientId).toBe('Iv1.deadbeef');
    // Sealed, never plaintext
    expect(written.clientSecret).toMatchObject({ v: 1, alg: 'A256GCM' });
    expect(JSON.stringify(written.clientSecret)).not.toContain('shhh');
    // Create path: If-None-Match creation (null etag)
    expect(vi.mocked(writeCatalogOauthApp).mock.calls[0][2]).toBeNull();
    expect(serviceInvalidate).toHaveBeenCalled();
  });

  it('rejects unknown or non-OAuth catalog keys', async () => {
    const response = await PUT(
      putRequest({ catalogKey: 'not-a-connector', clientId: 'x' }),
    );
    expect(response.status).toBe(400);
    expect(writeCatalogOauthApp).not.toHaveBeenCalled();
  });

  it('409s when a record exists and no If-Match was sent', async () => {
    vi.mocked(readCatalogOauthApp).mockResolvedValue({
      app: makeApp(),
      etag: ETAG,
    });
    const response = await PUT(
      putRequest({ catalogKey: 'github', clientId: 'new-client' }),
    );
    expect(response.status).toBe(409);
    expect(writeCatalogOauthApp).not.toHaveBeenCalled();
  });

  it('keeps the stored secret when the field is omitted and clears it on empty string', async () => {
    const sealed = {
      v: 1 as const,
      alg: 'A256GCM' as const,
      iv: 'aa',
      ct: 'bb',
    };
    vi.mocked(readCatalogOauthApp).mockResolvedValue({
      app: makeApp({ clientSecret: sealed }),
      etag: ETAG,
    });

    await PUT(
      putRequest(
        { catalogKey: 'github', clientId: 'kept' },
        { 'If-Match': ETAG },
      ),
    );
    expect(
      (vi.mocked(writeCatalogOauthApp).mock.calls[0][1] as CatalogOauthApp)
        .clientSecret,
    ).toEqual(sealed);

    await PUT(
      putRequest(
        { catalogKey: 'github', clientId: 'cleared', clientSecret: '' },
        { 'If-Match': ETAG },
      ),
    );
    expect(
      (vi.mocked(writeCatalogOauthApp).mock.calls[1][1] as CatalogOauthApp)
        .clientSecret,
    ).toBeUndefined();
  });

  it('503s with CONNECTOR_SECRETS_UNCONFIGURED when no AUTH_SECRET exists', async () => {
    mockEnv.AUTH_SECRET = undefined;
    const response = await PUT(
      putRequest({
        catalogKey: 'github',
        clientId: 'x',
        clientSecret: 'shhh',
      }),
    );
    expect(response.status).toBe(503);
    const body = await parseJsonResponse(response);
    expect(body.code).toBe('CONNECTOR_SECRETS_UNCONFIGURED');
  });
});

describe('catalog-oauth DELETE', () => {
  it('deletes with If-Match and invalidates the service snapshot', async () => {
    const response = await DELETE(
      deleteRequest('github', { 'If-Match': ETAG }),
    );
    expect(response.status).toBe(200);
    expect(deleteCatalogOauthApp).toHaveBeenCalledWith(
      undefined,
      'github',
      ETAG,
    );
    expect(serviceInvalidate).toHaveBeenCalled();
  });

  it('requires a strong If-Match', async () => {
    expect((await DELETE(deleteRequest('github'))).status).toBe(400);
    expect(
      (await DELETE(deleteRequest('github', { 'If-Match': 'W/"weak"' })))
        .status,
    ).toBe(400);
  });

  it('404s when nothing was stored for the key', async () => {
    vi.mocked(deleteCatalogOauthApp).mockResolvedValue(false);
    expect(
      (await DELETE(deleteRequest('github', { 'If-Match': ETAG }))).status,
    ).toBe(404);
  });
});
