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
  isGroupMembershipDegraded,
  isGroupMembershipDegradedForUser,
  resolveUserGroupIds,
} from '@/lib/services/m365/groupMembership';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const graphJsonMock = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({ getGraphAccessToken: vi.fn() }));
vi.mock('@/lib/services/m365/graphApi', () => ({
  graphJson: graphJsonMock,
}));

/**
 * Stand-in for graphApi's M365Error. The module under test classifies by
 * `name` + `kind` rather than `instanceof`, precisely because the real class
 * lives behind a lazy import that this file mocks away — so a structurally
 * identical error is the faithful fixture.
 */
class FakeM365Error extends Error {
  constructor(
    message: string,
    readonly kind: string,
  ) {
    super(message);
    this.name = 'M365Error';
  }
}

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
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    graphJsonMock.mockRejectedValue(new Error('consent missing'));
    await expect(resolveUserGroupIds(req, session)).resolves.toEqual([]);
    // Cached failure: no immediate refetch storm.
    await resolveUserGroupIds(req, session);
    expect(graphJsonMock).toHaveBeenCalledTimes(1);
    expect(getCachedGroupIdsForUser('oid-1')).toEqual([]);
    // ...and that [] is marked as "could not ask", under both keys, so the
    // agent-access evaluator can say 'unavailable' instead of denying.
    expect(isGroupMembershipDegradedForUser('oid-1')).toBe(true);
    expect(isGroupMembershipDegraded('ada@contoso.com')).toBe(true);
    expect(isGroupMembershipDegraded('ADA@CONTOSO.COM')).toBe(true);
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

describe('degradation reporting', () => {
  it('reports false when cold — an unasked user is not a failed one', () => {
    // This is what preserves the hard deny for users who genuinely match
    // nothing: only a RECORDED failure softens a deny.
    expect(isGroupMembershipDegradedForUser('unknown')).toBe(false);
    expect(isGroupMembershipDegraded('nobody@x.com')).toBe(false);
    expect(isGroupMembershipDegraded(undefined)).toBe(false);
    expect(isGroupMembershipDegraded('')).toBe(false);
  });

  it('reports false after a successful lookup that found no groups', async () => {
    graphJsonMock.mockResolvedValue({ value: [] });
    await resolveUserGroupIds(req, session);
    expect(getCachedGroupIdsForUser('oid-1')).toEqual([]);
    expect(isGroupMembershipDegradedForUser('oid-1')).toBe(false);
    expect(isGroupMembershipDegraded('ada@contoso.com')).toBe(false);
  });

  it.each(['rate_limited', 'graph_error'])(
    'marks a retryable %s failure as degraded',
    async (kind) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      graphJsonMock.mockRejectedValue(new FakeM365Error('graph blip', kind));
      await resolveUserGroupIds(req, session);
      expect(isGroupMembershipDegradedForUser('oid-1')).toBe(true);
      expect(isGroupMembershipDegraded('ada@contoso.com')).toBe(true);
    },
  );

  it.each(['consent_missing', 'not_connected', 'forbidden'])(
    'leaves a structural %s failure UNdegraded so group rules keep denying',
    async (kind) => {
      // The negative-cache entry is re-armed identically on every expiry, so
      // marking these would soften every group-scoped rule for as long as the
      // gap lasts — restricted agents listed to the whole tenant with no
      // expiry, which is not the outage window the softening exists for.
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      graphJsonMock.mockRejectedValue(new FakeM365Error('structural', kind));
      await expect(resolveUserGroupIds(req, session)).resolves.toEqual([]);
      expect(getCachedGroupIdsForUser('oid-1')).toEqual([]);
      expect(isGroupMembershipDegradedForUser('oid-1')).toBe(false);
      expect(isGroupMembershipDegraded('ada@contoso.com')).toBe(false);
    },
  );

  it('clears once a later lookup succeeds', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    graphJsonMock.mockRejectedValueOnce(new Error('graph down'));
    await resolveUserGroupIds(req, session);
    expect(isGroupMembershipDegradedForUser('oid-1')).toBe(true);

    clearGroupMembershipCache();
    graphJsonMock.mockResolvedValue({ value: ['g1'] });
    await resolveUserGroupIds(req, session);
    expect(isGroupMembershipDegradedForUser('oid-1')).toBe(false);
  });
});
