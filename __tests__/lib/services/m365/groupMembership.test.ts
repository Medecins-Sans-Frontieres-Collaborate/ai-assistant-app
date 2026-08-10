/**
 * Group-membership cache semantics: TTL caching, dual-key reads (id +
 * mail), in-flight dedupe, and the never-throw failure posture that keeps
 * user/domain matching unaffected by Graph outages.
 */
import { NextRequest } from 'next/server';

import {
  clearGroupMembershipCache,
  getCachedGroupIdsForMail,
  getCachedGroupIdsForUser,
  resolveUserGroupIds,
} from '@/lib/services/m365/groupMembership';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const graphJsonMock = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({ getGraphAccessToken: vi.fn() }));
vi.mock('@/lib/services/m365/graphApi', () => ({
  graphJson: graphJsonMock,
}));

const req = new NextRequest('http://localhost/api/test');
const session = {
  user: { id: 'oid-1', mail: 'Ada@Contoso.com' },
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  clearGroupMembershipCache();
});

describe('resolveUserGroupIds', () => {
  it('fetches transitive groups and caches under both id and mail', async () => {
    graphJsonMock.mockResolvedValue({ value: ['g1', 'g2'] });
    const ids = await resolveUserGroupIds(req, session);
    expect(ids).toEqual(['g1', 'g2']);
    expect(graphJsonMock).toHaveBeenCalledWith(
      req,
      ['Group.Read.All'],
      '/me/getMemberGroups',
      expect.objectContaining({ method: 'POST' }),
    );
    // Sync reads hit for both keys; mail lookup is case-insensitive.
    expect(getCachedGroupIdsForUser('oid-1')).toEqual(['g1', 'g2']);
    expect(getCachedGroupIdsForMail('ada@contoso.com')).toEqual(['g1', 'g2']);
    expect(getCachedGroupIdsForMail('ADA@CONTOSO.COM')).toEqual(['g1', 'g2']);
  });

  it('serves the cache without a second Graph call inside the TTL', async () => {
    graphJsonMock.mockResolvedValue({ value: ['g1'] });
    await resolveUserGroupIds(req, session);
    await resolveUserGroupIds(req, session);
    expect(graphJsonMock).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent cold fetches into one Graph call', async () => {
    let release: (value: { value: string[] }) => void = () => undefined;
    graphJsonMock.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const first = resolveUserGroupIds(req, session);
    const second = resolveUserGroupIds(req, session);
    release({ value: ['g9'] });
    expect(await first).toEqual(['g9']);
    expect(await second).toEqual(['g9']);
    expect(graphJsonMock).toHaveBeenCalledTimes(1);
  });

  it('resolves to [] and negative-caches on Graph failure', async () => {
    graphJsonMock.mockRejectedValue(new Error('consent missing'));
    await expect(resolveUserGroupIds(req, session)).resolves.toEqual([]);
    // Cached failure: no immediate refetch storm.
    await resolveUserGroupIds(req, session);
    expect(graphJsonMock).toHaveBeenCalledTimes(1);
    expect(getCachedGroupIdsForUser('oid-1')).toEqual([]);
  });

  it('returns [] without fetching when there is no session user', async () => {
    await expect(resolveUserGroupIds(req, null)).resolves.toEqual([]);
    expect(graphJsonMock).not.toHaveBeenCalled();
  });

  it('drops non-string ids from the Graph response', async () => {
    graphJsonMock.mockResolvedValue({ value: ['g1', 42, null, ''] });
    await expect(resolveUserGroupIds(req, session)).resolves.toEqual(['g1']);
  });
});

describe('sync cache reads', () => {
  it('return [] when cold', () => {
    expect(getCachedGroupIdsForUser('unknown')).toEqual([]);
    expect(getCachedGroupIdsForMail('nobody@x.com')).toEqual([]);
    expect(getCachedGroupIdsForMail(undefined)).toEqual([]);
  });
});
