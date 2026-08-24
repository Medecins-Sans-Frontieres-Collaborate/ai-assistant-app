import { NextRequest } from 'next/server';

import { VIEW_AS_COOKIE } from '@/lib/services/admin/viewAsTypes';

import { parseJsonResponse } from '../helpers';

import { DELETE, GET, PUT } from '@/app/api/admin/view-as/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const mockEnv = vi.hoisted(() => ({
  AGENT_ACCESS_ADMINS: 'admin@example.com',
}));
vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/config/environment', () => ({ env: mockEnv }));

const admin = {
  user: {
    id: 'oid-1',
    displayName: 'Admin',
    mail: 'admin@example.com',
    department: 'Systems',
    region: 'EU',
    actualRegion: 'EU',
  },
};
const demotedAdmin = {
  user: {
    ...admin.user,
    department: 'Program',
    viewAs: {
      overrides: { adminRole: 'none', department: 'Program' },
      actual: { department: 'Systems' },
    },
  },
};
const user = { user: { id: 'oid-2', displayName: 'U', mail: 'u@example.com' } };

function put(body: unknown) {
  return new NextRequest('http://localhost/api/admin/view-as', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('/api/admin/view-as', () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = 'test-secret';
    mockAuth.mockResolvedValue(admin);
  });

  it('401s signed out, 403s a non-admin on every verb', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    mockAuth.mockResolvedValue(user);
    expect((await GET()).status).toBe(403);
    expect((await PUT(put({ adminRole: 'none' }))).status).toBe(403);
    expect((await DELETE()).status).toBe(403);
  });

  it('stays reachable for an admin currently viewing as a regular user', async () => {
    mockAuth.mockResolvedValue(demotedAdmin);
    const body = await parseJsonResponse(await GET());
    expect(body.data.active.overrides.adminRole).toBe('none');
    // "actual" reports the real value, not the overridden one.
    expect(body.data.actual.department).toBe('Systems');
    expect((await DELETE()).status).toBe(200);
  });

  it('PUT validates and sets a signed httpOnly cookie', async () => {
    expect((await PUT(put({ adminRole: 'superuser' }))).status).toBe(400);
    expect((await PUT(put({ unknown: 1 }))).status).toBe(400);
    // Nothing to apply (all blanks) is a 400, not a silent no-op cookie.
    expect((await PUT(put({ department: '   ' }))).status).toBe(400);

    const response = await PUT(put({ adminRole: 'none', groupIds: ['g1'] }));
    expect(response.status).toBe(200);
    const cookie = response.cookies.get(VIEW_AS_COOKIE);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.value).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('DELETE clears the cookie', async () => {
    const response = await DELETE();
    expect(response.status).toBe(200);
    const cookie = response.cookies.get(VIEW_AS_COOKIE);
    expect(cookie?.value).toBe('');
    expect(cookie?.maxAge).toBe(0);
  });
});
