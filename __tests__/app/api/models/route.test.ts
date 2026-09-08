import { LimitsPolicy, LimitsPolicySchema } from '@/lib/services/limits/types';

import { GET } from '@/app/api/models/route';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────
const mockEnv = vi.hoisted(() => ({
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

// Usage-limits policy snapshot (null = nothing authored → no filtering) and
// the group-membership cache the principal is built from.
const limitsState = vi.hoisted(() => ({
  policy: null as unknown,
  ensureFreshError: null as Error | null,
  cachedGroupIds: [] as string[],
}));
vi.mock('@/lib/services/limits/LimitsService', () => ({
  LimitsService: {
    getInstance: () => ({
      ensureFresh: async () => {
        if (limitsState.ensureFreshError) throw limitsState.ensureFreshError;
      },
      getSnapshot: () => ({
        policy: limitsState.policy,
        policyUnavailable: false,
        etag: null,
        fetchedAt: 1,
      }),
    }),
  },
}));
const mockResolveUserGroupIds = vi.hoisted(() =>
  vi.fn(async () => [] as string[]),
);
vi.mock('@/lib/services/m365/groupMembership', () => ({
  resolveUserGroupIds: mockResolveUserGroupIds,
  getCachedGroupIdsForUser: () => limitsState.cachedGroupIds,
  isGroupMembershipDegradedForUser: () => false,
}));

const mockIsModelDisabled = vi.hoisted(() => vi.fn((_id: string) => false));
vi.mock('@/config/models', async () => {
  const { OpenAIModels } = await import('@/types/openai');
  return {
    isModelDisabled: mockIsModelDisabled,
    getCurrentEnvironment: () => 'prod',
    // Mirror the real helper's shape against the mockable kill switch, so
    // static-mode assertions stay meaningful.
    getStaticModelList: () =>
      Object.values(OpenAIModels).filter(
        (m) => !m.isDisabled && !mockIsModelDisabled(m.id),
      ),
  };
});

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
  limitsState.policy = null;
  limitsState.ensureFreshError = null;
  limitsState.cachedGroupIds = [];
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

  it('falls back to the vetted static list when no region is configured (discovery is always on)', async () => {
    mockGetDiscoveryAccounts.mockReturnValue([]);
    const { data } = await body(await GET(req()));
    expect(data.source).toBe('static-no-region');
    expect(mockListDeployedModels).not.toHaveBeenCalled();
    // Static list excludes isDisabled models (grok-*).
    expect(data.models.map((m) => m.id)).toContain('gpt-5.2');
    expect(data.models.map((m) => m.id)).not.toContain('grok-3');
  });

  it('returns discovered ∩ metadata, dropping undeployed-but-hardcoded models (EU drift fix)', async () => {
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
    mockListDeployedModels.mockRejectedValue(new Error('ARM 403'));
    const { data } = await body(await GET(req()));
    expect(data.source).toBe('fallback');
    expect(data.models.map((m) => m.id)).toContain('gpt-5.2');
  });

  it('busts only the caller region cache when ?refresh is present', async () => {
    mockListDeployedModels.mockResolvedValue([deployed('gpt-5.2', 'OpenAI')]);
    await GET(req('http://localhost/api/models?refresh=1'));
    expect(mockClearCache).toHaveBeenCalledTimes(1);
    // Scoped to the caller's own region (CLEARCACHE contract), not a global wipe.
    expect(mockClearCache).toHaveBeenCalledWith(REGION_PATH);
  });

  it('busts every account the caller discovers against on ?refresh (dual-region)', async () => {
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
    mockGetToken.mockResolvedValue({ token: undefined });
    const { data } = await body(await GET(req()));
    expect(data.source).toBe('fallback');
    expect(mockListDeployedModels).not.toHaveBeenCalled();
    expect(data.models.map((m) => m.id)).toContain('gpt-5.2');
  });

  it('warns with a non-email user identifier when discovery is on but no region', async () => {
    mockGetDiscoveryAccounts.mockReturnValue([]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { data } = await body(await GET(req()));
    expect(data.source).toBe('static-no-region');
    const logged = warnSpy.mock.calls.flat().join(' ');
    expect(logged).toContain('user-123');
    expect(logged).not.toContain('eu.user@msf.org');
    warnSpy.mockRestore();
  });

  /**
   * Per-user limit filtering (docs/LIMITS_USER_FACING_UX.md §7.2): the
   * picker must agree with the send. Conjunctive cells, groups warmed first,
   * hide only in enforce, fail open everywhere.
   */
  describe('usage-limit filtering', () => {
    function policyWith(
      defaults: Array<{
        limitKey: string;
        modelId?: string;
        series?: string;
        value: boolean | number | null;
      }>,
      extra: Partial<LimitsPolicy> = {},
    ): LimitsPolicy {
      return LimitsPolicySchema.parse({
        version: 1,
        defaults,
        overrides: [],
        mode: 'enforce',
        updatedBy: 'admin',
        updatedAt: '2026-01-01T00:00:00.000Z',
        ...extra,
      });
    }

    beforeEach(() => {
      // o3 + o4-mini share the o-series family; gpt-5.2 is the control.
      mockListDeployedModels.mockResolvedValue([
        deployed('gpt-5.2', 'OpenAI'),
        deployed('o3', 'OpenAI'),
        deployed('o4-mini', 'OpenAI'),
      ]);
    });

    it('a family block hides every member in enforce mode', async () => {
      limitsState.policy = policyWith([
        { limitKey: 'model.allowed', series: 'o-series', value: false },
      ]);
      const { data } = await body(await GET(req()));
      expect(data.models.map((m) => m.id).sort()).toEqual(['gpt-5.2']);
    });

    it('a model-level allow does NOT rescue a family block (conjunctive, like the send)', async () => {
      limitsState.policy = policyWith([
        { limitKey: 'model.allowed', series: 'o-series', value: false },
        { limitKey: 'model.allowed', modelId: 'o3', value: true },
      ]);
      const { data } = await body(await GET(req()));
      expect(data.models.map((m) => m.id)).not.toContain('o3');
    });

    it('hides NOTHING in observe mode — the send is allowed, so the list is unfiltered', async () => {
      limitsState.policy = policyWith(
        [{ limitKey: 'model.allowed', series: 'o-series', value: false }],
        { mode: 'observe' },
      );
      const { data } = await body(await GET(req()));
      expect(data.models.map((m) => m.id).sort()).toEqual([
        'gpt-5.2',
        'o3',
        'o4-mini',
      ]);
      // Observe mode never needs the principal at all.
      expect(mockResolveUserGroupIds).not.toHaveBeenCalled();
    });

    it('warms the group cache BEFORE building the principal, so a group-targeted block hides', async () => {
      limitsState.policy = policyWith([], {
        overrides: [
          {
            id: 'lim-0000000000a1',
            label: '',
            enabled: true,
            scope: 'group',
            targets: ['g-restricted'],
            priority: 0,
            entries: [
              { limitKey: 'model.allowed', modelId: 'o3', value: false },
            ],
            createdBy: 'admin',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedBy: 'admin',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      });
      // Cold cache: membership is only known once the warm-up has run.
      mockResolveUserGroupIds.mockImplementation(async () => {
        limitsState.cachedGroupIds = ['g-restricted'];
        return ['g-restricted'];
      });
      const { data } = await body(await GET(req()));
      expect(mockResolveUserGroupIds).toHaveBeenCalledTimes(1);
      expect(data.models.map((m) => m.id).sort()).toEqual([
        'gpt-5.2',
        'o4-mini',
      ]);
    });

    it('filters the static fallback branch too', async () => {
      limitsState.policy = policyWith([
        { limitKey: 'model.allowed', modelId: 'gpt-5.2', value: false },
      ]);
      mockListDeployedModels.mockRejectedValue(new Error('ARM 403'));
      const { data } = await body(await GET(req()));
      expect(data.source).toBe('fallback');
      expect(data.models.map((m) => m.id)).not.toContain('gpt-5.2');
      expect(data.models.map((m) => m.id)).toContain('o3');
    });

    it('fails open when the policy cannot be resolved', async () => {
      limitsState.policy = policyWith([
        { limitKey: 'model.allowed', series: 'o-series', value: false },
      ]);
      limitsState.ensureFreshError = new Error('blob down');
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { data } = await body(await GET(req()));
      errorSpy.mockRestore();
      expect(data.models.map((m) => m.id).sort()).toEqual([
        'gpt-5.2',
        'o3',
        'o4-mini',
      ]);
    });
  });
});
