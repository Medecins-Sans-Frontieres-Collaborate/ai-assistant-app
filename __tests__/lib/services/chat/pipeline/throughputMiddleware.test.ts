import { createThroughputMiddleware } from '@/lib/services/chat/pipeline/Middleware';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveServingTokensPerMinute = vi.hoisted(() => vi.fn());
vi.mock('@/lib/services/models/deploymentThroughput', () => ({
  resolveServingTokensPerMinute,
}));
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: { getInstance: () => ({}) },
  emitAccessAudit: vi.fn(),
}));
vi.mock('@/lib/services/agents/AgentDiscoveryService', () => ({
  AgentDiscoveryService: { getInstance: () => ({}) },
}));
vi.mock('@/lib/services/auth/UserTokenProvider', () => ({
  UserTokenProvider: { getInstance: () => ({}) },
}));
vi.mock('@/lib/services/auth/OfficeResolver', () => ({
  OfficeResolver: { getFoundryEndpoint: vi.fn() },
}));
vi.mock('@/auth', () => ({ auth: vi.fn(), getAccessTokenForOBO: vi.fn() }));

const astraContext = (over: Record<string, unknown> = {}) =>
  ({
    modelId: 'gpt-6-astra',
    model: { id: 'gpt-6-astra' },
    user: { id: 'u1', region: 'US' },
    ...over,
  }) as any;

beforeEach(() => {
  vi.clearAllMocks();
  resolveServingTokensPerMinute.mockResolvedValue(250000);
});

describe('createThroughputMiddleware', () => {
  it('stamps the serving deployment TPM for a catalog model', async () => {
    const out = await createThroughputMiddleware(astraContext());
    expect(out).toEqual({ servingTokensPerMinute: 250000 });
    expect(resolveServingTokensPerMinute).toHaveBeenCalledWith(
      'gpt-6-astra',
      'US',
    );
  });

  it('looks up the requested hosting region for a US user', async () => {
    await createThroughputMiddleware(astraContext({ hostedRegion: 'EU' }));
    expect(resolveServingTokensPerMinute).toHaveBeenCalledWith(
      'gpt-6-astra',
      'EU',
    );
  });

  it('always looks up EU for an EU user, whatever was requested', async () => {
    await createThroughputMiddleware(
      astraContext({ user: { id: 'u1', region: 'EU' }, hostedRegion: 'US' }),
    );
    expect(resolveServingTokensPerMinute).toHaveBeenCalledWith(
      'gpt-6-astra',
      'EU',
    );
  });

  it('defaults to US when the user region is unknown', async () => {
    await createThroughputMiddleware(astraContext({ user: { id: 'u1' } }));
    expect(resolveServingTokensPerMinute).toHaveBeenCalledWith(
      'gpt-6-astra',
      'US',
    );
  });

  it.each(['org-abc', 'byom-1234-gpt', 'custom-agent-1', 'not-a-model'])(
    'skips non-catalog model %s',
    async (modelId) => {
      const out = await createThroughputMiddleware(
        astraContext({ modelId, model: { id: modelId } }),
      );
      expect(out).toEqual({});
      expect(resolveServingTokensPerMinute).not.toHaveBeenCalled();
    },
  );

  it('adds nothing when the ceiling is unknown', async () => {
    resolveServingTokensPerMinute.mockResolvedValue(undefined);
    expect(await createThroughputMiddleware(astraContext())).toEqual({});
  });
});
