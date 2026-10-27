import { NextRequest } from 'next/server';

import { parseJsonResponse } from '../helpers';

import { GET } from '@/app/api/grants/access/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const mockHasGrantsAccess = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/lib/services/grants/serverAccess', () => ({
  hasGrantsAccess: mockHasGrantsAccess,
}));

const session = {
  user: { id: 'oid-1', displayName: 'Member', mail: 'member@example.org' },
};
const request = () => new NextRequest('http://localhost/api/grants/access');

describe('GET /api/grants/access', () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockHasGrantsAccess.mockReset();
  });

  it('rejects unauthenticated requests without consulting membership', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(mockHasGrantsAccess).not.toHaveBeenCalled();
  });

  it('reports membership for the signed-in user', async () => {
    mockAuth.mockResolvedValue(session);
    mockHasGrantsAccess.mockResolvedValue(true);
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect((await parseJsonResponse(res)).data).toEqual({ hasAccess: true });
    expect(mockHasGrantsAccess).toHaveBeenCalledWith(
      expect.any(NextRequest),
      session,
    );
  });

  it('reports non-membership as false, not an error', async () => {
    mockAuth.mockResolvedValue(session);
    mockHasGrantsAccess.mockResolvedValue(false);
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect((await parseJsonResponse(res)).data).toEqual({ hasAccess: false });
  });
});
