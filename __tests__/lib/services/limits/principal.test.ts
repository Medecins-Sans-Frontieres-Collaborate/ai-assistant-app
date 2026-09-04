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
import { buildPrincipal } from '@/lib/services/limits/principal';
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

  it('still builds a principal (the import is the wiring, nothing else moved)', () => {
    expect(buildPrincipal(null).userId).toBe('');
  });
});
