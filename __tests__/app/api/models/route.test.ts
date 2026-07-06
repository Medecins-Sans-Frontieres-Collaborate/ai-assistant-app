import { GET } from '@/app/api/models/route';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────
const mockEnv = vi.hoisted(() => ({
  NEXT_PUBLIC_MODEL_DISCOVERY_ENABLED: false,
  SHOW_MODELS_WITHOUT_METADATA: false,
  NODE_ENV: 'test',
}));
vi.mock('@/config/environment', () => ({ env: mockEnv }));

const mockAuth = vi.hoisted(() => vi.fn());
vi.mock('@/auth', () => ({ auth: mockAuth }));

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

const mockGetToken = vi.hoisted(() => vi.fn());
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {
    getToken = mockGetToken;
  },
}));

const mockGetDiscoveryAccounts = vi.hoisted(() => vi.fn());
vi.mock('@/lib/services/auth/OfficeResolver', () => ({
  OfficeResolver: {
    getModelDiscoveryAccountsForUser: mockGetDiscoveryAccounts,
  },
}));

const mockIsModelDisabled = vi.hoisted(() => vi.fn((_id: string) => false));
vi.mock('@/config/models', () => ({ isModelDisabled: mockIsModelDisabled }));

// ── Helpers ──────────────────────────────────────────────────────────────────
const REGION_PATH =
  '/subscriptions/s/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/acct/projects/default';
const US_PATH =
  '/subscriptions/s/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/acct-us/projects/default';
const EU_PATH =
  '/subscriptions/s/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/acct-eu/projects/default';

/** Routes mockListDeployedModels by account path for multi-region tests. */
function deployByPath(perPath: Record<string, unknown[] | Error>) {
  mockListDeployedModels.mockImplementation(
    async (_token: string, path: string) => {
      const entry = perPath[path];
      if (entry === undefined) {
        throw new Error(`unexpected path ${path}`);
      }
      if (entry instanceof Error) throw entry;
      return entry;
    },
  );
}

function req(url = 'http://localhost/api/models') {
  return { nextUrl: new URL(url) } as unknown as Parameters<typeof GET>[0];
}

function deployed(deploymentName: string, publisher: string) {
  return {
    deploymentName,
    modelName: deploymentName,
    publisher,
    capabilities: { chatCompletion: 'true' },
    provisioningState: 'Succeeded',
    tags: {},
  };
}

async function body(res: Awaited<ReturnType<typeof GET>>) {
  return (await res.json()) as {
    success: boolean;
    data: {
      models: { id: string; hostedIn?: string[]; tagline?: string }[];
      source: string;
    };
  };
}

