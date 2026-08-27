import { NextRequest } from 'next/server';

import { PROMPT_AGENT_SOURCE } from '@/lib/services/agentAccess/types';

import { parseJsonResponse } from './helpers';

import { GET as foundryGET } from '@/app/api/agents/foundry/route';
import { GET } from '@/app/api/agents/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const getAccessTokenForOBO = vi.hoisted(() => vi.fn());
const getArmToken = vi.hoisted(() => vi.fn());
const getFoundryToken = vi.hoisted(() => vi.fn());
const getDiscoveryPathsForUser = vi.hoisted(() => vi.fn());
const listUserAgents = vi.hoisted(() => vi.fn());
const cacheUserAgentEndpoint = vi.hoisted(() => vi.fn());
const clearCache = vi.hoisted(() => vi.fn());
const clearCacheForUser = vi.hoisted(() => vi.fn());
const accessIsEnabled = vi.hoisted(() => vi.fn());
const accessEnsureFresh = vi.hoisted(() => vi.fn());
const accessEvaluate = vi.hoisted(() => vi.fn());
const accessGetPromptAgents = vi.hoisted(() => vi.fn());
const accessGetM365Agents = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({ auth: mockAuth, getAccessTokenForOBO }));
vi.mock('@/lib/services/auth/OfficeResolver', () => ({
  OfficeResolver: { getDiscoveryPathsForUser },
}));
vi.mock('@/lib/services/auth/UserTokenProvider', () => ({
  UserTokenProvider: {
    getInstance: () => ({ getArmToken, getFoundryToken }),
  },
}));
vi.mock('@/lib/services/agents/AgentDiscoveryService', () => ({
  AgentDiscoveryService: {
    getInstance: () => ({
      listUserAgents,
      cacheUserAgentEndpoint,
      clearCache,
      clearCacheForUser,
    }),
  },
}));
vi.mock('@/lib/services/auth/appIdentityCredential', () => ({
  createAppIdentityCredential: vi.fn(),
}));
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: {
    getInstance: () => ({
      isEnabled: accessIsEnabled,
      ensureFresh: accessEnsureFresh,
      evaluateAccess: accessEvaluate,
      getPromptAgents: accessGetPromptAgents,
      getM365Agents: accessGetM365Agents,
      // Org RAG agents ride the same discovery merge; these tests don't
      // exercise that path.
      getOrgAgents: () => [],
    }),
  },
}));

const REGIONAL_PATH =
  '/subscriptions/abc/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/acct/projects/proj';
const ENDPOINT_A = 'https://acct.services.ai.azure.com/api/projects/proj';
const ENDPOINT_B = 'https://acct.services.ai.azure.com/api/projects/proj2';

const USER_MAIL = 'user@example.com';

/**
 * The existing discovery-filter tests exercise the legacy COMBINED payload
 * (`?include=foundry`), which the fast route still serves for one release.
 */
function request(extra = ''): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/agents?include=foundry${extra ? '&' + extra : ''}`,
  );
}
function fastRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/agents');
}
function foundryRequest(extra = ''): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/agents/foundry${extra ? '?' + extra : ''}`,
  );
}

