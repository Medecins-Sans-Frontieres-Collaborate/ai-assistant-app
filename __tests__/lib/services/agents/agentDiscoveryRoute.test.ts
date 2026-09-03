/**
 * The two consistency invariants of agent discovery:
 *
 *  1. `collectAppAgents` may only suppress a static config id when the SAME
 *     response carries its replacement (or the admin retired/restricted it
 *     deliberately). Deriving serveability twice used to let the two halves
 *     disagree, and the agent then vanished from the picker for the whole
 *     client session — /api/agents is fetched once per page load.
 *  2. `discoverFoundryAgents` treats a degraded group lookup as a per-agent
 *     pass-through, not as "switch the whole filter off".
 */
import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import {
  collectAppAgents,
  discoverFoundryAgents,
} from '@/lib/services/agents/agentDiscoveryRoute';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER_MAIL = 'user@example.com';
const SOURCE_PATH =
  '/subscriptions/abc/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/acct/projects/proj';

// --- access service -------------------------------------------------------

const accessService = vi.hoisted(() => ({
  isEnabled: vi.fn(() => true),
  ensureFresh: vi.fn().mockResolvedValue(undefined),
  evaluateAccess: vi.fn(),
  getPromptAgents: vi.fn(() => [] as unknown[]),
  getM365Agents: vi.fn(() => [] as unknown[]),
  getOrgAgents: vi.fn(() => [] as unknown[]),
}));

vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: { getInstance: () => accessService },
  // Re-exported verbatim; the discovery filter imports the predicate to
  // tell one user's degraded group lookup from a whole-ruleset outage.
  GROUP_MEMBERSHIP_DEGRADED_REASON: 'group-membership-degraded',
  isGroupMembershipDegradedReason: (reason: string) =>
    reason === 'group-membership-degraded' ||
    reason.endsWith(':group-membership-degraded'),
}));

// --- static config agents -------------------------------------------------

const STATIC_AGENT = {
  id: 'msf_communications',
  name: 'MSF Communications',
  description: 'static entry',
  icon: 'IconNews',
  color: '#4190f2',
  type: 'rag' as const,
  enabled: true,
  ragConfig: { topK: 10 },
};

vi.mock('@/lib/organizationAgents', () => ({
  getOrganizationAgents: () => [STATIC_AGENT],
  getOrganizationAgentById: (id: string) =>
    id === 'msf_communications' ? STATIC_AGENT : undefined,
}));

// --- index serveability probe --------------------------------------------

const indexProbe = vi.hoisted(() => ({
  checkIndexServeableCached: vi.fn(),
  peekIndexServeable: vi.fn(() => true),
}));

vi.mock('@/lib/services/orgAgents/orgAgentSearchValidation', () => ({
  ...indexProbe,
}));

// --- Foundry discovery plumbing ------------------------------------------

const listUserAgents = vi.hoisted(() => vi.fn());
const cacheUserAgentEndpoint = vi.hoisted(() => vi.fn());
const clearCacheForUser = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  getAccessTokenForOBO: vi.fn().mockResolvedValue('app-token'),
}));
vi.mock('@/lib/services/auth/UserTokenProvider', () => ({
  UserTokenProvider: {
    getInstance: () => ({
      getArmToken: vi.fn().mockResolvedValue('arm-token'),
      getFoundryToken: vi.fn().mockResolvedValue('foundry-token'),
    }),
  },
}));
vi.mock('@/lib/services/agents/AgentDiscoveryService', () => ({
  AgentDiscoveryService: {
    getInstance: () => ({
      listUserAgents,
      cacheUserAgentEndpoint,
      clearCacheForUser,
      clearCache: vi.fn(),
    }),
  },
}));
vi.mock('@/lib/services/auth/appIdentityCredential', () => ({
  createAppIdentityCredential: vi.fn(),
}));

