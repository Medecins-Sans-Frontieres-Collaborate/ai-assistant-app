import { clearAccountLocationCache } from '@/lib/services/models/customModelSources';

import { GET } from '@/app/api/models/sources/route';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────
const mockAuth = vi.hoisted(() => vi.fn());
const mockGetAccessTokenForOBO = vi.hoisted(() => vi.fn());
vi.mock('@/auth', () => ({
  auth: mockAuth,
  getAccessTokenForOBO: mockGetAccessTokenForOBO,
}));

const mockGetArmToken = vi.hoisted(() => vi.fn());
vi.mock('@/lib/services/auth/UserTokenProvider', () => ({
  UserTokenProvider: {
    getInstance: () => ({ getArmToken: mockGetArmToken }),
  },
}));

const mockAppCredGetToken = vi.hoisted(() => vi.fn());
const mockCreateAppIdentityCredential = vi.hoisted(() =>
  vi.fn(async () => ({ getToken: mockAppCredGetToken })),
);
vi.mock('@/lib/services/auth/appIdentityCredential', () => ({
  createAppIdentityCredential: mockCreateAppIdentityCredential,
}));

const mockListDeployedModels = vi.hoisted(() => vi.fn());
const mockClearCache = vi.hoisted(() => vi.fn());
vi.mock('@/lib/services/models/ModelDiscoveryService', () => ({
  ModelDiscoveryService: {
    getInstance: () => ({
      listDeployedModels: mockListDeployedModels,
      clearCache: mockClearCache,
    }),
  },
}));

// ── Helpers ──────────────────────────────────────────────────────────────────
const SOURCE_A =
  '/subscriptions/s/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/user-acct-a';
const SOURCE_B =
  '/subscriptions/s/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/user-acct-b';
const SOURCE_A_PROJECT = `${SOURCE_A}/projects/default`;

const USER_ARM_TOKEN = 'user-arm-token';
const USER_SCOPE = createHash('sha256').update(USER_ARM_TOKEN).digest('hex');

function req(sources?: string, extra = '') {
  const url = new URL('http://localhost/api/models/sources');
  if (sources !== undefined) url.searchParams.set('sources', sources);
  return {
    nextUrl: new URL(url.toString() + extra),
  } as unknown as Parameters<typeof GET>[0];
}

function deployed(
  deploymentName: string,
  publisher = 'OpenAI',
  modelVersion?: string,
) {
  return {
    deploymentName,
    modelName: deploymentName,
    modelVersion,
    publisher,
    capabilities: { chatCompletion: 'true' },
    provisioningState: 'Succeeded',
    tags: {},
  };
}

async function body(res: Awaited<ReturnType<typeof GET>>) {
  return (await res.json()) as {
    sources: {
      path: string;
      location?: string;
      models: {
        id: string;
        modelSource?: string;
        isCustomSourceModel?: boolean;
        isDisabled?: boolean;
        sourceLocation?: string;
        deploymentModelVersion?: string;
      }[];
      error?: string;
    }[];
  };
}

// The route's only direct fetch is the ARM account read (location lookup) —
// discovery goes through the mocked ModelDiscoveryService.
const mockFetch = vi.fn();