describe('GET /api/agents — access-control discovery filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: 'u1', mail: USER_MAIL } });
    getDiscoveryPathsForUser.mockReturnValue({
      regionalPath: REGIONAL_PATH,
      officePaths: [],
    });
    getAccessTokenForOBO.mockResolvedValue('app-access-token');
    getArmToken.mockResolvedValue('arm-obo-token');
    getFoundryToken.mockResolvedValue('foundry-obo-token');
    listUserAgents.mockResolvedValue([
      { agentName: 'agent-a', foundryEndpoint: ENDPOINT_A },
      { agentName: 'agent-b', foundryEndpoint: ENDPOINT_B },
    ]);
    accessIsEnabled.mockReturnValue(false);
    accessEnsureFresh.mockResolvedValue(undefined);
    accessEvaluate.mockReturnValue({ decision: 'allow', reason: 'no-rule' });
    accessGetPromptAgents.mockReturnValue([]);
    accessGetM365Agents.mockReturnValue([]);
  });

  it('returns 401 when unauthenticated', async () => {
    mockAuth.mockResolvedValue(null);

    const response = await GET(request());

    expect(response.status).toBe(401);
  });

  it('leaves discovery untouched when the feature is disabled', async () => {
    const response = await GET(request());
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.agents.map((a: { agentName: string }) => a.agentName)).toEqual([
      'agent-a',
      'agent-b',
    ]);
    expect(accessEnsureFresh).not.toHaveBeenCalled();
    expect(accessEvaluate).not.toHaveBeenCalled();
    // Both endpoints are trust-anchored.
    expect(cacheUserAgentEndpoint).toHaveBeenCalledTimes(2);
  });

  it('drops denied agents from the response AND the endpoint trust-anchor cache', async () => {
    accessIsEnabled.mockReturnValue(true);
    accessEvaluate.mockImplementation(({ agentName }: { agentName: string }) =>
      agentName === 'agent-b'
        ? { decision: 'deny', reason: 'not-allowed' }
        : { decision: 'allow', reason: 'no-rule' },
    );

    const response = await GET(request());
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.agents.map((a: { agentName: string }) => a.agentName)).toEqual([
      'agent-a',
    ]);
    expect(accessEnsureFresh).toHaveBeenCalled();
    // The denied agent's endpoint must never be anchored for this user.
    expect(cacheUserAgentEndpoint).toHaveBeenCalledTimes(1);
    expect(cacheUserAgentEndpoint).toHaveBeenCalledWith(
      USER_MAIL,
      'agent-a',
      REGIONAL_PATH,
      ENDPOINT_A,
    );
  });

  it('evaluates each agent with the user mail and its resolved source', async () => {
    accessIsEnabled.mockReturnValue(true);

    await GET(request());

    expect(accessEvaluate).toHaveBeenCalledWith({
      userMail: USER_MAIL,
      source: REGIONAL_PATH,
      agentName: 'agent-a',
    });
    expect(accessEvaluate).toHaveBeenCalledWith({
      userMail: USER_MAIL,
      source: REGIONAL_PATH,
      agentName: 'agent-b',
    });
  });

  it("passes discovery through unfiltered on 'unavailable' (visibility-only surface)", async () => {
    accessIsEnabled.mockReturnValue(true);
    accessEvaluate.mockReturnValue({
      decision: 'unavailable',
      reason: 'rules-unavailable',
    });

    const response = await GET(request());
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.agents.map((a: { agentName: string }) => a.agentName)).toEqual([
      'agent-a',
      'agent-b',
    ]);
    expect(cacheUserAgentEndpoint).toHaveBeenCalledTimes(2);
  });

  describe('prompt agents', () => {
    const PROMPT_AGENT = {
      version: 1,
      id: 'prompt-abc123def456',
      name: 'Legal Advisor',
      description: 'Reviews contracts',
      systemPrompt: 'You are a meticulous legal advisor.',
      modelId: 'gpt-5.2-chat',
      createdBy: 'admin@example.com',
      createdAt: '2026-07-17T00:00:00.000Z',
      updatedBy: 'admin@example.com',
      updatedAt: '2026-07-17T00:00:00.000Z',
    };

    it('appends allowed prompt agents WITHOUT leaking systemPrompt/modelId and never trust-anchors them', async () => {
      accessIsEnabled.mockReturnValue(true);
      accessGetPromptAgents.mockReturnValue([PROMPT_AGENT]);

      const response = await GET(request());
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(
        data.agents.map((a: { agentName: string }) => a.agentName),
      ).toEqual(['agent-a', 'agent-b', 'prompt-abc123def456']);
      // Public wire shape only — the persona's prompt and engine are
      // admin-route fields, resolved server-side from botId at invocation.
      expect(data.agents[2]).toEqual({
        id: 'prompt-abc123def456',
        name: 'Legal Advisor',
        description: 'Reviews contracts',
        agentName: 'prompt-abc123def456',
        source: PROMPT_AGENT_SOURCE,
        type: 'prompt',
      });
      // Access-evaluated under the prompt-agent pseudo-source.
      expect(accessEvaluate).toHaveBeenCalledWith({
        userMail: USER_MAIL,
        source: PROMPT_AGENT_SOURCE,
        agentName: 'prompt-abc123def456',
      });
      // Only the two Foundry agents are trust-anchored.
      expect(cacheUserAgentEndpoint).toHaveBeenCalledTimes(2);
    });

    it('drops prompt agents the user is denied access to', async () => {
      accessIsEnabled.mockReturnValue(true);
      accessGetPromptAgents.mockReturnValue([PROMPT_AGENT]);
      accessEvaluate.mockImplementation(({ source }: { source?: string }) =>
        source === PROMPT_AGENT_SOURCE
          ? { decision: 'deny', reason: 'not-allowed' }
          : { decision: 'allow', reason: 'no-rule' },
      );

      const response = await GET(request());
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(
        data.agents.map((a: { agentName: string }) => a.agentName),
      ).toEqual(['agent-a', 'agent-b']);
    });

    it('serves prompt agents even when NO discovery paths are configured (early return)', async () => {
      // Regression (finding 14): the no-paths early return used to answer
      // agents: [] before the prompt-agent append ever ran, hiding personas
      // in deployments without Foundry ARM paths.
      accessIsEnabled.mockReturnValue(true);
      accessGetPromptAgents.mockReturnValue([PROMPT_AGENT]);
      getDiscoveryPathsForUser.mockReturnValue({
        regionalPath: null,
        officePaths: [],
      });

      const response = await GET(request());
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data).toEqual({
        agents: [
          {
            id: 'prompt-abc123def456',
            name: 'Legal Advisor',
            description: 'Reviews contracts',
            agentName: 'prompt-abc123def456',
            source: PROMPT_AGENT_SOURCE,
            type: 'prompt',
          },
        ],
        suppressedOrgAgentIds: [],
        regionalPath: null,
        officePaths: [],
      });
      // No ARM discovery ran — personas need neither paths nor tokens.
      expect(listUserAgents).not.toHaveBeenCalled();
      expect(getAccessTokenForOBO).not.toHaveBeenCalled();
    });

    it('still filters denied prompt agents on the no-paths early return', async () => {
      accessIsEnabled.mockReturnValue(true);
      accessGetPromptAgents.mockReturnValue([PROMPT_AGENT]);
      accessEvaluate.mockReturnValue({
        decision: 'deny',
        reason: 'not-allowed',
      });
      getDiscoveryPathsForUser.mockReturnValue({
        regionalPath: null,
        officePaths: [],
      });

      const response = await GET(request());
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.agents).toEqual([]);
    });

    it('serves prompt agents when OBO acquisition fails in production (early return)', async () => {
      // Regression (finding 14): a transient AAD failure used to blank
      // prompt agents from the picker — and the empty 200 is cached
      // client-side for up to 24h.
      vi.stubEnv('NODE_ENV', 'production');
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        accessIsEnabled.mockReturnValue(true);
        accessGetPromptAgents.mockReturnValue([PROMPT_AGENT]);
        getAccessTokenForOBO.mockRejectedValue(new Error('AAD flake'));

        const response = await GET(request());
        const data = await parseJsonResponse(response);

        expect(response.status).toBe(200);
        expect(
          data.agents.map((a: { agentName: string }) => a.agentName),
        ).toEqual(['prompt-abc123def456']);
        expect(data.regionalPath).toBe(REGIONAL_PATH);
        // No Foundry discovery and no trust-anchoring happened.
        expect(listUserAgents).not.toHaveBeenCalled();
        expect(cacheUserAgentEndpoint).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('OBO failed'),
        );
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('serves no prompt agents when the feature is disabled', async () => {
      accessIsEnabled.mockReturnValue(false);
      accessGetPromptAgents.mockReturnValue([PROMPT_AGENT]);

      const response = await GET(request());
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(
        data.agents.map((a: { agentName: string }) => a.agentName),
      ).toEqual(['agent-a', 'agent-b']);
      expect(accessGetPromptAgents).not.toHaveBeenCalled();
    });
  });

  describe('static org agents', () => {
    it('folds static ids the user is denied into suppressedOrgAgentIds', async () => {
      accessIsEnabled.mockReturnValue(true);
      accessEvaluate.mockImplementation(
        ({ source, agentName }: { source: string; agentName: string }) =>
          source === 'org-agent' && agentName === 'msf_communications'
            ? { decision: 'deny', reason: 'not-allowed' }
            : { decision: 'allow', reason: 'no-rule' },
      );

      const response = await GET(request());
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.suppressedOrgAgentIds).toEqual(['msf_communications']);
      // Foundry discovery is untouched by the org-agent rule.
      expect(
        data.agents.map((a: { agentName: string }) => a.agentName),
      ).toEqual(['agent-a', 'agent-b']);
    });

    it('keeps static agents visible on no-rule and on unavailable (visibility-only surface)', async () => {
      accessIsEnabled.mockReturnValue(true);
      accessEvaluate.mockImplementation(({ source }: { source: string }) =>
        source === 'org-agent'
          ? { decision: 'unavailable', reason: 'rules-unavailable' }
          : { decision: 'allow', reason: 'no-rule' },
      );

      const response = await GET(request());
      const data = await parseJsonResponse(response);

      expect(data.suppressedOrgAgentIds).toEqual([]);
    });
  });

  describe('M365 file-backed agents', () => {
    const m365Source = (overrides: Record<string, unknown>) => ({
      sourceId: 'src-1',
      driveId: 'd1',
      itemId: 'i1',
      kind: 'file',
      title: 'Doc',
      webUrl: '',
      status: 'pending',
      ...overrides,
    });
    const m365Agent = (
      id: string,
      sources: Array<Record<string, unknown>>,
    ) => ({
      id,
      name: id,
      description: '',
      sources,
    });

    it('hides never-indexed and zero-chunk agents from discovery', async () => {
      accessIsEnabled.mockReturnValue(true);
      accessGetM365Agents.mockReturnValue([
        m365Agent('m365-indexed0000', [
          m365Source({ status: 'indexed', indexedChunks: 12 }),
        ]),
        m365Agent('m365-neverindexed', [m365Source({})]),
        m365Agent('m365-emptyextract', [
          m365Source({ status: 'indexed', indexedChunks: 0 }),
        ]),
        m365Agent('m365-errored00000', [
          m365Source({ status: 'error', indexedChunks: 0 }),
        ]),
        // Legacy record: indexed before indexedChunks existed — stays.
        m365Agent('m365-legacy000000', [m365Source({ status: 'indexed' })]),
      ]);

      const response = await GET(request());
      const data = await parseJsonResponse(response);

      const ids = data.agents
        .filter((a: { type: string }) => a.type === 'm365')
        .map((a: { id: string }) => a.id);
      expect(ids).toEqual(['m365-indexed0000', 'm365-legacy000000']);
    });
  });

  it('passes the user as the discovery cache owner', async () => {
    await GET(request());
    expect(listUserAgents).toHaveBeenCalled();
    const [, , , owner] = listUserAgents.mock.calls[0];
    expect(typeof owner).toBe('string');
    expect(owner.length).toBeGreaterThan(0);
  });

  it('refresh clears only the caller’s cache, never the whole replica', async () => {
    await GET(request('refresh=1'));
    expect(clearCacheForUser).toHaveBeenCalledTimes(1);
    expect(clearCache).not.toHaveBeenCalled();
  });

  describe('split routes', () => {
    it('fast route serves app-defined agents without touching OBO or Foundry', async () => {
      accessIsEnabled.mockReturnValue(true);
      accessGetPromptAgents.mockReturnValue([
        { id: 'pa-1', name: 'Travel Advisor', description: 'd' },
      ]);
      const response = await GET(fastRequest());
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.agents.map((a: { id: string }) => a.id)).toEqual(['pa-1']);
      expect(body.regionalPath).toBeNull();
      expect(getAccessTokenForOBO).not.toHaveBeenCalled();
      expect(listUserAgents).not.toHaveBeenCalled();
      expect(response.headers.get('Server-Timing')).toMatch(/groups;dur=/);
    });

    it('foundry route discovers, filters, anchors endpoints and reports availability', async () => {
      accessIsEnabled.mockReturnValue(true);
      accessEvaluate.mockImplementation(
        ({ agentName }: { agentName: string }) => ({
          decision: agentName === 'agent-b' ? 'deny' : 'allow',
          reason: 'rule',
        }),
      );
      const response = await foundryGET(foundryRequest());
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.unavailable).toBe(false);
      expect(
        body.agents.map((a: { agentName: string }) => a.agentName),
      ).toEqual(['agent-a']);
      expect(body.regionalPath).toBe(REGIONAL_PATH);
      expect(cacheUserAgentEndpoint).toHaveBeenCalledWith(
        USER_MAIL,
        'agent-a',
        REGIONAL_PATH,
        ENDPOINT_A,
      );
      expect(cacheUserAgentEndpoint).not.toHaveBeenCalledWith(
        USER_MAIL,
        'agent-b',
        REGIONAL_PATH,
        ENDPOINT_B,
      );
      expect(accessGetPromptAgents).not.toHaveBeenCalled();
      expect(response.headers.get('Server-Timing')).toMatch(/discovery;dur=/);
    });

    it('foundry route reports unavailable (not empty) when OBO fails in production', async () => {
      const previous = process.env.NODE_ENV;
      (process.env as { NODE_ENV?: string }).NODE_ENV = 'production';
      getAccessTokenForOBO.mockResolvedValue(null);
      try {
        const body = await (await foundryGET(foundryRequest())).json();
        expect(body).toMatchObject({ agents: [], unavailable: true });
        expect(listUserAgents).not.toHaveBeenCalled();
      } finally {
        (process.env as { NODE_ENV?: string }).NODE_ENV = previous;
      }
    });

    it('foundry route refresh clears only the caller’s cache', async () => {
      await foundryGET(foundryRequest('refresh=1'));
      expect(clearCacheForUser).toHaveBeenCalledWith(USER_MAIL);
      expect(clearCache).not.toHaveBeenCalled();
    });

    it('foundry route 401s without a session', async () => {
      mockAuth.mockResolvedValue(null);
      expect((await foundryGET(foundryRequest())).status).toBe(401);
    });
  });
});
