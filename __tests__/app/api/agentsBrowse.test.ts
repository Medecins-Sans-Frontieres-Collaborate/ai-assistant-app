import { NextRequest } from 'next/server';

import { parseJsonResponse } from './helpers';

import { GET } from '@/app/api/agents/browse/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  assertion: vi.fn(),
  arm: vi.fn(),
  foundry: vi.fn(),
  getTree: vi.fn(),
  getAgentTree: vi.fn(),
  clearTree: vi.fn(),
  clearAgents: vi.fn(),
  enabled: vi.fn(),
  fresh: vi.fn(),
  evaluate: vi.fn(),
  groups: vi.fn(),
  fallback: vi.fn(),
}));

vi.mock('@/auth', () => ({
  auth: mocks.auth,
  getAccessTokenForOBO: mocks.assertion,
}));
vi.mock('@/lib/services/auth/UserTokenProvider', () => ({
  UserTokenProvider: {
    getInstance: () => ({
      getArmToken: mocks.arm,
      getFoundryToken: mocks.foundry,
    }),
  },
}));
vi.mock('@/lib/services/auth/appIdentityCredential', () => ({
  createAppIdentityCredential: mocks.fallback,
}));
vi.mock('@/lib/services/agents/ResourceTreeService', () => ({
  ResourceTreeService: {
    getInstance: () => ({
      getTree: mocks.getTree,
      getAgentTree: mocks.getAgentTree,
      clearCache: mocks.clearTree,
    }),
  },
}));
vi.mock('@/lib/services/agents/AgentDiscoveryService', () => ({
  AgentDiscoveryService: {
    getInstance: () => ({ clearCacheForUser: mocks.clearAgents }),
  },
}));
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: {
    getInstance: () => ({
      isEnabled: mocks.enabled,
      ensureFresh: mocks.fresh,
      evaluateAccess: mocks.evaluate,
    }),
  },
}));
vi.mock('@/lib/services/m365/groupMembership', () => ({
  resolveUserGroupIds: mocks.groups,
}));

const tree = { subscriptions: [], failedSubscriptions: [], truncated: false };
const user = { id: 'user-id', mail: 'user@example.org' };
const request = (query = 'level=tree&purpose=agents') =>
  new NextRequest(`http://localhost/api/agents/browse?${query}`);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user });
  mocks.assertion.mockResolvedValue('assertion');
  mocks.arm.mockResolvedValue('arm-token');
  mocks.foundry.mockResolvedValue('foundry-token');
  mocks.getTree.mockResolvedValue(tree);
  mocks.getAgentTree.mockResolvedValue(tree);
  mocks.enabled.mockReturnValue(true);
  mocks.fresh.mockResolvedValue(undefined);
  mocks.groups.mockResolvedValue(undefined);
  mocks.evaluate.mockReturnValue({ decision: 'allow' });
});

describe('agent-aware Foundry browse route', () => {
  it('passes the user tokens and app-rule filter after warming groups and rules', async () => {
    mocks.getAgentTree.mockImplementation(
      async (_arm, _foundry, _owner, visible) => {
        expect(mocks.groups).toHaveBeenCalled();
        expect(mocks.fresh).toHaveBeenCalled();
        mocks.evaluate.mockReturnValue({ decision: 'deny' });
        expect(visible({ agentName: 'restricted' }, 'source')).toBe(false);
        expect(mocks.evaluate).toHaveBeenCalledWith({
          userMail: user.mail,
          source: 'source',
          agentName: 'restricted',
        });
        // Match discovery's visibility-only pass-through on unavailable rules.
        mocks.evaluate.mockReturnValue({ decision: 'unavailable' });
        expect(visible({ agentName: 'degraded' }, 'source')).toBe(true);
        return tree;
      },
    );
    const response = await GET(request());
    expect(await parseJsonResponse(response)).toEqual(tree);
    expect(mocks.getAgentTree).toHaveBeenCalledWith(
      'arm-token',
      'foundry-token',
      user.mail,
      expect.any(Function),
    );
  });

  it('does not prune the model-source tree or request a Foundry token for it', async () => {
    await GET(request('level=tree'));
    expect(mocks.getTree).toHaveBeenCalledWith('arm-token');
    expect(mocks.getAgentTree).not.toHaveBeenCalled();
    expect(mocks.foundry).not.toHaveBeenCalled();
    expect(mocks.groups).not.toHaveBeenCalled();
  });

  it('refresh invalidates agent discovery only for the signed-in user', async () => {
    await GET(request('level=tree&purpose=agents&refresh=1'));
    expect(mocks.clearAgents).toHaveBeenCalledWith(user.mail);
  });

  it('allows ARM discovery when Foundry consent is missing, without changing identity', async () => {
    mocks.foundry.mockRejectedValue(new Error('consent required'));
    await GET(request());
    expect(mocks.getAgentTree).toHaveBeenCalledWith(
      'arm-token',
      null,
      user.mail,
      expect.any(Function),
    );
    expect(mocks.fallback).not.toHaveBeenCalled();
  });

  it('reports a failed scan as unavailable rather than a successful empty tree', async () => {
    mocks.getAgentTree.mockRejectedValue(new Error('upstream failed'));
    expect(await parseJsonResponse(await GET(request()))).toMatchObject({
      subscriptions: [],
      unavailable: true,
    });
  });

  it('rejects unauthenticated users before requesting tokens', async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await GET(request())).status).toBe(401);
    expect(mocks.arm).not.toHaveBeenCalled();
  });
});
