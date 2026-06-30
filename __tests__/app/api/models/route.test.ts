import { GET } from '@/app/api/models/route';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────
const mockEnv = vi.hoisted(() => ({
  MODEL_DISCOVERY_ENABLED: false,
  SHOW_MODELS_WITHOUT_METADATA: false,
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

const mockGetDiscoveryPaths = vi.hoisted(() => vi.fn());
vi.mock('@/lib/services/auth/OfficeResolver', () => ({
  OfficeResolver: { getDiscoveryPathsForUser: mockGetDiscoveryPaths },
}));

const mockIsModelDisabled = vi.hoisted(() => vi.fn((_id: string) => false));
vi.mock('@/config/models', () => ({ isModelDisabled: mockIsModelDisabled }));

// ── Helpers ──────────────────────────────────────────────────────────────────
const REGION_PATH =
  '/subscriptions/s/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/acct/projects/default';

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
    data: { models: { id: string }[]; source: string };
  };
}

beforeEach(() => {
  mockEnv.MODEL_DISCOVERY_ENABLED = false;
  mockEnv.SHOW_MODELS_WITHOUT_METADATA = false;
  mockAuth.mockResolvedValue({ user: { mail: 'eu.user@msf.org' } });
  mockGetDiscoveryPaths.mockReturnValue({
    regionalPath: REGION_PATH,
    officePaths: [],
  });
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
    mockEnv.MODEL_DISCOVERY_ENABLED = false;
    const { data } = await body(await GET(req()));
    expect(data.source).toBe('static');
    expect(mockListDeployedModels).not.toHaveBeenCalled();
    // Static list excludes isDisabled models (grok-3, claude-opus-4-1).
    expect(data.models.map((m) => m.id)).toContain('gpt-5.2');
    expect(data.models.map((m) => m.id)).not.toContain('grok-3');
  });

  it('falls back to static when no region is configured', async () => {
    mockEnv.MODEL_DISCOVERY_ENABLED = true;
    mockGetDiscoveryPaths.mockReturnValue({
      regionalPath: null,
      officePaths: [],
    });
    const { data } = await body(await GET(req()));
    expect(data.source).toBe('static-no-region');
    expect(mockListDeployedModels).not.toHaveBeenCalled();
  });

  it('returns discovered ∩ metadata, dropping undeployed-but-hardcoded models (EU drift fix)', async () => {
    mockEnv.MODEL_DISCOVERY_ENABLED = true;
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
  });

  it('hides unknown deployed models unless SHOW_MODELS_WITHOUT_METADATA', async () => {
    mockEnv.MODEL_DISCOVERY_ENABLED = true;
    mockListDeployedModels.mockResolvedValue([
      deployed('gpt-5.2', 'OpenAI'),
      deployed('Mistral-Large-3', 'Mistral AI'),
    ]);

    let { data } = await body(await GET(req()));
    expect(data.models.map((m) => m.id)).not.toContain('Mistral-Large-3');

    mockEnv.SHOW_MODELS_WITHOUT_METADATA = true;
    ({ data } = await body(await GET(req())));
    expect(data.models.map((m) => m.id)).toContain('Mistral-Large-3');
  });

  it('applies the ring gate server-side (prod-hidden model never reaches client)', async () => {
    mockEnv.MODEL_DISCOVERY_ENABLED = true;
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
    mockEnv.MODEL_DISCOVERY_ENABLED = true;
    mockListDeployedModels.mockRejectedValue(new Error('ARM 403'));
    const { data } = await body(await GET(req()));
    expect(data.source).toBe('fallback');
    expect(data.models.map((m) => m.id)).toContain('gpt-5.2');
  });

  it('busts the discovery cache when ?refresh is present', async () => {
    mockEnv.MODEL_DISCOVERY_ENABLED = true;
    mockListDeployedModels.mockResolvedValue([deployed('gpt-5.2', 'OpenAI')]);
    await GET(req('http://localhost/api/models?refresh=1'));
    expect(mockClearCache).toHaveBeenCalledTimes(1);
  });
});
