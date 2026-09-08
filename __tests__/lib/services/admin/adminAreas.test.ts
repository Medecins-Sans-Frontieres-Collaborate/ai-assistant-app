import { resolveAdminAreas } from '@/lib/services/admin/adminAreas';
import { __resetGlobalAdminSnapshotForTests } from '@/lib/services/admin/globalAdminsSnapshot';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  AGENT_ACCESS_CONTROL_ENABLED: true,
  AGENT_ACCESS_ADMINS: 'admin@example.com',
}));
vi.mock('@/config/environment', () => ({ env: mockEnv }));
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: {
    getInstance: () => ({
      ensureFresh: vi.fn(),
      getSnapshot: () => ({
        config: {
          version: 1,
          localAdmins: [{ email: 'local@example.com', agentKeys: [] }],
          updatedBy: 'x',
          updatedAt: 'y',
        },
      }),
    }),
  },
}));

// The real LimitsService / GlobalAdminRosterService would call
// createAdminBlobStorage() on first use; mutable snapshots let each case
// describe the storage state it wants (authored / never authored / outage).
const DEL_OCP = 'del-0123456789ab';
const DEL_OFF = 'del-ffffffffffff';
const limitsSnapshot = vi.hoisted(() => ({
  policy: null as {
    delegations: Array<{ id: string; enabled: boolean; admins: string[] }>;
  } | null,
  etag: null as string | null,
  policyUnavailable: false,
  fetchedAt: 1,
}));
const limitsEnsureFresh = vi.hoisted(() => vi.fn());
vi.mock('@/lib/services/limits/LimitsService', () => ({
  LimitsService: {
    getInstance: () => ({
      ensureFresh: limitsEnsureFresh,
      getSnapshot: () => limitsSnapshot,
    }),
  },
}));
const rosterSnapshot = vi.hoisted(() => ({
  roster: null,
  etag: null,
  rosterUnavailable: false,
  fetchedAt: 1,
}));
const rosterEnsureFresh = vi.hoisted(() => vi.fn());
vi.mock('@/lib/services/admin/GlobalAdminRosterService', () => ({
  GlobalAdminRosterService: {
    getInstance: () => ({
      ensureFresh: rosterEnsureFresh,
      getSnapshot: () => rosterSnapshot,
    }),
  },
}));

const policyWithDelegations = {
  delegations: [
    { id: DEL_OCP, enabled: true, admins: ['ocp-admin@ocp.msf.org'] },
    { id: DEL_OFF, enabled: false, admins: ['only-off@ocp.msf.org'] },
  ],
};

