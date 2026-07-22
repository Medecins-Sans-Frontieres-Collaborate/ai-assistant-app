import { createMockSession, parseJsonResponse } from './helpers';

import { GET } from '@/app/api/mcp/vault-key/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const mockEnv = vi.hoisted(() => ({
  AUTH_SECRET: undefined as string | undefined,
  NEXTAUTH_SECRET: undefined as string | undefined,
}));

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/config/environment', () => ({ env: mockEnv }));

describe('GET /api/mcp/vault-key', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.AUTH_SECRET = 'server-secret-for-tests';
    mockEnv.NEXTAUTH_SECRET = undefined;
    mockAuth.mockResolvedValue(createMockSession());
  });

  it('returns 401 without a session', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns 503 when no server secret is configured', async () => {
    mockEnv.AUTH_SECRET = undefined;
    const res = await GET();
    const json = await parseJsonResponse(res);

    expect(res.status).toBe(503);
    expect(json.code).toBe('VAULT_UNCONFIGURED');
  });

  it('returns stable 32-byte material for the same user', async () => {
    const first = await parseJsonResponse(await GET());
    const second = await parseJsonResponse(await GET());

    expect(first.data.keyMaterial).toBe(second.data.keyMaterial);
    expect(
      Buffer.from(first.data.keyMaterial as string, 'base64'),
    ).toHaveLength(32);
    // Derived material, never the raw server secret.
    expect(first.data.keyMaterial).not.toContain('server-secret-for-tests');
  });

  it('returns different material for different users', async () => {
    const a = await parseJsonResponse(await GET());
    mockAuth.mockResolvedValue({
      user: { id: 'someone-else', mail: 'other@example.org' },
    });
    const b = await parseJsonResponse(await GET());

    expect(a.data.keyMaterial).not.toBe(b.data.keyMaterial);
  });
});
