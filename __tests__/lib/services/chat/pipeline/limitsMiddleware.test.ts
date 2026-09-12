import { createLimitsMiddleware } from '@/lib/services/chat/pipeline/Middleware';
import { mintContinuationToken } from '@/lib/services/limits/continuationToken';
import { checkGate, meteredCells } from '@/lib/services/limits/enforcement';
import { checkTokenBudget } from '@/lib/services/limits/tokenDebit';
import { reserve } from '@/lib/services/limits/usageStore';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Middleware.ts pulls the whole chat service graph; the same stubs the
// telemetry middleware test uses keep it importable.
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: {
    getInstance: () => ({
      isEnabled: vi.fn(),
      ensureFresh: vi.fn(),
      getPromptAgentById: vi.fn(),
      getM365AgentById: vi.fn(),
      getOrgAgentById: vi.fn(),
    }),
  },
  emitAccessAudit: vi.fn(),
}));
vi.mock('@/lib/services/orgAgents/orgAgentRegistry', () => ({
  resolveOrgAgentById: vi.fn(),
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

// Limits collaborators: one metered message cell, everything else open.
vi.mock('@/lib/services/limits/enforcement', () => ({
  currentPolicy: vi.fn(async () => ({
    mode: 'enforce',
    failMode: 'open',
    timezone: 'UTC',
    countByomUsage: false,
    defaults: [],
    overrides: [],
    delegations: [],
  })),
  checkGate: vi.fn(() => ({ allowed: true })),
  meteredCells: vi.fn((_p: unknown, _pr: unknown, key: string) =>
    key === 'chat.messagesPerDay'
      ? [{ limitKey: key, value: 10, source: 'global', window: 'day' }]
      : [],
  ),
  applyMode: vi.fn(() => ({ allowed: true })),
  effectiveCeiling: vi.fn(() => undefined),
}));
vi.mock('@/lib/services/limits/modelAvailability', () => ({
  isModelBlocked: vi.fn(() => false),
}));
vi.mock('@/lib/services/limits/principal', () => ({
  buildPrincipal: vi.fn(() => ({
    userId: 'oid-1',
    attributes: [],
    groupIds: [],
  })),
}));
vi.mock('@/lib/services/limits/tokenDebit', () => ({
  checkTokenBudget: vi.fn(async () => null),
}));
vi.mock('@/lib/services/limits/usageStore', () => ({
  reserve: vi.fn(async () => ({ allowed: true, debited: [] })),
}));

const servers = [{ id: 'github', name: 'GitHub' }];

function context(extra: Record<string, unknown>) {
  return {
    user: { id: 'oid-1', mail: 'a@x.org' },
    modelId: 'gpt-5.2',
    model: { id: 'gpt-5.2' },
    ...extra,
  } as never;
}

/**
 * Robustness review 2026-09-12 (HIGH): `mcpLoopRound` is a bare client
 * field. Round > 0 used to skip the message/model counters and the token
 * pre-flight outright, so any user could post `mcpLoopRound: 1` and get an
 * unmetered completion. A continuation is now only the round whose pending
 * calls all carry a server-signed token for the caller; anything else is
 * metered as a new message (never rejected).
 */
describe('createLimitsMiddleware — continuation metering', () => {
  let previous: string | undefined;
  beforeEach(() => {
    vi.clearAllMocks();
    previous = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = 'test-secret';
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = previous;
  });

  it('meters a bare `mcpLoopRound: 1` with no servers (the bypass)', async () => {
    await createLimitsMiddleware(context({ mcpLoopRound: 1 }));
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(checkTokenBudget).toHaveBeenCalledTimes(1);
  });

  it('meters a round with servers and pending calls but no signed token', async () => {
    await createLimitsMiddleware(
      context({
        mcpLoopRound: 1,
        mcpServers: servers,
        mcpPendingToolCalls: [
          {
            id: 'call_1',
            serverId: 'github',
            toolName: 't',
            argumentsJson: '{}',
          },
        ],
      }),
    );
    expect(reserve).toHaveBeenCalledTimes(1);
  });

  it("meters a token minted for ANOTHER user's card", async () => {
    const foreign = mintContinuationToken('oid-2', 'call_1')!;
    await createLimitsMiddleware(
      context({
        mcpLoopRound: 1,
        mcpServers: servers,
        mcpPendingToolCalls: [
          {
            id: 'call_1',
            serverId: 'github',
            toolName: 't',
            argumentsJson: '{}',
            continuationToken: foreign,
          },
        ],
      }),
    );
    expect(reserve).toHaveBeenCalledTimes(1);
  });

  it('skips the counters and the token pre-flight for a genuine, signed continuation', async () => {
    const token = mintContinuationToken('oid-1', 'call_1')!;
    await createLimitsMiddleware(
      context({
        mcpLoopRound: 1,
        mcpServers: servers,
        mcpPendingToolCalls: [
          {
            id: 'call_1',
            serverId: 'github',
            toolName: 't',
            argumentsJson: '{}',
            continuationToken: token,
          },
        ],
      }),
    );
    expect(reserve).not.toHaveBeenCalled();
    expect(checkTokenBudget).not.toHaveBeenCalled();
  });

  it('always meters round 0', async () => {
    await createLimitsMiddleware(context({ mcpLoopRound: 0 }));
    expect(reserve).toHaveBeenCalledTimes(1);
  });
});

describe('createLimitsMiddleware — one jurisdiction scan, one day-ledger read', () => {
  beforeEach(() => vi.clearAllMocks());

  it("hands the reservation's counters to the token pre-flight and threads one active set everywhere", async () => {
    vi.mocked(reserve).mockResolvedValueOnce({
      allowed: true,
      debited: [],
      counters: { 'chat.messagesPerDay': 3, 'chat.tokensPerDay': 42 },
    });
    const out = await createLimitsMiddleware(context({}));
    expect(checkTokenBudget).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'oid-1' }),
      expect.objectContaining({
        dayCounters: { 'chat.messagesPerDay': 3, 'chat.tokensPerDay': 42 },
        active: expect.any(Set),
      }),
    );
    // Every gate / cell resolution received the same precomputed set.
    const active = (out.limits as { active: ReadonlySet<string> }).active;
    expect(active).toBeInstanceOf(Set);
    for (const call of vi.mocked(checkGate).mock.calls) {
      expect(call[5]).toBe(active);
    }
    for (const call of vi.mocked(meteredCells).mock.calls) {
      expect(call[5]).toBe(active);
    }
  });
});
