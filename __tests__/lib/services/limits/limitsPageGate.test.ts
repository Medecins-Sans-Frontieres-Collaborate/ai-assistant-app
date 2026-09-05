/**
 * `resolveLimitsPageAccess` — the /admin/limits page gate
 * (lib/services/limits/limitsPageGate.ts, design §6d).
 *
 * Contract: the LimitsService snapshot decides for global admins and for
 * scoped admins it already knows; on a MISS (neither role, policy not in
 * outage, caller has a mail) the gate does ONE direct `readPolicy` and
 * re-decides against storage, so a delegation authored seconds ago on
 * another replica does not bounce its new admin for the 60 s TTL. A failed
 * direct read, a cold-start outage, or a mail-less caller keeps the snapshot's
 * fail-closed "not an admin".
 */
import { resolveLimitsPageAccess } from '@/lib/services/limits/limitsPageGate';
import { readPolicy } from '@/lib/services/limits/limitsStore';
import { LimitsPolicy, LimitsPolicySchema } from '@/lib/services/limits/types';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  AGENT_ACCESS_ADMINS: 'global@example.com',
}));
const snapshot = vi.hoisted(() => ({
  policy: null as unknown,
  policyUnavailable: false,
}));
const ensureFresh = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/config/environment', () => ({ env: mockEnv }));
vi.mock('@/lib/services/limits/LimitsService', () => ({
  LimitsService: {
    getInstance: () => ({
      ensureFresh,
      getSnapshot: () => ({ ...snapshot, etag: null, fetchedAt: 1 }),
    }),
  },
}));
vi.mock('@/lib/services/limits/limitsStore', () => ({
  createLimitsBlobStorage: vi.fn(() => ({})),
  readPolicy: vi.fn(),
}));

const DEL = 'del-0000000000aa';
const OCP_ADMIN = 'ocp.admin@ocp.msf.org';

function policyWith(admins: string[], enabled = true): LimitsPolicy {
  return LimitsPolicySchema.parse({
    version: 1,
    delegations: [
      {
        id: DEL,
        label: 'OCP',
        enabled,
        admins,
        jurisdiction: [{ scope: 'domain', targets: ['ocp.msf.org'] }],
        maxOverrides: 25,
        createdBy: 'global@example.com',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedBy: 'global@example.com',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    updatedBy: 'global@example.com',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
}

const user = (mail?: string) => ({ id: 'oid', displayName: 'X', mail });

describe('resolveLimitsPageAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockEnv.AGENT_ACCESS_ADMINS = 'global@example.com';
    snapshot.policy = policyWith([]);
    snapshot.policyUnavailable = false;
    vi.mocked(readPolicy).mockResolvedValue({
      policy: policyWith([OCP_ADMIN]),
      etag: '"e1"',
    });
  });

  it('admits a freshly delegated scoped admin the warm snapshot does not know yet, via ONE direct read', async () => {
    const status = await resolveLimitsPageAccess(user(OCP_ADMIN));
    expect(status).toEqual({
      isGlobalAdmin: false,
      isScopedAdmin: true,
      delegationIds: [DEL],
    });
    expect(ensureFresh).toHaveBeenCalledTimes(1);
    expect(readPolicy).toHaveBeenCalledTimes(1);
  });

  it('answers a global admin from the snapshot without touching storage', async () => {
    const status = await resolveLimitsPageAccess(user('global@example.com'));
    expect(status.isGlobalAdmin).toBe(true);
    expect(readPolicy).not.toHaveBeenCalled();
  });

  it('answers a scoped admin the snapshot already knows without touching storage', async () => {
    snapshot.policy = policyWith([OCP_ADMIN]);
    const status = await resolveLimitsPageAccess(user(OCP_ADMIN));
    expect(status.isScopedAdmin).toBe(true);
    expect(readPolicy).not.toHaveBeenCalled();
  });

  it('bounces a caller storage does not name either (fail closed after the direct read)', async () => {
    const status = await resolveLimitsPageAccess(user('nobody@ocp.msf.org'));
    expect(status.isScopedAdmin).toBe(false);
    expect(status.isGlobalAdmin).toBe(false);
    expect(readPolicy).toHaveBeenCalledTimes(1);
  });

  it('keeps the fail-closed answer when the direct read fails, and logs it', async () => {
    vi.mocked(readPolicy).mockRejectedValue(new Error('blob down'));
    const status = await resolveLimitsPageAccess(user(OCP_ADMIN));
    expect(status.isScopedAdmin).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('direct policy read failed'),
    );
  });

  it('does not consult storage during a cold-start outage (policyUnavailable) — that is an outage, not a stale snapshot', async () => {
    snapshot.policy = null;
    snapshot.policyUnavailable = true;
    const status = await resolveLimitsPageAccess(user(OCP_ADMIN));
    expect(status.isScopedAdmin).toBe(false);
    expect(readPolicy).not.toHaveBeenCalled();
  });

  it('does not consult storage for a caller with no mail (never a scoped admin)', async () => {
    const status = await resolveLimitsPageAccess(user(undefined));
    expect(status.isScopedAdmin).toBe(false);
    expect(readPolicy).not.toHaveBeenCalled();
  });

  it('a disabled delegation in storage still bounces', async () => {
    vi.mocked(readPolicy).mockResolvedValue({
      policy: policyWith([OCP_ADMIN], false),
      etag: '"e1"',
    });
    expect((await resolveLimitsPageAccess(user(OCP_ADMIN))).isScopedAdmin).toBe(
      false,
    );
  });

  it('treats a missing stored document as "no delegations" (bounce), not an error', async () => {
    vi.mocked(readPolicy).mockResolvedValue(null);
    const status = await resolveLimitsPageAccess(user(OCP_ADMIN));
    expect(status.isScopedAdmin).toBe(false);
    expect(console.error).not.toHaveBeenCalled();
  });
});
