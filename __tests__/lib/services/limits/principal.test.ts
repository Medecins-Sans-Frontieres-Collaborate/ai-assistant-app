/**
 * principal.ts is the server-only seam that registers the resolver's §8
 * audit hook (docs/LIMITS_SCOPED_ADMINS_DESIGN.md): importing it must wire a
 * `setJurisdictionUnevaluableHook` that consults
 * `isGroupMembershipDegradedForUser` and writes the
 * `[limits-audit] jurisdiction-unevaluable` line, or the line stays dormant
 * forever and a group-only jurisdiction that silently fails open leaves no
 * trace. The resolver itself never logs, so the sanitization of the two
 * interpolated values (CWE-117) is this module's job and is pinned here.
 */
// Importing the module is the act under test: its side effect is the wiring.
import {
  __jurisdictionAuditSizeForTests,
  __resetJurisdictionAuditForTests,
  buildPrincipal,
} from '@/lib/services/limits/principal';
import { activeDelegationIds } from '@/lib/services/limits/resolver';
import type { LimitsPolicy } from '@/lib/services/limits/types';
import type { Principal } from '@/lib/services/shared/principalMatching';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const degradedMock = vi.hoisted(() => vi.fn<(userId: string) => boolean>());

vi.mock('@/lib/services/m365/groupMembership', () => ({
  getCachedGroupIdsForUser: vi.fn(() => []),
  isGroupMembershipDegradedForUser: degradedMock,
}));

const groupOnlyPolicy = {
  delegations: [
    {
      id: 'del-0123456789ab',
      label: 'OCP',
      enabled: true,
      admins: ['ocp-admin@ocp.msf.org'],
      jurisdiction: [{ scope: 'group', targets: ['grp-1'] }],
      maxOverrides: 25,
      createdBy: 'a',
      createdAt: 'b',
      updatedBy: 'a',
      updatedAt: 'b',
    },
  ],
} as unknown as LimitsPolicy;

const principal: Principal = {
  userId: 'oid-1',
  mail: 'alice@ocp.msf.org',
  domain: 'ocp.msf.org',
  attributes: [],
  groupIds: [],
};

describe('principal.ts registers the jurisdiction-degraded audit check', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    degradedMock.mockReset();
    __resetJurisdictionAuditForTests();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('emits the audit line when membership is degraded for the user', () => {
    degradedMock.mockReturnValue(true);
    expect(activeDelegationIds(groupOnlyPolicy, principal).size).toBe(0);
    expect(degradedMock).toHaveBeenCalledWith('oid-1');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[limits-audit] jurisdiction-unevaluable'),
    );
  });

  it('stays silent when membership is merely cold (not degraded)', () => {
    degradedMock.mockReturnValue(false);
    expect(activeDelegationIds(groupOnlyPolicy, principal).size).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('sanitizes both interpolated values so a hostile oid cannot forge a log line', () => {
    degradedMock.mockReturnValue(true);
    activeDelegationIds(groupOnlyPolicy, {
      ...principal,
      userId: 'oid-1\r\n[limits-audit] forged=1',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0][0] as string;
    expect(line).not.toMatch(/[\r\n]/);
    expect(line).toContain('user=oid-1 [limits-audit] forged=1');
    expect(line).toContain('delegation=del-0123456789ab');
  });

  it('writes one line per (delegation, user) per window, not one per cell', () => {
    // enforcement.ts and /api/models call resolveLimit once per key or per
    // model; without suppression a degraded user would produce dozens of
    // identical audit lines per request.
    degradedMock.mockReturnValue(true);
    activeDelegationIds(groupOnlyPolicy, principal);
    activeDelegationIds(groupOnlyPolicy, principal);
    activeDelegationIds(groupOnlyPolicy, principal);
    expect(warn).toHaveBeenCalledTimes(1);

    // A different user is a different signal.
    activeDelegationIds(groupOnlyPolicy, { ...principal, userId: 'oid-2' });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('logs again once the suppression window has passed', () => {
    degradedMock.mockReturnValue(true);
    vi.useFakeTimers();
    try {
      activeDelegationIds(groupOnlyPolicy, principal);
      vi.advanceTimersByTime(60_001);
      activeDelegationIds(groupOnlyPolicy, principal);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the suppression map bounded, sweeping expired pairs first', () => {
    // A long-lived replica sees every (delegation, user) pair that ever hit a
    // degraded lookup; without a bound the map only ever grows.
    degradedMock.mockReturnValue(true);
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 2000; i++) {
        activeDelegationIds(groupOnlyPolicy, {
          ...principal,
          userId: `u-${i}`,
        });
      }
      expect(__jurisdictionAuditSizeForTests()).toBe(2000);

      // Past the window every entry is dead: the sweep clears them all and
      // the new pair is the only live one.
      vi.advanceTimersByTime(60_001);
      activeDelegationIds(groupOnlyPolicy, { ...principal, userId: 'u-new' });
      expect(__jurisdictionAuditSizeForTests()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('evicts the oldest live pair when a burst overflows inside one window', () => {
    degradedMock.mockReturnValue(true);
    for (let i = 0; i < 2001; i++) {
      activeDelegationIds(groupOnlyPolicy, { ...principal, userId: `u-${i}` });
    }
    expect(__jurisdictionAuditSizeForTests()).toBe(2000);
    expect(warn).toHaveBeenCalledTimes(2001);

    // u-0 was evicted so it audits again (the accepted cost of the bound);
    // a pair still inside the map stays suppressed.
    activeDelegationIds(groupOnlyPolicy, { ...principal, userId: 'u-0' });
    expect(warn).toHaveBeenCalledTimes(2002);
    activeDelegationIds(groupOnlyPolicy, { ...principal, userId: 'u-1000' });
    expect(warn).toHaveBeenCalledTimes(2002);
  });

  it('still builds a principal (the import is the wiring, nothing else moved)', () => {
    expect(buildPrincipal(null).userId).toBe('');
  });
});
