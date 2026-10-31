/**
 * lib/services/m365/groupDirectory.ts — the directory reads behind group
 * targeting: membership for /me or another user (with the paged fallback
 * past Graph's getMemberGroups ceiling), batched + cached display names,
 * and the user lookup the admin preview relies on.
 */
import { NextRequest } from 'next/server';

import {
  clearGroupDirectoryCache,
  fetchGroupNames,
  fetchMemberGroupIds,
  isOversizeMembershipError,
  lookupDirectoryUser,
} from '@/lib/services/m365/groupDirectory';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const graphJsonMock = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({ getGraphAccessToken: vi.fn() }));
vi.mock('@/lib/services/m365/graphApi', () => ({
  graphJson: graphJsonMock,
}));

class FakeM365Error extends Error {
  constructor(
    message: string,
    readonly kind: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'M365Error';
  }
}

const req = new NextRequest('http://localhost/api/test');
const G1 = '11111111-1111-4111-8111-111111111111';
const G2 = '22222222-2222-4222-8222-222222222222';
const G3 = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  clearGroupDirectoryCache();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('fetchMemberGroupIds', () => {
  it('asks getMemberGroups for /me with the same call shape the cache always used', async () => {
    graphJsonMock.mockResolvedValue({ value: [G1, 42, '', G2] });
    const result = await fetchMemberGroupIds(req, { kind: 'me' });
    expect(result).toEqual({
      groupIds: [G1, G2],
      oversizeFallback: false,
      truncated: false,
    });
    expect(graphJsonMock).toHaveBeenCalledWith(
      req,
      ['Group.Read.All'],
      '/me/getMemberGroups',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('targets another user by object id for the admin preview', async () => {
    graphJsonMock.mockResolvedValue({ value: [G1] });
    await fetchMemberGroupIds(req, { kind: 'user', userId: 'oid-target' });
    expect(graphJsonMock.mock.calls[0][2]).toBe(
      '/users/oid-target/getMemberGroups',
    );
  });

  it('falls back to the paged transitiveMemberOf walk when Graph refuses with 400 (2046+ groups)', async () => {
    graphJsonMock
      .mockRejectedValueOnce(
        new FakeM365Error(
          'Directory_ResultSizeLimitExceeded',
          'graph_error',
          400,
        ),
      )
      .mockResolvedValueOnce({
        value: [{ id: G1 }, { id: G2 }],
        '@odata.nextLink':
          'https://graph.microsoft.com/v1.0/me/transitiveMemberOf?$skiptoken=abc',
      })
      .mockResolvedValueOnce({ value: [{ id: G3 }, { id: 7 }] });
    const result = await fetchMemberGroupIds(req, { kind: 'me' });
    expect(result).toEqual({
      groupIds: [G1, G2, G3],
      oversizeFallback: true,
      truncated: false,
    });
    expect(graphJsonMock).toHaveBeenCalledTimes(3);
    expect(graphJsonMock.mock.calls[1][2]).toContain(
      '/me/transitiveMemberOf/microsoft.graph.group?$select=id&$top=999',
    );
    // The nextLink is followed verbatim (absolute URL).
    expect(graphJsonMock.mock.calls[2][2]).toContain('$skiptoken=abc');
  });

  it('rethrows every other failure untouched (callers own the posture)', async () => {
    const error = new FakeM365Error('consent', 'consent_missing', 403);
    graphJsonMock.mockRejectedValue(error);
    await expect(fetchMemberGroupIds(req, { kind: 'me' })).rejects.toBe(error);
    expect(graphJsonMock).toHaveBeenCalledTimes(1);
  });

  it('isOversizeMembershipError is a typed 400 and nothing else', () => {
    expect(
      isOversizeMembershipError(new FakeM365Error('x', 'graph_error', 400)),
    ).toBe(true);
    expect(
      isOversizeMembershipError(new FakeM365Error('x', 'graph_error', 502)),
    ).toBe(false);
    expect(isOversizeMembershipError(new Error('network'))).toBe(false);
  });
});

describe('fetchGroupNames', () => {
  it('resolves every uncached id with ONE getByIds call and caches the answers', async () => {
    graphJsonMock.mockResolvedValue({
      value: [
        { id: G1, displayName: 'Health' },
        { id: G2, displayName: '' },
      ],
    });
    const first = await fetchGroupNames(req, [G1, G2, G1]);
    expect([...first.entries()]).toEqual([
      [G1, 'Health'],
      [G2, G2], // blank display name falls back to the id
    ]);
    expect(graphJsonMock).toHaveBeenCalledTimes(1);
    expect(graphJsonMock.mock.calls[0][2]).toBe('/directoryObjects/getByIds');
    expect(JSON.parse(graphJsonMock.mock.calls[0][3].body)).toEqual({
      ids: [G1, G2],
      types: ['group'],
    });

    const second = await fetchGroupNames(req, [G1, G2]);
    expect(second.get(G1)).toBe('Health');
    expect(graphJsonMock).toHaveBeenCalledTimes(1);
  });

  it('leaves unknown ids out and remembers them briefly so editors do not re-ask', async () => {
    graphJsonMock.mockResolvedValue({ value: [{ id: G1, displayName: 'A' }] });
    const result = await fetchGroupNames(req, [G1, G3]);
    expect(result.has(G3)).toBe(false);
    await fetchGroupNames(req, [G3]);
    expect(graphJsonMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to per-id GETs when the batch endpoint is refused', async () => {
    graphJsonMock
      .mockRejectedValueOnce(new FakeM365Error('nope', 'forbidden', 403))
      .mockResolvedValueOnce({ id: G1, displayName: 'One' })
      .mockRejectedValueOnce(new FakeM365Error('gone', 'not_found', 404));
    const result = await fetchGroupNames(req, [G1, G2]);
    expect([...result.entries()]).toEqual([[G1, 'One']]);
    expect(graphJsonMock.mock.calls[1][2]).toBe(
      `/groups/${G1}?$select=id,displayName`,
    );
  });

  it('throws only when both paths produced nothing', async () => {
    const error = new FakeM365Error('nope', 'forbidden', 403);
    graphJsonMock.mockRejectedValue(error);
    await expect(fetchGroupNames(req, [G1])).rejects.toBe(error);
  });
});

describe('lookupDirectoryUser', () => {
  it('finds the record by mail with a quote-safe OData filter and the targeting fields', async () => {
    graphJsonMock.mockResolvedValue({
      value: [
        {
          id: 'oid-1',
          mail: "o'brien@x.org",
          userPrincipalName: 'obrien@x.org',
          department: 'Health',
          companyName: null,
        },
      ],
    });
    const user = await lookupDirectoryUser(req, "o'brien@x.org");
    expect(user).toEqual({
      id: 'oid-1',
      mail: "o'brien@x.org",
      userPrincipalName: 'obrien@x.org',
      department: 'Health',
      companyName: undefined,
    });
    const path = graphJsonMock.mock.calls[0][2] as string;
    expect(path.startsWith('/users?$filter=mail eq ')).toBe(true);
    expect(path).toContain(encodeURIComponent("o''brien@x.org"));
    expect(graphJsonMock.mock.calls[0][1]).toEqual(['User.Read.All']);
  });

  it('falls back to the UPN form and answers null for an unknown person', async () => {
    graphJsonMock
      .mockResolvedValueOnce({ value: [] })
      .mockRejectedValueOnce(new FakeM365Error('no', 'not_found', 404));
    expect(await lookupDirectoryUser(req, 'nobody@x.org')).toBeNull();
    expect(graphJsonMock.mock.calls[1][2]).toBe(
      `/users/${encodeURIComponent('nobody@x.org')}?$select=id,mail,userPrincipalName,department,companyName`,
    );
  });

  it('propagates other failures so the caller can say "unavailable"', async () => {
    graphJsonMock
      .mockResolvedValueOnce({ value: [] })
      .mockRejectedValueOnce(new FakeM365Error('down', 'graph_error', 502));
    await expect(lookupDirectoryUser(req, 'x@y.org')).rejects.toMatchObject({
      kind: 'graph_error',
    });
  });
});
