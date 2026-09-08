import { __resetGlobalAdminSnapshotForTests } from '@/lib/services/admin/globalAdminsSnapshot';
import {
  MinimalDelegation,
  resolveLimitsAdminStatus,
} from '@/lib/services/limits/limitsAdminAuth';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  AGENT_ACCESS_ADMINS: 'admin@example.com',
}));
vi.mock('@/config/environment', () => ({ env: mockEnv }));

const DEL_OCP = 'del-0123456789ab';
const DEL_PARIS = 'del-abcdef012345';
const DEL_OFF = 'del-ffffffffffff';

function policyWith(delegations: MinimalDelegation[]) {
  return { delegations };
}

const policy = policyWith([
  { id: DEL_OCP, enabled: true, admins: ['ocp-admin@ocp.msf.org'] },
  {
    id: DEL_PARIS,
    enabled: true,
    admins: [' OCP-Admin@OCP.msf.org ', 'paris@paris.msf.org'],
  },
  { id: DEL_OFF, enabled: false, admins: ['ocp-admin@ocp.msf.org'] },
]);

const NOT_ADMIN = {
  isGlobalAdmin: false,
  isScopedAdmin: false,
  delegationIds: [],
};

describe('limits/limitsAdminAuth resolveLimitsAdminStatus', () => {
  beforeEach(() => {
    mockEnv.AGENT_ACCESS_ADMINS = 'admin@example.com';
    __resetGlobalAdminSnapshotForTests();
  });

  it('names a scoped admin with the ids of every ENABLED delegation listing them', () => {
    expect(resolveLimitsAdminStatus('ocp-admin@ocp.msf.org', policy)).toEqual({
      isGlobalAdmin: false,
      isScopedAdmin: true,
      delegationIds: [DEL_OCP, DEL_PARIS],
    });
  });

  it('a disabled delegation confers nothing', () => {
    // Only DEL_OFF names this admin — disabling a delegation must revoke the
    // rail, the page gate and the scoped write path together.
    expect(
      resolveLimitsAdminStatus(
        'only-off@ocp.msf.org',
        policyWith([
          { id: DEL_OFF, enabled: false, admins: ['only-off@ocp.msf.org'] },
        ]),
      ),
    ).toEqual(NOT_ADMIN);
  });

  it('matches admin mails canonicalized on both sides (trim + lowercase)', () => {
    expect(
      resolveLimitsAdminStatus('  PARIS@Paris.MSF.org ', policy).delegationIds,
    ).toEqual([DEL_PARIS]);
  });

  it('a real global admin is global with no delegation ids, even when a delegation names them', () => {
    expect(
      resolveLimitsAdminStatus(
        'Admin@Example.com',
        policyWith([
          { id: DEL_OCP, enabled: true, admins: ['admin@example.com'] },
        ]),
      ),
    ).toEqual({ isGlobalAdmin: true, isScopedAdmin: false, delegationIds: [] });
  });

  it('a session user without viewAs behaves exactly like the bare mail', () => {
    expect(
      resolveLimitsAdminStatus({ mail: 'ocp-admin@ocp.msf.org' }, policy),
    ).toEqual(resolveLimitsAdminStatus('ocp-admin@ocp.msf.org', policy));
    expect(
      resolveLimitsAdminStatus({ mail: 'admin@example.com' }, policy)
        .isGlobalAdmin,
    ).toBe(true);
  });

  it.each([null, undefined, ''])('is nobody for mail %j', (mail) => {
    expect(resolveLimitsAdminStatus(mail, policy)).toEqual(NOT_ADMIN);
  });

  it('is nobody with a null policy or a policy without delegations', () => {
    expect(resolveLimitsAdminStatus('ocp-admin@ocp.msf.org', null)).toEqual(
      NOT_ADMIN,
    );
    expect(resolveLimitsAdminStatus('ocp-admin@ocp.msf.org', {})).toEqual(
      NOT_ADMIN,
    );
  });

  it('a non-admin is not a scoped admin', () => {
    expect(resolveLimitsAdminStatus('user@ocp.msf.org', policy)).toEqual(
      NOT_ADMIN,
    );
  });

  describe('view-as', () => {
    it("adminRole 'none' demotes a real global admin to nobody", () => {
      expect(
        resolveLimitsAdminStatus(
          {
            mail: 'admin@example.com',
            viewAs: {
              overrides: { adminRole: 'none', limitDelegationIds: [DEL_OCP] },
            },
          },
          policy,
        ),
      ).toEqual(NOT_ADMIN);
    });

    it("adminRole 'local' grants exactly limitDelegationIds ∩ enabled delegation ids", () => {
      expect(
        resolveLimitsAdminStatus(
          {
            mail: 'admin@example.com',
            viewAs: {
              overrides: {
                adminRole: 'local',
                limitDelegationIds: [
                  DEL_OCP,
                  ` ${DEL_OCP} `,
                  DEL_OFF,
                  'del-000000000000',
                ],
              },
            },
          },
          policy,
        ),
      ).toEqual({
        isGlobalAdmin: false,
        isScopedAdmin: true,
        delegationIds: [DEL_OCP],
      });
    });

    it("adminRole 'local' without limitDelegationIds is not a scoped admin — even when a delegation names the real mail", () => {
      // "View as a regular/local admin" must not leave the real identity's
      // own delegation memberships in force.
      expect(
        resolveLimitsAdminStatus(
          {
            mail: 'admin@example.com',
            viewAs: { overrides: { adminRole: 'local' } },
          },
          policyWith([
            { id: DEL_OCP, enabled: true, admins: ['admin@example.com'] },
          ]),
        ),
      ).toEqual(NOT_ADMIN);
    });

    it('limitDelegationIds naming only disabled/unknown delegations yields nobody', () => {
      expect(
        resolveLimitsAdminStatus(
          {
            mail: 'admin@example.com',
            viewAs: {
              overrides: {
                adminRole: 'local',
                limitDelegationIds: [DEL_OFF, 'del-000000000000'],
              },
            },
          },
          policy,
        ),
      ).toEqual(NOT_ADMIN);
    });

    it('is ignored for anyone who is not a REAL global admin', () => {
      // The cookie is only ever honoured for real global admins upstream, but
      // the resolver must not trust the field on its own: a forged
      // limitDelegationIds on a non-admin grants nothing, and a scoped admin
      // carrying one keeps exactly their real memberships.
      expect(
        resolveLimitsAdminStatus(
          {
            mail: 'user@example.com',
            viewAs: {
              overrides: { adminRole: 'local', limitDelegationIds: [DEL_OCP] },
            },
          },
          policy,
        ),
      ).toEqual(NOT_ADMIN);
      expect(
        resolveLimitsAdminStatus(
          {
            mail: 'paris@paris.msf.org',
            viewAs: {
              overrides: { adminRole: 'local', limitDelegationIds: [DEL_OCP] },
            },
          },
          policy,
        ).delegationIds,
      ).toEqual([DEL_PARIS]);
    });

    it("adminRole 'global' is not a demotion", () => {
      expect(
        resolveLimitsAdminStatus(
          {
            mail: 'admin@example.com',
            viewAs: { overrides: { adminRole: 'global' } },
          },
          policy,
        ).isGlobalAdmin,
      ).toBe(true);
    });
  });
});
