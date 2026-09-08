import { NextRequest } from 'next/server';

import {
  clearGroupMembershipCache,
  getCachedGroupIdsForMail,
  getCachedGroupIdsForUser,
  isGroupMembershipDegraded,
  isGroupMembershipDegradedForUser,
  resolveUserGroupIds,
} from '@/lib/services/m365/groupMembership';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const graphJson = vi.hoisted(() => vi.fn());
vi.mock('@/lib/services/m365/graphApi', () => ({ graphJson }));

const req = new NextRequest('http://localhost/api/x');
const base = { id: 'oid-1', displayName: 'Admin', mail: 'Admin@Example.com' };

describe('group membership under view-as', () => {
  beforeEach(() => {
    clearGroupMembershipCache();
    graphJson.mockReset();
    graphJson.mockResolvedValue({ value: ['real-group'] });
  });

  it('replaces membership for the session and never touches Graph', async () => {
    const session = {
      user: {
        ...base,
        viewAs: { overrides: { groupIds: ['g-test'] }, actual: {} },
      },
    } as never;
    expect(await resolveUserGroupIds(req, session)).toEqual(['g-test']);
    expect(graphJson).not.toHaveBeenCalled();
    expect(getCachedGroupIdsForUser('oid-1')).toEqual(['g-test']);
    expect(getCachedGroupIdsForMail('admin@example.com')).toEqual(['g-test']);
  });

  it('drops the override on the first request without view-as', async () => {
    await resolveUserGroupIds(req, {
      user: {
        ...base,
        viewAs: { overrides: { groupIds: ['g-test'] }, actual: {} },
      },
    } as never);
    expect(await resolveUserGroupIds(req, { user: base } as never)).toEqual([
      'real-group',
    ]);
    expect(getCachedGroupIdsForUser('oid-1')).toEqual(['real-group']);
    expect(getCachedGroupIdsForMail('admin@example.com')).toEqual([
      'real-group',
    ]);
  });

  it('is never degraded, even over a failed real lookup', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Real lookup fails first, leaving a degraded entry in the real maps...
    graphJson.mockRejectedValueOnce(new Error('graph down'));
    await resolveUserGroupIds(req, { user: base } as never);
    expect(isGroupMembershipDegradedForUser('oid-1')).toBe(true);

    // ...then view-as supplies authoritative membership for the session.
    await resolveUserGroupIds(req, {
      user: {
        ...base,
        viewAs: { overrides: { groupIds: ['g-test'] }, actual: {} },
      },
    } as never);
    expect(isGroupMembershipDegradedForUser('oid-1')).toBe(false);
    expect(isGroupMembershipDegraded('admin@example.com')).toBe(false);
  });

  it('does not pollute the real cache while active', async () => {
    await resolveUserGroupIds(req, { user: base } as never);
    await resolveUserGroupIds(req, {
      user: { ...base, viewAs: { overrides: { groupIds: [] }, actual: {} } },
    } as never);
    // Empty override list is "no override" after normalization on the
    // server; here it is passed raw, so it is honoured as an override.
    await resolveUserGroupIds(req, {
      user: {
        ...base,
        viewAs: { overrides: { groupIds: ['g-only'] }, actual: {} },
      },
    } as never);
    expect(getCachedGroupIdsForUser('oid-1')).toEqual(['g-only']);
    await resolveUserGroupIds(req, { user: base } as never);
    // Real cache entry survived untouched (no second Graph call).
    expect(graphJson).toHaveBeenCalledTimes(1);
    expect(getCachedGroupIdsForUser('oid-1')).toEqual(['real-group']);
  });
});
