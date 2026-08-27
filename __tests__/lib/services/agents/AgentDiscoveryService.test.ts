import { AgentDiscoveryService } from '@/lib/services/agents/AgentDiscoveryService';
import { createFoundryTokenCredential } from '@/lib/services/auth/foundryCredential';

import { env } from '@/config/environment';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────────────

// Mutable env so individual tests can flip the feature flag. Only the fields the
// service + host allow-list read are needed; everything else is undefined.
vi.mock('@/config/environment', () => ({
  env: { FOUNDRY_DATAPLANE_DISCOVERY: true },
}));

const mockAgentsList = vi.hoisted(() => vi.fn());
const mockAIProjectClient = vi.hoisted(() => vi.fn());
vi.mock('@azure/ai-projects', () => ({
  AIProjectClient: mockAIProjectClient,
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

const RESOURCE_PATH =
  '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/myacct/projects/proj';
const EXPECTED_ENDPOINT =
  'https://myacct.services.ai.azure.com/api/projects/proj';

/** Async-iterable factory mimicking AIProjectClient.agents.list(). */
async function* asyncFrom<T>(items: T[]): AsyncGenerator<T> {
  for (const i of items) yield i;
}

/** ARM `/applications` value entries. */
function armApp(name: string, agentName = name) {
  return {
    name,
    properties: {
      displayName: name,
      description: `${name} desc`,
      agents: [{ agentName, agentVersion: '1' }],
      isEnabled: true,
      baseUrl: `${EXPECTED_ENDPOINT}/applications/${name}`,
    },
    tags: { 'ui-icon': 'IconCurrencyDollar' },
  };
}

/** New-model data-plane agent object. */
function dpAgent(name: string) {
  return {
    object: 'agent',
    id: name,
    name,
    versions: { latest: { name, description: `${name} dp`, version: '2' } },
    agent_card: { name, description: `${name} card` },
  };
}

function mockArmFetch(apps: unknown[]) {
  global.fetch = vi.fn(async (url: string) => {
    if (url.includes('/applications?')) {
      return { ok: true, json: async () => ({ value: apps }) } as Response;
    }
    if (url.includes('/agents/')) {
      // Per-agent ARM enrichment (fetchDataPlaneAgent) — best-effort.
      return {
        ok: true,
        json: async () => ({ versions: { latest: {} } }),
      } as Response;
    }
    return {
      ok: false,
      status: 404,
      statusText: 'NF',
      text: async () => '',
    } as Response;
  }) as unknown as typeof fetch;
}

const service = AgentDiscoveryService.getInstance();

beforeEach(() => {
  vi.clearAllMocks();
  service.clearCache();
  (
    env as { FOUNDRY_DATAPLANE_DISCOVERY: boolean }
  ).FOUNDRY_DATAPLANE_DISCOVERY = true;
  mockAIProjectClient.mockImplementation(function (this: {
    agents: { list: typeof mockAgentsList };
  }) {
    this.agents = { list: mockAgentsList };
  });
  mockAgentsList.mockReturnValue(asyncFrom([]));
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── deriveProjectEndpoint ────────────────────────────────────────────────────

describe('deriveProjectEndpoint', () => {
  const derive = (p: string): string | null =>
    (
      service as unknown as {
        deriveProjectEndpoint: (p: string) => string | null;
      }
    ).deriveProjectEndpoint(p);

  it('builds the data-plane project endpoint from an ARM path', () => {
    expect(derive(RESOURCE_PATH)).toBe(EXPECTED_ENDPOINT);
  });

  it('returns null for an account-only path (no project segment)', () => {
    expect(
      derive(
        '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/myacct',
      ),
    ).toBeNull();
  });
});

// ── listUserAgents merge ─────────────────────────────────────────────────────

describe('listUserAgents — ARM + data-plane union', () => {
  it('unions data-plane-only agents and lets ARM win on conflicts', async () => {
    mockArmFetch([armApp('shared-agent')]);
    mockAgentsList.mockReturnValue(
      asyncFrom([dpAgent('shared-agent'), dpAgent('new-agent')]),
    );

    const agents = await service.listUserAgents(
      'arm-token',
      RESOURCE_PATH,
      'foundry-token',
    );

    const byName = Object.fromEntries(agents.map((a) => [a.agentName, a]));
    expect(Object.keys(byName).sort()).toEqual(['new-agent', 'shared-agent']);
    // ARM wins on the conflict: keeps the ui-icon tag from the Application.
    expect(byName['shared-agent'].icon).toBe('IconCurrencyDollar');
    // Data-plane-only agent surfaces with the derived project endpoint.
    expect(byName['new-agent'].foundryEndpoint).toBe(EXPECTED_ENDPOINT);
    expect(byName['new-agent'].icon).toBeUndefined();
  });

  it('skips the data-plane call when the flag is off', async () => {
    (
      env as { FOUNDRY_DATAPLANE_DISCOVERY: boolean }
    ).FOUNDRY_DATAPLANE_DISCOVERY = false;
    mockArmFetch([armApp('only-arm')]);

    const agents = await service.listUserAgents(
      'arm-token',
      RESOURCE_PATH,
      'foundry-token',
    );

    expect(mockAgentsList).not.toHaveBeenCalled();
    expect(agents.map((a) => a.agentName)).toEqual(['only-arm']);
  });

  it('falls back to ARM-only results when data-plane listing throws', async () => {
    mockArmFetch([armApp('arm-agent')]);
    mockAgentsList.mockImplementation(() => {
      throw new Error('403 Forbidden');
    });

    const agents = await service.listUserAgents(
      'arm-token',
      RESOURCE_PATH,
      'foundry-token',
    );

    expect(agents.map((a) => a.agentName)).toEqual(['arm-agent']);
  });
});

// ── createFoundryTokenCredential ─────────────────────────────────────────────

describe('createFoundryTokenCredential', () => {
  it('issues the token for an ai.azure.com scope', async () => {
    const cred = createFoundryTokenCredential('foundry-obo-token');
    const token = await cred.getToken(
      'https://ai.azure.com/user_impersonation',
    );
    expect(token?.token).toBe('foundry-obo-token');
  });

  it('refuses to issue for an unrelated scope', async () => {
    const cred = createFoundryTokenCredential('foundry-obo-token');
    await expect(
      cred.getToken('https://management.azure.com/.default'),
    ).rejects.toThrow(/Refusing to issue Foundry token/);
  });
});

// ── owner-keyed cache ─────────────────────────────────────────────────────────
describe('listUserAgents — owner-keyed cache', () => {
  const armCalls = () =>
    (
      global.fetch as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.filter((c) => String(c[0]).includes('/applications?')).length;

  it('survives an access-token rotation for the same user', async () => {
    mockArmFetch([armApp('a')]);
    await service.listUserAgents(
      'arm-token-1',
      RESOURCE_PATH,
      null,
      'Ann@Example.org',
    );
    await service.listUserAgents(
      'arm-token-2',
      RESOURCE_PATH,
      null,
      'ann@example.org',
    );
    expect(armCalls()).toBe(1);
  });

  it('never serves one user’s list to another', async () => {
    mockArmFetch([armApp('a')]);
    await service.listUserAgents(
      'arm-token',
      RESOURCE_PATH,
      null,
      'ann@example.org',
    );
    await service.listUserAgents(
      'arm-token',
      RESOURCE_PATH,
      null,
      'bob@example.org',
    );
    expect(armCalls()).toBe(2);
  });

  it('keeps ARM-only and ARM+Foundry results apart for the same user', async () => {
    mockArmFetch([armApp('a')]);
    mockAgentsList.mockReturnValue(asyncFrom([]));
    await service.listUserAgents(
      'arm-token',
      RESOURCE_PATH,
      null,
      'ann@example.org',
    );
    await service.listUserAgents(
      'arm-token',
      RESOURCE_PATH,
      'foundry-token',
      'ann@example.org',
    );
    expect(armCalls()).toBe(2);
  });

  it('clearCacheForUser drops only that user’s entries and endpoint anchors', async () => {
    mockArmFetch([armApp('a')]);
    await service.listUserAgents('t', RESOURCE_PATH, null, 'ann@example.org');
    await service.listUserAgents('t', RESOURCE_PATH, null, 'bob@example.org');
    service.cacheUserAgentEndpoint(
      'ann@example.org',
      'a',
      RESOURCE_PATH,
      'https://x.services.ai.azure.com/api/projects/p',
    );
    service.cacheUserAgentEndpoint(
      'bob@example.org',
      'a',
      RESOURCE_PATH,
      'https://y.services.ai.azure.com/api/projects/p',
    );

    service.clearCacheForUser('ANN@example.org');
    expect(
      service.lookupUserAgentEndpoint('ann@example.org', 'a', RESOURCE_PATH),
    ).toBeNull();
    expect(
      service.lookupUserAgentEndpoint('bob@example.org', 'a', RESOURCE_PATH),
    ).not.toBeNull();

    await service.listUserAgents('t', RESOURCE_PATH, null, 'bob@example.org'); // still cached
    expect(armCalls()).toBe(2);
    await service.listUserAgents('t', RESOURCE_PATH, null, 'ann@example.org'); // re-discovers
    expect(armCalls()).toBe(3);
  });

  it('deduplicates concurrent cold discoveries for the same key', async () => {
    mockArmFetch([armApp('a')]);
    const [x, y] = await Promise.all([
      service.listUserAgents('t', RESOURCE_PATH, null, 'ann@example.org'),
      service.listUserAgents('t', RESOURCE_PATH, null, 'ann@example.org'),
    ]);
    expect(armCalls()).toBe(1);
    expect(x).toBe(y);
  });
});
