// ───────────────────────────────────────────────────────────────────
// SUT
// ───────────────────────────────────────────────────────────────────
import { NextRequest } from 'next/server';

import { createCredentialMiddleware } from '@/lib/services/chat/pipeline/Middleware';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// getAccessTokenForOBO is mocked, so the request is only forwarded, never read.
const mockReq = {} as unknown as NextRequest;

// Hoisted mocks — must be declared before module imports below.

const lookupUserAgentEndpoint = vi.hoisted(() => vi.fn());
const cacheUserAgentEndpoint = vi.hoisted(() => vi.fn());
const listUserAgents = vi.hoisted(() => vi.fn());
const getArmToken = vi.hoisted(() => vi.fn());
const getFoundryToken = vi.hoisted(() => vi.fn());
const getAccessTokenForOBO = vi.hoisted(() => vi.fn());
const getFoundryEndpoint = vi.hoisted(() => vi.fn());

vi.mock('@/lib/services/agents/AgentDiscoveryService', () => ({
  AgentDiscoveryService: {
    getInstance: () => ({
      lookupUserAgentEndpoint,
      cacheUserAgentEndpoint,
      listUserAgents,
    }),
  },
}));

vi.mock('@/lib/services/auth/UserTokenProvider', () => ({
  UserTokenProvider: {
    getInstance: () => ({
      getArmToken,
      getFoundryToken,
    }),
  },
}));

vi.mock('@/lib/services/auth/OfficeResolver', () => ({
  OfficeResolver: {
    getFoundryEndpoint,
  },
}));

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  getAccessTokenForOBO,
}));

// ───────────────────────────────────────────────────────────────────

// ───────────────────────────────────────────────────────────────────

const VALID_PATH =
  '/subscriptions/abc/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/my-acct/projects/default';
const ALLOWED_ENDPOINT =
  'https://my-acct.services.ai.azure.com/api/projects/default';
const REGIONAL_FALLBACK =
  'https://eu.services.ai.azure.com/api/projects/default';