describe('resolveAdminAreas', () => {
  beforeEach(() => {
    mockEnv.AGENT_ACCESS_CONTROL_ENABLED = true;
    limitsSnapshot.policy = null;
    limitsSnapshot.policyUnavailable = false;
    rosterSnapshot.rosterUnavailable = false;
    limitsEnsureFresh.mockClear();
    rosterEnsureFresh.mockClear();
    __resetGlobalAdminSnapshotForTests();
  });

  it('gives a global admin workflows + view-as, a local admin neither', async () => {
    const globalAreas = (await resolveAdminAreas({ mail: 'admin@example.com' }))
      .areas;
    expect(globalAreas).toContain('workflows');
    expect(globalAreas).toContain('view-as');
    expect(globalAreas).toContain('limits');

    const localAreas = (await resolveAdminAreas({ mail: 'local@example.com' }))
      .areas;
    expect(localAreas).toContain('agents');
    expect(localAreas).not.toContain('workflows');
    expect(localAreas).not.toContain('view-as');
  });

  it('keeps ONLY view-as for a global admin viewing as a regular user', async () => {
    const { areas } = await resolveAdminAreas({
      mail: 'admin@example.com',
      viewAs: { overrides: { adminRole: 'none' } },
    });
    expect(areas).toEqual(['view-as']);
  });

  it('a global admin viewing as a local admin sees the local areas plus view-as', async () => {
    const { areas } = await resolveAdminAreas({
      mail: 'admin@example.com',
      viewAs: { overrides: { adminRole: 'local', localAdminKeys: [] } },
    });
    expect(areas).toContain('agents');
    expect(areas).not.toContain('limits');
    expect(areas).not.toContain('local-admins');
    expect(areas).not.toContain('global-admins');
    expect(areas).toContain('view-as');
  });

  it('never offers view-as to a non-admin', async () => {
    const { areas } = await resolveAdminAreas({ mail: 'u@example.com' });
    expect(areas).toEqual([]);
  });

  describe('global-admins area', () => {
    it('is offered to a global admin even when agent access is disabled', async () => {
      // The roster is its own configuration; it must not vanish with the
      // agent-access kill switch the way local-admins does.
      mockEnv.AGENT_ACCESS_CONTROL_ENABLED = false;
      const { areas } = await resolveAdminAreas({ mail: 'admin@example.com' });
      expect(areas).toContain('global-admins');
      expect(areas).not.toContain('local-admins');
    });

    it('is withheld from local admins and non-admins', async () => {
      expect(
        (await resolveAdminAreas({ mail: 'local@example.com' })).areas,
      ).not.toContain('global-admins');
      expect(
        (await resolveAdminAreas({ mail: 'u@example.com' })).areas,
      ).not.toContain('global-admins');
    });

    it('warms the roster and reports an unreadable roster as configUnavailable', async () => {
      rosterSnapshot.rosterUnavailable = true;
      const resolution = await resolveAdminAreas({ mail: 'u@example.com' });
      expect(rosterEnsureFresh).toHaveBeenCalled();
      // A config-roster admin on a cold replica resolves to zero areas; the
      // UI must be able to say "storage is down", not "you were revoked".
      expect(resolution.configUnavailable).toBe(true);
      expect(resolution.areas).toEqual([]);
    });
  });

  describe('scoped limits admins (design §6d)', () => {
    it('gives a scoped admin exactly the limits area, read from the policy', async () => {
      limitsSnapshot.policy = policyWithDelegations;
      const resolution = await resolveAdminAreas({
        mail: 'ocp-admin@ocp.msf.org',
      });
      expect(limitsEnsureFresh).toHaveBeenCalled();
      expect(resolution.areas).toEqual(['limits']);
      expect(resolution.limitsStatus).toEqual({
        isGlobalAdmin: false,
        isScopedAdmin: true,
        delegationIds: [DEL_OCP],
      });
      // Never expressed through the agent-access model.
      expect(resolution.status.isLocalAdmin).toBe(false);
      expect(resolution.configUnavailable).toBe(false);
    });

    it('a disabled delegation grants no area', async () => {
      limitsSnapshot.policy = policyWithDelegations;
      const { areas } = await resolveAdminAreas({
        mail: 'only-off@ocp.msf.org',
      });
      expect(areas).toEqual([]);
    });

    it('"no policy authored" is not an outage', async () => {
      limitsSnapshot.policy = null;
      limitsSnapshot.policyUnavailable = false;
      const resolution = await resolveAdminAreas({
        mail: 'ocp-admin@ocp.msf.org',
      });
      expect(resolution.configUnavailable).toBe(false);
      expect(resolution.areas).toEqual([]);
    });

    it('a policy outage reports configUnavailable and fails the scoped admin closed', async () => {
      limitsSnapshot.policy = null;
      limitsSnapshot.policyUnavailable = true;
      const scoped = await resolveAdminAreas({ mail: 'ocp-admin@ocp.msf.org' });
      expect(scoped.configUnavailable).toBe(true);
      expect(scoped.areas).toEqual([]);

      // A global admin's answer needs no policy, so they still pass.
      const global = await resolveAdminAreas({ mail: 'admin@example.com' });
      expect(global.configUnavailable).toBe(true);
      expect(global.areas).toContain('limits');
    });

    it('a demoted global admin with limitDelegationIds sees limits as that scoped admin', async () => {
      limitsSnapshot.policy = policyWithDelegations;
      const { areas, limitsStatus } = await resolveAdminAreas({
        mail: 'admin@example.com',
        viewAs: {
          overrides: {
            adminRole: 'local',
            localAdminKeys: [],
            limitDelegationIds: [DEL_OCP, DEL_OFF, 'del-000000000000'],
          },
        },
      });
      expect(areas).toContain('limits');
      expect(areas).not.toContain('local-admins');
      expect(areas).not.toContain('global-admins');
      expect(areas).not.toContain('workflows');
      // Only ENABLED, existing delegations survive the intersection.
      expect(limitsStatus.delegationIds).toEqual([DEL_OCP]);
    });

    it('a demoted global admin listing only disabled/unknown delegations gets no limits', async () => {
      limitsSnapshot.policy = policyWithDelegations;
      const { areas } = await resolveAdminAreas({
        mail: 'admin@example.com',
        viewAs: {
          overrides: {
            adminRole: 'local',
            limitDelegationIds: [DEL_OFF, 'del-000000000000'],
          },
        },
      });
      expect(areas).not.toContain('limits');
    });
  });
});
