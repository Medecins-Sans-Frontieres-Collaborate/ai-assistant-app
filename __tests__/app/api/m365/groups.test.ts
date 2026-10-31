/**
 * /api/m365/groups — the admin pickers' name resolution. POST resolves up to
 * 500 ids through the batched directory resolver; GET keeps the legacy ≤50
 * comma list and the startswith search. Ids are validated as Entra GUIDs.
 */
import { NextRequest } from 'next/server';

import { fetchGroupNames } from '@/lib/services/m365/groupDirectory';

import { parseJsonResponse } from '../helpers';

import { GET, POST } from '@/app/api/m365/groups/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/lib/services/m365/graphApi', () => ({
  graphJson: vi.fn(),
  m365ErrorResponse: vi.fn(
    () => new Response(JSON.stringify({ success: false }), { status: 502 }),
  ),
}));
vi.mock('@/lib/services/m365/groupDirectory', () => ({
  GROUP_SCOPES: ['Group.Read.All'],
  fetchGroupNames: vi.fn(),
}));

const G1 = '11111111-1111-4111-8111-111111111111';
const G2 = '22222222-2222-4222-8222-222222222222';

function post(body: unknown) {
  return new NextRequest('http://localhost/api/m365/groups', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: 'oid-1', mail: 'a@x.org' } });
  vi.mocked(fetchGroupNames).mockResolvedValue(new Map([[G1, 'Health team']]));
});

describe('POST /api/m365/groups', () => {
  it('401s without a session', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await POST(post({ ids: [G1] }))).status).toBe(401);
  });

  it('resolves names in one batched call, dedupes + lowercases ids, and omits unknown ids', async () => {
    const response = await POST(post({ ids: [G1.toUpperCase(), G1, G2] }));
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.data.groups).toEqual([{ id: G1, name: 'Health team' }]);
    expect(fetchGroupNames).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchGroupNames).mock.calls[0][1]).toEqual([G1, G2]);
  });

  it('400s a non-GUID, an empty list and more than 500 ids', async () => {
    expect((await POST(post({ ids: ['Health team'] }))).status).toBe(400);
    expect((await POST(post({ ids: [] }))).status).toBe(400);
    expect(
      (
        await POST(
          post({
            ids: Array.from(
              { length: 501 },
              (_, i) =>
                `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
            ),
          }),
        )
      ).status,
    ).toBe(400);
    expect(fetchGroupNames).not.toHaveBeenCalled();
  });

  it('400s a malformed body', async () => {
    const response = await POST(
      new NextRequest('http://localhost/api/m365/groups', {
        method: 'POST',
        body: 'not json',
      }),
    );
    expect(response.status).toBe(400);
  });
});

describe('GET /api/m365/groups?ids=', () => {
  it('still answers the legacy comma list (≤50) through the same resolver', async () => {
    const response = await GET(
      new NextRequest(`http://localhost/api/m365/groups?ids=${G1},${G2}`),
    );
    expect(response.status).toBe(200);
    expect((await parseJsonResponse(response)).data.groups).toEqual([
      { id: G1, name: 'Health team' },
    ]);
  });

  it('400s a display name passed as an id', async () => {
    const response = await GET(
      new NextRequest('http://localhost/api/m365/groups?ids=Health%20team'),
    );
    expect(response.status).toBe(400);
  });
});