function makeContext(overrides: Record<string, any> = {}) {
  return {
    session: { user: { mail: 'u@msf.org' } },
    user: { mail: 'u@msf.org', region: 'EU' as const },
    model: {
      isOrganizationAgent: true,
      agentId: 'my-agent',
    },
    modelId: 'foundry-deadbeef-my-agent',
    agentSourcePath: VALID_PATH,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getFoundryEndpoint.mockReturnValue(REGIONAL_FALLBACK);
  getAccessTokenForOBO.mockResolvedValue('app-access-token');
  getFoundryToken.mockResolvedValue('foundry-obo-token');
  getArmToken.mockResolvedValue('arm-obo-token');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('createCredentialMiddleware', () => {
  describe('non-foundry paths', () => {
    it('returns empty for non-foundry models (no OBO needed)', async () => {
      const ctx = makeContext({
        model: { isOrganizationAgent: false, agentId: undefined },
        modelId: 'gpt-5.2',
      });
      const result = await createCredentialMiddleware(ctx, mockReq);
      expect(result).toEqual({});
      expect(lookupUserAgentEndpoint).not.toHaveBeenCalled();
    });

    it('returns empty when session is missing', async () => {
      const ctx = makeContext({ session: undefined });
      const result = await createCredentialMiddleware(ctx, mockReq);
      expect(result).toEqual({});
    });
  });

  describe('cache HIT path', () => {
    it('uses the cached endpoint without lazy discovery', async () => {
      lookupUserAgentEndpoint.mockReturnValue(ALLOWED_ENDPOINT);

      const result = await createCredentialMiddleware(makeContext(), mockReq);

      expect(lookupUserAgentEndpoint).toHaveBeenCalledWith(
        'u@msf.org',
        'my-agent',
        VALID_PATH,
      );
      expect(listUserAgents).not.toHaveBeenCalled();
      expect(result.foundryEndpoint).toBe(ALLOWED_ENDPOINT);
      expect(result.userCredential).toBeDefined();
    });
  });

  describe('cache MISS path with lazy discovery', () => {
    it('runs ARM discovery, populates cache, retries lookup', async () => {
      // First lookup misses, lazy-discovery populates, second lookup hits.
      lookupUserAgentEndpoint
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(ALLOWED_ENDPOINT);
      listUserAgents.mockResolvedValue([
        {
          agentName: 'my-agent',
          foundryEndpoint: ALLOWED_ENDPOINT,
        },
        {
          agentName: 'other-agent',
          foundryEndpoint: ALLOWED_ENDPOINT,
        },
      ]);

      const result = await createCredentialMiddleware(makeContext(), mockReq);

      expect(getAccessTokenForOBO).toHaveBeenCalled();
      expect(getArmToken).toHaveBeenCalledWith('app-access-token');
      expect(listUserAgents).toHaveBeenCalledWith('arm-obo-token', VALID_PATH);
      expect(cacheUserAgentEndpoint).toHaveBeenCalledTimes(2);
      expect(cacheUserAgentEndpoint).toHaveBeenCalledWith(
        'u@msf.org',
        'my-agent',
        VALID_PATH,
        ALLOWED_ENDPOINT,
      );
      expect(result.foundryEndpoint).toBe(ALLOWED_ENDPOINT);
    });

    it('falls back to the regional endpoint when discovery throws', async () => {
      lookupUserAgentEndpoint.mockReturnValue(null);
      listUserAgents.mockRejectedValue(new Error('ARM 403'));

      const result = await createCredentialMiddleware(makeContext(), mockReq);

      expect(result.foundryEndpoint).toBe(REGIONAL_FALLBACK);
    });

    it('falls back to regional when no OBO token is available', async () => {
      lookupUserAgentEndpoint.mockReturnValue(null);
      getAccessTokenForOBO.mockResolvedValue(null);

      const result = await createCredentialMiddleware(makeContext(), mockReq);

      expect(listUserAgents).not.toHaveBeenCalled();
      expect(result.foundryEndpoint).toBe(REGIONAL_FALLBACK);
    });
  });

  describe('agentSourcePath validation', () => {
    it('ignores an invalid agentSourcePath and uses regional fallback', async () => {
      lookupUserAgentEndpoint.mockReturnValue(null);

      const result = await createCredentialMiddleware(
        makeContext({
          agentSourcePath: '/etc/passwd', // not an ARM resource path
        }),
        mockReq,
      );

      // Lookup should be called with sourcePath=null OR not at all,
      // resulting in a cache miss → no lazy discovery (no path to scope to).
      expect(listUserAgents).not.toHaveBeenCalled();
      expect(result.foundryEndpoint).toBe(REGIONAL_FALLBACK);
    });
  });

  describe('host allow-list rejection (defense-in-depth)', () => {
    it('refuses to bind credential when resolved endpoint fails the allow-list', async () => {
      lookupUserAgentEndpoint.mockReturnValue('https://attacker.example/x');

      const result = await createCredentialMiddleware(makeContext(), mockReq);

      // Host outside allow-list → middleware bails out, no credential bound.
      expect(result).toEqual({});
      expect(getFoundryToken).not.toHaveBeenCalled();
    });
  });

  describe('scope-checked TokenCredential', () => {
    it('issues the Foundry token for an ai.azure.com scope', async () => {
      lookupUserAgentEndpoint.mockReturnValue(ALLOWED_ENDPOINT);
      const result = await createCredentialMiddleware(makeContext(), mockReq);

      const token = await result.userCredential!.getToken(
        'https://ai.azure.com/user_impersonation',
      );
      expect(token).toBeTruthy();
      expect((token as { token: string }).token).toBe('foundry-obo-token');
    });

    it('refuses to issue the Foundry token for an unrelated scope', async () => {
      lookupUserAgentEndpoint.mockReturnValue(ALLOWED_ENDPOINT);
      const result = await createCredentialMiddleware(makeContext(), mockReq);

      await expect(
        result.userCredential!.getToken(
          'https://management.azure.com/.default',
        ),
      ).rejects.toThrow(/Refusing to issue Foundry token/);
    });

    it('refuses to issue when scope is undefined', async () => {
      lookupUserAgentEndpoint.mockReturnValue(ALLOWED_ENDPOINT);
      const result = await createCredentialMiddleware(makeContext(), mockReq);

      await expect(
        // SDK may pass undefined; we should NOT silently issue.
        result.userCredential!.getToken(undefined as unknown as string),
      ).rejects.toThrow(/Refusing to issue Foundry token/);
    });
  });
});
