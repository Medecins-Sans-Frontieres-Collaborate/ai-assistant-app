/**
 * End to end through the real modules: a group-targeted model-approval
 * grant applies to a user only after the membership cache has been warmed
 * from Graph, via the same `buildPrincipal` the chat gate uses. This is the
 * seam the audit found untested — every other suite mocks one side.
 */
import { NextRequest } from 'next/server';

import { isModelBlocked } from '@/lib/services/limits/modelAvailability';
import { buildPrincipal } from '@/lib/services/limits/principal';
import { LimitsPolicySchema } from '@/lib/services/limits/types';
import {
  clearGroupMembershipCache,
  resolveUserGroupIds,
} from '@/lib/services/m365/groupMembership';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const graphJsonMock = vi.hoisted(() => vi.fn());
vi.mock('@/auth', () => ({ getGraphAccessToken: vi.fn() }));
vi.mock('@/lib/services/m365/graphApi', () => ({
  graphJson: graphJsonMock,
}));

const RESEARCH = '11111111-1111-4111-8111-111111111111';
const req = new NextRequest('http://localhost/api/chat');
const session = {
  user: { id: 'oid-alice', mail: 'alice@ocp.msf.org', department: 'Health' },
} as never;

const policy = LimitsPolicySchema.parse({
  version: 1,
  mode: 'enforce',
  modelAccess: [
    {
      series: 'claude',
      defaultAccess: false,
      groups: [{ target: RESEARCH, requests: null }],
      domains: [],
      allow: [],
      deny: [],
    },
  ],
  updatedBy: 'admin@x.org',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

beforeEach(() => {
  vi.clearAllMocks();
  clearGroupMembershipCache();
});

describe('group grant → warmed cache → principal → model gate', () => {
  it('blocks while the cache is cold and opens once the route has warmed it', async () => {
    expect(
      isModelBlocked(
        policy,
        buildPrincipal(session),
        'claude-sonnet-5',
        'claude',
      ),
    ).toBe(true);

    graphJsonMock.mockResolvedValue({ value: [RESEARCH.toUpperCase()] });
    await resolveUserGroupIds(req, session);

    const principal = buildPrincipal(session);
    expect(principal.groupIds).toEqual([RESEARCH.toUpperCase()]);
    expect(principal.attributes).toEqual(['department:health']);
    // Case-insensitive on both sides, like every other target.
    expect(isModelBlocked(policy, principal, 'claude-sonnet-5', 'claude')).toBe(
      false,
    );
  });

  it('keeps blocking (fail-closed for a grant) when Graph fails, and recovers after the negative TTL', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    graphJsonMock.mockRejectedValueOnce(new Error('network'));
    await resolveUserGroupIds(req, session);
    expect(
      isModelBlocked(
        policy,
        buildPrincipal(session),
        'claude-sonnet-5',
        'claude',
      ),
    ).toBe(true);

    clearGroupMembershipCache(); // stands in for the 60 s negative TTL
    graphJsonMock.mockResolvedValueOnce({ value: [RESEARCH] });
    await resolveUserGroupIds(req, session);
    expect(
      isModelBlocked(
        policy,
        buildPrincipal(session),
        'claude-sonnet-5',
        'claude',
      ),
    ).toBe(false);
  });

  it('view-as membership replaces the directory answer for the session', async () => {
    const viewAs = {
      user: {
        ...(session as { user: object }).user,
        viewAs: { overrides: { groupIds: [RESEARCH] } },
      },
    } as never;
    await resolveUserGroupIds(req, viewAs);
    expect(graphJsonMock).not.toHaveBeenCalled();
    expect(
      isModelBlocked(
        policy,
        buildPrincipal(viewAs),
        'claude-sonnet-5',
        'claude',
      ),
    ).toBe(false);
  });
});