/** An admin org RAG record, serveable unless overridden. */
function orgRecord(overrides: Record<string, unknown> = {}) {
  return {
    version: 1 as const,
    id: 'orgr-abcdefabcdef',
    name: 'Field manuals',
    description: 'admin record',
    icon: 'IconHexagon',
    color: '#22aa66',
    enabled: true,
    searchIndex: 'idx',
    semanticConfig: 'sem',
    topK: 10,
    sources: [],
    allowWebSearch: true,
    allowCodeInterpreter: false,
    validation: { status: 'ok', checkedAt: '2026-01-01T00:00:00.000Z' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  accessService.isEnabled.mockReturnValue(true);
  accessService.ensureFresh.mockResolvedValue(undefined);
  accessService.evaluateAccess.mockReturnValue({
    decision: 'allow',
    reason: 'no-rule',
  });
  accessService.getPromptAgents.mockReturnValue([]);
  accessService.getM365Agents.mockReturnValue([]);
  accessService.getOrgAgents.mockReturnValue([]);
  indexProbe.checkIndexServeableCached.mockResolvedValue(true);
  indexProbe.peekIndexServeable.mockReturnValue(true);
});

describe('collectAppAgents — suppression never outruns what is served', () => {
  it('suppresses a static id only alongside the override that replaces it', async () => {
    accessService.getOrgAgents.mockReturnValue([
      orgRecord({ id: 'msf_communications', name: 'Comms (admin)' }),
    ]);

    const { agents, suppressedOrgAgentIds } = await collectAppAgents(USER_MAIL);

    expect(agents.map((a) => a.id)).toEqual(['msf_communications']);
    expect(agents[0].overridesStatic).toBe(true);
    expect(suppressedOrgAgentIds).toEqual(['msf_communications']);
    // One serveability evaluation per record per request: the suppression
    // list and the served list come from the same pass, so they cannot
    // disagree even while the 5-minute probe cache is flapping.
    expect(indexProbe.checkIndexServeableCached).toHaveBeenCalledTimes(1);
  });

  it('keeps the static entry visible when a flapping index probe drops the override', async () => {
    // Pre-fix this was the vanishing bug: one read said "not serveable"
    // (drop the override) while the other said "serveable" (suppress the
    // static id), leaving the agent with no representation at all.
    indexProbe.checkIndexServeableCached
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    accessService.getOrgAgents.mockReturnValue([
      orgRecord({ id: 'msf_communications', name: 'Comms (admin)' }),
    ]);

    const { agents, suppressedOrgAgentIds } = await collectAppAgents(USER_MAIL);

    expect(agents).toEqual([]);
    expect(suppressedOrgAgentIds).toEqual([]);
    expect(indexProbe.checkIndexServeableCached).toHaveBeenCalledTimes(1);
  });

  it('falls back to the static entry when the override failed validation', async () => {
    accessService.getOrgAgents.mockReturnValue([
      orgRecord({
        id: 'msf_communications',
        validation: { status: 'failed', checkedAt: 'x' },
      }),
    ]);

    const { agents, suppressedOrgAgentIds } = await collectAppAgents(USER_MAIL);

    expect(agents).toEqual([]);
    expect(suppressedOrgAgentIds).toEqual([]);
    // A broken record never reaches the index probe: `isServeable` gates it.
    expect(indexProbe.checkIndexServeableCached).not.toHaveBeenCalled();
  });

  it("retires the static entry outright for an 'enabled: false' record", async () => {
    // The one suppression with no replacement, by design: the no-deploy
    // kill switch.
    accessService.getOrgAgents.mockReturnValue([
      orgRecord({ id: 'msf_communications', enabled: false }),
    ]);

    const { agents, suppressedOrgAgentIds } = await collectAppAgents(USER_MAIL);

    expect(agents).toEqual([]);
    expect(suppressedOrgAgentIds).toEqual(['msf_communications']);
  });

  it('suppresses the static entry when its override is denied to this user', async () => {
    // Override and static entry share the id, so they share the rule: the
    // deny is a deliberate admin restriction of BOTH, not a hole.
    accessService.getOrgAgents.mockReturnValue([
      orgRecord({ id: 'msf_communications', name: 'Comms (admin)' }),
    ]);
    accessService.evaluateAccess.mockReturnValue({
      decision: 'deny',
      reason: 'not-allowed',
    });

    const { agents, suppressedOrgAgentIds } = await collectAppAgents(USER_MAIL);

    expect(agents).toEqual([]);
    expect(suppressedOrgAgentIds).toEqual(['msf_communications']);
  });

  it('leaves the static entry alone when a NEW admin agent is dropped', async () => {
    // `orgr-` ids name no static entry; nothing may be suppressed whether
    // the record serves or not.
    accessService.getOrgAgents.mockReturnValue([orgRecord()]);
    indexProbe.checkIndexServeableCached.mockResolvedValue(false);

    const { agents, suppressedOrgAgentIds } = await collectAppAgents(USER_MAIL);

    expect(agents).toEqual([]);
    expect(suppressedOrgAgentIds).toEqual([]);
  });

  it("passes a static agent through on 'unavailable' rather than suppressing it", async () => {
    accessService.evaluateAccess.mockReturnValue({
      decision: 'unavailable',
      reason: 'group-membership-degraded',
    });

    const { suppressedOrgAgentIds } = await collectAppAgents(USER_MAIL);

    expect(suppressedOrgAgentIds).toEqual([]);
  });
});

describe('discoverFoundryAgents — degraded group lookups filter per agent', () => {
  const session = { user: { id: 'u1', mail: USER_MAIL } } as Session;

  function request(): NextRequest {
    return new NextRequest('http://localhost:3000/api/agents/foundry');
  }

  function foundryAgent(agentName: string) {
    return {
      id: agentName,
      name: agentName,
      description: '',
      agentName,
      type: 'foundry' as const,
      foundryEndpoint: `https://acct.services.ai.azure.com/${agentName}`,
    };
  }

  beforeEach(() => {
    listUserAgents.mockResolvedValue([
      foundryAgent('agent-allowed'),
      foundryAgent('agent-degraded'),
      foundryAgent('agent-denied'),
    ]);
  });

  it('includes only the degraded agent and keeps enforcing the rest', async () => {
    accessService.evaluateAccess.mockImplementation(
      ({ agentName }: { agentName: string }) => {
        if (agentName === 'agent-degraded') {
          return {
            decision: 'unavailable',
            reason: 'group-membership-degraded',
          };
        }
        if (agentName === 'agent-denied') {
          return { decision: 'deny', reason: 'not-allowed' };
        }
        return { decision: 'allow', reason: 'allow-user' };
      },
    );

    const { agents, unavailable } = await discoverFoundryAgents(
      request(),
      session,
      [SOURCE_PATH],
      Promise.resolve(),
    );

    expect(unavailable).toBe(false);
    expect(agents.map((a) => a.agentName)).toEqual([
      'agent-allowed',
      'agent-degraded',
    ]);
    // Only anchored endpoints are reachable from chat; the denied agent's
    // must not be among them.
    expect(cacheUserAgentEndpoint).toHaveBeenCalledTimes(2);
  });

  it('still matches the reason after the unresolved-source sweep prefixes it', async () => {
    accessService.evaluateAccess.mockImplementation(
      ({ agentName }: { agentName: string }) =>
        agentName === 'agent-degraded'
          ? {
              decision: 'unavailable',
              reason: 'unresolved-source:group-membership-degraded',
            }
          : { decision: 'deny', reason: 'not-allowed' },
    );

    const { agents } = await discoverFoundryAgents(
      request(),
      session,
      [SOURCE_PATH],
      Promise.resolve(),
    );

    expect(agents.map((a) => a.agentName)).toEqual(['agent-degraded']);
  });

  it("keeps the global pass-through for a whole-ruleset 'unavailable'", async () => {
    accessService.evaluateAccess.mockReturnValue({
      decision: 'unavailable',
      reason: 'rules-unavailable',
    });

    const { agents } = await discoverFoundryAgents(
      request(),
      session,
      [SOURCE_PATH],
      Promise.resolve(),
    );

    expect(agents.map((a) => a.agentName)).toEqual([
      'agent-allowed',
      'agent-degraded',
      'agent-denied',
    ]);
  });
});