beforeEach(() => {
  mockAuth.mockResolvedValue({
    user: { id: 'user-123', mail: 'user@msf.org' },
  });
  mockGetAccessTokenForOBO.mockResolvedValue('app-access-token');
  mockGetArmToken.mockResolvedValue(USER_ARM_TOKEN);
  mockAppCredGetToken.mockResolvedValue({ token: 'app-identity-arm-token' });
  mockListDeployedModels.mockResolvedValue([]);
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ location: 'swedencentral' }),
  });
  vi.stubGlobal('fetch', mockFetch);
  clearAccountLocationCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('GET /api/models/sources', () => {
  it('401s when unauthenticated', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(req(SOURCE_A));
    expect(res.status).toBe(401);
  });

  it('returns empty sources (no discovery, no token work) without a sources param', async () => {
    const { sources } = await body(await GET(req()));
    expect(sources).toEqual([]);
    expect(mockListDeployedModels).not.toHaveBeenCalled();
    expect(mockGetAccessTokenForOBO).not.toHaveBeenCalled();
  });

  it('silently drops invalid source paths (SSRF guard) and discovers the rest', async () => {
    mockListDeployedModels.mockResolvedValue([deployed('gpt-5.2')]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sources } = await body(
      await GET(req(`${SOURCE_A},/etc/passwd,https://evil.example.com`)),
    );
    expect(sources.map((s) => s.path)).toEqual([SOURCE_A]);
    expect(mockListDeployedModels).toHaveBeenCalledTimes(1);
    // Count-only warning — the dropped values themselves are not echoed.
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('2 invalid');
    warnSpy.mockRestore();
  });

  it('builds byom models under the user-scoped discovery cache', async () => {
    mockListDeployedModels.mockResolvedValue([deployed('gpt-5.2')]);
    const { sources } = await body(await GET(req(SOURCE_A)));

    expect(mockListDeployedModels).toHaveBeenCalledWith(
      USER_ARM_TOKEN,
      SOURCE_A,
      { cacheScope: USER_SCOPE },
    );
    expect(sources).toHaveLength(1);
    const model = sources[0].models[0];
    expect(model.id).toMatch(/^byom-[a-z0-9]+-gpt-5\.2$/);
    expect(model.modelSource).toBe(SOURCE_A);
    expect(model.isCustomSourceModel).toBe(true);
    expect(model.isDisabled).toBe(false);
  });

  it('enriches each source with the ARM account location and stamps it on the models', async () => {
    mockListDeployedModels.mockResolvedValue([
      deployed('gpt-5.2', 'OpenAI', '2025-04-14'),
    ]);
    const { sources } = await body(await GET(req(SOURCE_A)));

    expect(mockFetch).toHaveBeenCalledWith(
      `https://management.azure.com${SOURCE_A}?api-version=2025-12-01`,
      { headers: { Authorization: `Bearer ${USER_ARM_TOKEN}` } },
    );
    expect(sources[0].location).toBe('swedencentral');
    expect(sources[0].models[0].sourceLocation).toBe('swedencentral');
    // The ARM deployment's underlying model version rides along for display.
    expect(sources[0].models[0].deploymentModelVersion).toBe('2025-04-14');
  });

  it('strips project-scoped sources to the account for the location lookup', async () => {
    mockListDeployedModels.mockResolvedValue([deployed('gpt-5.2')]);
    await GET(req(SOURCE_A_PROJECT));
    expect(mockFetch).toHaveBeenCalledWith(
      `https://management.azure.com${SOURCE_A}?api-version=2025-12-01`,
      expect.anything(),
    );
  });

  it('tolerates ARM location failures (source keeps its models, location undefined)', async () => {
    mockListDeployedModels.mockResolvedValue([deployed('gpt-5.2')]);
    mockFetch.mockRejectedValue(new Error('ARM down'));
    const res = await GET(req(SOURCE_A));

    expect(res.status).toBe(200);
    const { sources } = await body(res);
    expect(sources[0].models).toHaveLength(1);
    expect(sources[0].location).toBeUndefined();
    expect(sources[0].models[0].sourceLocation).toBeUndefined();
    expect(sources[0].error).toBeUndefined();
  });

  it('serves the account location from the module cache on repeat calls (one ARM GET)', async () => {
    mockListDeployedModels.mockResolvedValue([deployed('gpt-5.2')]);
    await GET(req(SOURCE_A));
    const { sources } = await body(await GET(req(SOURCE_A)));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sources[0].location).toBe('swedencentral');
    expect(sources[0].models[0].sourceLocation).toBe('swedencentral');
  });

  it('reports project-scoped sources under the requested path with account-stripped modelSource', async () => {
    mockListDeployedModels.mockResolvedValue([deployed('gpt-5.2')]);
    const { sources } = await body(await GET(req(SOURCE_A_PROJECT)));
    // The response key stays the path the client configured…
    expect(sources[0].path).toBe(SOURCE_A_PROJECT);
    // …but the model routes by its ACCOUNT (deployments are account-scoped).
    expect(sources[0].models[0].modelSource).toBe(SOURCE_A);
  });

  it('isolates per-source failures (one bad source cannot break the others)', async () => {
    mockListDeployedModels.mockImplementation(
      async (_token: string, path: string) => {
        if (path === SOURCE_B) throw new Error('ARM 403 AuthorizationFailed');
        return [deployed('gpt-5.2')];
      },
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await GET(req(`${SOURCE_A},${SOURCE_B}`));
    warnSpy.mockRestore();

    expect(res.status).toBe(200);
    const { sources } = await body(res);
    const byPath = Object.fromEntries(sources.map((s) => [s.path, s]));
    expect(byPath[SOURCE_A].models).toHaveLength(1);
    expect(byPath[SOURCE_A].error).toBeUndefined();
    expect(byPath[SOURCE_B].models).toEqual([]);
    expect(byPath[SOURCE_B].error).toBe('discovery_failed');
  });

  it('fails CLOSED in production when OBO fails (no app-identity fallback)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    mockGetAccessTokenForOBO.mockResolvedValue(null);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { sources } = await body(await GET(req(SOURCE_A)));

    expect(sources).toEqual([]);
    expect(mockCreateAppIdentityCredential).not.toHaveBeenCalled();
    expect(mockListDeployedModels).not.toHaveBeenCalled();
    // Logged by user id, never email.
    const logged = errorSpy.mock.calls.flat().join(' ');
    expect(logged).toContain('user-123');
    expect(logged).not.toContain('user@msf.org');
    errorSpy.mockRestore();
  });

  it('falls back to the app identity when OBO fails outside production', async () => {
    mockGetArmToken.mockRejectedValue(new Error('OBO exchange failed'));
    mockListDeployedModels.mockResolvedValue([deployed('gpt-5.2')]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sources } = await body(await GET(req(SOURCE_A)));
    warnSpy.mockRestore();

    expect(mockCreateAppIdentityCredential).toHaveBeenCalledTimes(1);
    expect(mockAppCredGetToken).toHaveBeenCalledWith(
      'https://management.azure.com/.default',
    );
    expect(mockListDeployedModels).toHaveBeenCalledWith(
      'app-identity-arm-token',
      SOURCE_A,
      expect.anything(),
    );
    expect(sources[0].models).toHaveLength(1);
  });

  it("clears only this user's scoped cache entries on ?refresh", async () => {
    await GET(req(`${SOURCE_A},${SOURCE_B}`, '&refresh=1'));
    expect(mockClearCache).toHaveBeenCalledTimes(2);
    expect(mockClearCache).toHaveBeenCalledWith(SOURCE_A, USER_SCOPE);
    expect(mockClearCache).toHaveBeenCalledWith(SOURCE_B, USER_SCOPE);
  });

  it('does not clear the cache without ?refresh', async () => {
    await GET(req(SOURCE_A));
    expect(mockClearCache).not.toHaveBeenCalled();
  });

  it('dedupes repeated source paths', async () => {
    mockListDeployedModels.mockResolvedValue([deployed('gpt-5.2')]);
    const { sources } = await body(await GET(req(`${SOURCE_A},${SOURCE_A}`)));
    expect(sources).toHaveLength(1);
    expect(mockListDeployedModels).toHaveBeenCalledTimes(1);
  });

  it('never 500s on unexpected errors (degrades to empty sources)', async () => {
    mockGetAccessTokenForOBO.mockRejectedValue(new Error('boom'));
    mockCreateAppIdentityCredential.mockRejectedValueOnce(
      new Error('no fallback either'),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET(req(SOURCE_A));
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    expect(res.status).toBe(200);
    expect((await body(res)).sources).toEqual([]);
  });
});