beforeEach(() => {
  mockEnv.NEXT_PUBLIC_MODEL_DISCOVERY_ENABLED = false;
  mockEnv.SHOW_MODELS_WITHOUT_METADATA = false;
  mockAuth.mockResolvedValue({
    user: { id: 'user-123', mail: 'eu.user@msf.org' },
  });
  // Default: single-account (EU) user — the pre-multi-region behavior.
  mockGetDiscoveryAccounts.mockReturnValue([
    { region: 'EU', path: REGION_PATH },
  ]);
  mockGetToken.mockResolvedValue({ token: 'arm-token' });
  mockIsModelDisabled.mockImplementation(() => false);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/models', () => {
  it('401s when unauthenticated', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it('returns the static list (no discovery call) when discovery is disabled', async () => {
    mockEnv.NEXT_PUBLIC_MODEL_DISCOVERY_ENABLED = false;
    const { data } = await body(await GET(req()));
    expect(data.source).toBe('static');
    expect(mockListDeployedModels).not.toHaveBeenCalled();
    // Static list excludes isDisabled models (grok-3, claude-opus-4-1).
    expect(data.models.map((m) => m.id)).toContain('gpt-5.2');
    expect(data.models.map((m) => m.id)).not.toContain('grok-3');
  });

  it('falls back to static when no region is configured', async () => {
    mockEnv.NEXT_PUBLIC_MODEL_DISCOVERY_ENABLED = true;
    mockGetDiscoveryAccounts.mockReturnValue([]);
    const { data } = await body(await GET(req()));
    expect(data.source).toBe('static-no-region');
    expect(mockListDeployedModels).not.toHaveBeenCalled();
  });

  it('returns discovered ∩ metadata, dropping undeployed-but-hardcoded models (EU drift fix)', async () => {
    mockEnv.NEXT_PUBLIC_MODEL_DISCOVERY_ENABLED = true;
    // EU: gpt-5.2 + o3 deployed; claude-* NOT deployed.
    mockListDeployedModels.mockResolvedValue([
      deployed('gpt-5.2', 'OpenAI'),
      deployed('o3', 'OpenAI'),
    ]);
    const { data } = await body(await GET(req()));
    expect(data.source).toBe('discovery');
    const ids = data.models.map((m) => m.id);
    expect(ids.sort()).toEqual(['gpt-5.2', 'o3']);
    expect(ids).not.toContain('claude-opus-4-6');
    // Single-region user: every model is tagged with that region.
    expect(data.models.every((m) => m.hostedIn?.join() === 'EU')).toBe(true);
  });

  it('unions both regions for dual-account users with hostedIn tags (home first)', async () => {
    mockEnv.NEXT_PUBLIC_MODEL_DISCOVERY_ENABLED = true;
    mockGetDiscoveryAccounts.mockReturnValue([
      { region: 'US', path: US_PATH },
      { region: 'EU', path: EU_PATH },
    ]);
    deployByPath({
      [US_PATH]: [deployed('gpt-5.2', 'OpenAI'), deployed('o3', 'OpenAI')],
      [EU_PATH]: [
        deployed('gpt-5.2', 'OpenAI'),
        deployed('Mistral-Large-3', 'Mistral AI'),
      ],
    });
    const { data } = await body(await GET(req()));
    expect(data.source).toBe('discovery');
    const byId = Object.fromEntries(data.models.map((m) => [m.id, m]));
    expect(byId['gpt-5.2'].hostedIn).toEqual(['US', 'EU']);
    expect(byId['o3'].hostedIn).toEqual(['US']);
    expect(byId['Mistral-Large-3'].hostedIn).toEqual(['EU']);
  });

  it('home region ARM tags win on dual-region name collisions', async () => {
    mockEnv.NEXT_PUBLIC_MODEL_DISCOVERY_ENABLED = true;
    mockGetDiscoveryAccounts.mockReturnValue([
      { region: 'US', path: US_PATH },
      { region: 'EU', path: EU_PATH },
    ]);
    deployByPath({
      [US_PATH]: [
        { ...deployed('gpt-5.2', 'OpenAI'), tags: { 'ui-tagline': 'home' } },
      ],
      [EU_PATH]: [
        { ...deployed('gpt-5.2', 'OpenAI'), tags: { 'ui-tagline': 'foreign' } },
      ],
    });
    const { data } = await body(await GET(req()));
    expect(data.models[0].tagline).toBe('home');
  });

  it('degrades to discovery-partial when the FOREIGN region fails', async () => {
    mockEnv.NEXT_PUBLIC_MODEL_DISCOVERY_ENABLED = true;
    mockGetDiscoveryAccounts.mockReturnValue([
      { region: 'US', path: US_PATH },
      { region: 'EU', path: EU_PATH },
    ]);
    deployByPath({
      [US_PATH]: [deployed('gpt-5.2', 'OpenAI')],
      [EU_PATH]: new Error('EU ARM down'),
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { data } = await body(await GET(req()));
    warnSpy.mockRestore();
    expect(data.source).toBe('discovery-partial');
    expect(data.models.map((m) => m.id)).toEqual(['gpt-5.2']);
    expect(data.models[0].hostedIn).toEqual(['US']);
  });

  it('falls back to STATIC when the HOME region fails (never foreign-only)', async () => {
    mockEnv.NEXT_PUBLIC_MODEL_DISCOVERY_ENABLED = true;
    mockGetDiscoveryAccounts.mockReturnValue([
      { region: 'US', path: US_PATH },
      { region: 'EU', path: EU_PATH },
    ]);
    deployByPath({
      [US_PATH]: new Error('US ARM down'),
      [EU_PATH]: [deployed('Mistral-Large-3', 'Mistral AI')],
    });
    const { data } = await body(await GET(req()));
    // A foreign-only list would render entirely unselectable for this user —
    // worse than static. The home failure must take the static fallback.
    expect(data.source).toBe('fallback');
    expect(data.models.map((m) => m.id)).toContain('gpt-5.2');
    expect(data.models.every((m) => m.hostedIn === undefined)).toBe(true);
  });

  it('hides unknown deployed models unless SHOW_MODELS_WITHOUT_METADATA', async () => {
    mockEnv.NEXT_PUBLIC_MODEL_DISCOVERY_ENABLED = true;
    mockListDeployedModels.mockResolvedValue([
      deployed('gpt-5.2', 'OpenAI'),
      deployed('Unknown-New-Model', 'Acme AI'),
    ]);

    let { data } = await body(await GET(req()));
    expect(data.models.map((m) => m.id)).not.toContain('Unknown-New-Model');

    mockEnv.SHOW_MODELS_WITHOUT_METADATA = true;
    ({ data } = await body(await GET(req())));
    expect(data.models.map((m) => m.id)).toContain('Unknown-New-Model');
  });

  it('applies the ring gate server-side (prod-hidden model never reaches client)', async () => {
    mockEnv.NEXT_PUBLIC_MODEL_DISCOVERY_ENABLED = true;
    mockListDeployedModels.mockResolvedValue([
      deployed('gpt-5.2', 'OpenAI'),
      deployed('o3', 'OpenAI'),
    ]);
    // Simulate o3 being disabled for the current ring (e.g. prod).
    mockIsModelDisabled.mockImplementation((id) => id === 'o3');
    const { data } = await body(await GET(req()));
    expect(data.models.map((m) => m.id)).toEqual(['gpt-5.2']);
  });

  it('falls back to static on discovery failure', async () => {
    mockEnv.NEXT_PUBLIC_MODEL_DISCOVERY_ENABLED = true;
    mockListDeployedModels.mockRejectedValue(new Error('ARM 403'));
    const { data } = await body(await GET(req()));
    expect(data.source).toBe('fallback');
    expect(data.models.map((m) => m.id)).toContain('gpt-5.2');
  });

  it('busts only the caller region cache when ?refresh is present', async () => {
    mockEnv.NEXT_PUBLIC_MODEL_DISCOVERY_ENABLED = true;
    mockListDeployedModels.mockResolvedValue([deployed('gpt-5.2', 'OpenAI')]);
    await GET(req('http://localhost/api/models?refresh=1'));
    expect(mockClearCache).toHaveBeenCalledTimes(1);
    // Scoped to the caller's own region (CLEARCACHE contract), not a global wipe.
    expect(mockClearCache).toHaveBeenCalledWith(REGION_PATH);
  });

  it('busts every account the caller discovers against on ?refresh (dual-region)', async () => {
    mockEnv.NEXT_PUBLIC_MODEL_DISCOVERY_ENABLED = true;
    mockGetDiscoveryAccounts.mockReturnValue([
      { region: 'US', path: US_PATH },
      { region: 'EU', path: EU_PATH },
    ]);
    deployByPath({ [US_PATH]: [], [EU_PATH]: [] });
    await GET(req('http://localhost/api/models?refresh=1'));
    expect(mockClearCache).toHaveBeenCalledTimes(2);
    expect(mockClearCache).toHaveBeenCalledWith(US_PATH);
    expect(mockClearCache).toHaveBeenCalledWith(EU_PATH);
  });

  it('falls back to static when the app identity yields no ARM token', async () => {
    mockEnv.NEXT_PUBLIC_MODEL_DISCOVERY_ENABLED = true;
    mockGetToken.mockResolvedValue({ token: undefined });
    const { data } = await body(await GET(req()));
    expect(data.source).toBe('fallback');
    expect(mockListDeployedModels).not.toHaveBeenCalled();
    expect(data.models.map((m) => m.id)).toContain('gpt-5.2');
  });

  it('warns with a non-email user identifier when discovery is on but no region', async () => {
    mockEnv.NEXT_PUBLIC_MODEL_DISCOVERY_ENABLED = true;
    mockGetDiscoveryAccounts.mockReturnValue([]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { data } = await body(await GET(req()));
    expect(data.source).toBe('static-no-region');
    const logged = warnSpy.mock.calls.flat().join(' ');
    expect(logged).toContain('user-123');
    expect(logged).not.toContain('eu.user@msf.org');
    warnSpy.mockRestore();
  });
});
