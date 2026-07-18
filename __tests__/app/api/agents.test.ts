import { NextRequest } from 'next/server';

import { parseJsonResponse } from './helpers';

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
const accessIsEnabled = vi.hoisted(() => vi.fn());
const accessEnsureFresh = vi.hoisted(() => vi.fn());
const accessEvaluate = vi.hoisted(() => vi.fn());

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
    }),
  },
}));

const REGIONAL_PATH =
  '/subscriptions/abc/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/acct/projects/proj';
const ENDPOINT_A = 'https://acct.services.ai.azure.com/api/projects/proj';
const ENDPOINT_B = 'https://acct.services.ai.azure.com/api/projects/proj2';

const USER_MAIL = 'user@example.com';

function request(): NextRequest {
  return new NextRequest('http://localhost:3000/api/agents');
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
});
