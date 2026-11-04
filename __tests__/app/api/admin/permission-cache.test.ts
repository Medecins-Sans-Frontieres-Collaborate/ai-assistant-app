import { NextRequest } from 'next/server';

import { GET, POST } from '@/app/api/admin/permission-cache/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  invalidate: vi.fn(),
  rulesInvalidate: vi.fn(),
  bump: vi.fn(),
}));
vi.mock('@/auth', () => ({ auth: mocks.auth }));
vi.mock('@/config/environment', () => ({
  env: {
    AGENT_ACCESS_ADMINS: 'admin@example.org',
    PERMISSION_GROUP_CACHE_MINUTES: 5,
    PERMISSION_SOURCE_CACHE_MINUTES: 15,
  },
}));
vi.mock('@/lib/services/permissions/PermissionCache', () => ({
  getPermissionCache: () => ({ invalidate: mocks.invalidate }),
}));
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: {
    getInstance: () => ({ invalidate: mocks.rulesInvalidate }),
  },
}));
vi.mock('@/lib/services/agentAccess/accessRulesStore', () => ({
  createAgentAccessBlobStorage: () => ({}),
  bumpGeneration: mocks.bump,
}));

const userId = '11111111-1111-4111-8111-111111111111';
function request(body: unknown) {
  return new NextRequest('http://localhost/api/admin/permission-cache', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({
    user: { id: 'admin', mail: 'admin@example.org' },
  });
  mocks.invalidate.mockResolvedValue({
    generation: 'new',
    invalidatedAt: '2026-11-04T12:00:00Z',
  });
  mocks.bump.mockResolvedValue(undefined);
});

describe('permission cache admin API', () => {
  it('exposes configured maximum ages only to global admins', async () => {
    expect(await (await GET()).json()).toMatchObject({
      data: { groupCacheMinutes: 5, sourceCacheMinutes: 15 },
    });
    mocks.auth.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it.each([
    { user: { mail: 'user@example.org' } },
    {
      user: {
        mail: 'admin@example.org',
        viewAs: { overrides: { adminRole: 'none' } },
      },
    },
    {
      user: {
        mail: 'admin@example.org',
        viewAs: { overrides: { adminRole: 'local' } },
      },
    },
  ])('rejects non-admin and view-as-demoted identities', async (session) => {
    mocks.auth.mockResolvedValue(session);
    expect((await POST(request({ scope: 'user', userId }))).status).toBe(403);
    expect((await GET()).status).toBe(403);
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(mocks.bump).not.toHaveBeenCalled();
  });

  it.each([
    { scope: 'all' },
    { scope: 'all', confirm: false },
    { scope: 'user', userId: 'email@example.org' },
    { scope: 'user', userId, forged: true },
  ])('rejects invalid or unconfirmed bodies', async (body) => {
    expect((await POST(request(body))).status).toBe(400);
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it('invalidates a selected user and reports fresh verification required, not rechecked', async () => {
    const response = await POST(request({ scope: 'user', userId }));
    expect(response.status).toBe(200);
    expect(mocks.invalidate).toHaveBeenCalledWith('admin@example.org', userId);
    expect(mocks.bump).toHaveBeenCalledTimes(1);
    expect(await response.json()).toMatchObject({
      data: {
        status: 'invalidated',
        freshVerificationRequired: true,
        scope: 'user',
        userId,
      },
    });
  });

  it('invalidates everyone only after explicit confirmation', async () => {
    expect((await POST(request({ scope: 'all', confirm: true }))).status).toBe(
      200,
    );
    expect(mocks.invalidate).toHaveBeenCalledWith(
      'admin@example.org',
      undefined,
    );
  });

  it('waits for durable invalidation before returning success', async () => {
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    mocks.invalidate.mockImplementation(() => {
      started();
      return new Promise((resolve) => {
        release = () => resolve({ generation: 'new', invalidatedAt: 'now' });
      });
    });
    let finished = false;
    const response = POST(request({ scope: 'all', confirm: true })).then(
      (value) => {
        finished = true;
        return value;
      },
    );
    await ready;
    expect(finished).toBe(false);
    release();
    expect((await response).status).toBe(200);
  });

  it('reports unavailable instead of success when either required write fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.bump.mockRejectedValueOnce(new Error('Storage down'));
    expect((await POST(request({ scope: 'user', userId }))).status).toBe(503);
    expect(mocks.invalidate).not.toHaveBeenCalled();
    mocks.invalidate.mockRejectedValueOnce(new Error('CAS contention'));
    expect((await POST(request({ scope: 'user', userId }))).status).toBe(503);
    expect(mocks.rulesInvalidate).not.toHaveBeenCalled();
  });
});
