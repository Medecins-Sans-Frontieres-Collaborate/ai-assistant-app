import { resolveDelegatedAdminStatus } from '@/lib/services/delegations/delegationsAdminAuth';
import {
  SharedDelegation,
  adminHoldsGrant,
  delegationsBlobPaths,
  effectiveGrants,
  fromLegacyLimitDelegations,
  toLimitDelegations,
} from '@/lib/services/delegations/types';
import { LimitDelegation } from '@/lib/services/limits/types';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/config/environment', () => ({
  env: { AGENT_ACCESS_ADMINS: 'global@example.com' },
}));

const STAMP = {
  createdBy: 'g@example.com',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedBy: 'g@example.com',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function delegation(extra: Partial<SharedDelegation> = {}): SharedDelegation {
  return {
    id: 'del-0000000000aa',
    label: 'OCP',
    enabled: true,
    jurisdiction: [{ scope: 'domain', targets: ['ocp.msf.org'] }],
    capabilities: ['limits', 'announcements'],
    admins: [],
    limits: { maxOverrides: 25 },
    ...STAMP,
    ...extra,
  };
}

describe('grants', () => {
  it("'all' means every capability THIS delegation enables — not every grant the app knows", () => {
    const limitsOnly = delegation({ capabilities: ['limits'] });
    expect(
      effectiveGrants(limitsOnly, { mail: 'a@x.org', grants: 'all' }),
    ).toEqual(['limits']);
  });

  it('a picked grant the delegation does not offer confers nothing', () => {
    const limitsOnly = delegation({ capabilities: ['limits'] });
    expect(
      effectiveGrants(limitsOnly, {
        mail: 'a@x.org',
        grants: ['announcements'],
      }),
    ).toEqual([]);
  });

  it('a disabled delegation confers nothing', () => {
    expect(
      effectiveGrants(delegation({ enabled: false }), {
        mail: 'a@x.org',
        grants: 'all',
      }),
    ).toEqual([]);
  });

  it('matches the admin mail case-insensitively', () => {
    const d = delegation({
      admins: [{ mail: 'Sender@OCP.msf.org', grants: ['announcements'] }],
    });
    expect(adminHoldsGrant(d, ' sender@ocp.msf.org ', 'announcements')).toBe(
      true,
    );
    expect(adminHoldsGrant(d, 'sender@ocp.msf.org', 'limits')).toBe(false);
    expect(adminHoldsGrant(d, null, 'announcements')).toBe(false);
  });
});

describe('toLimitDelegations — the limits feature’s view', () => {
  it('keeps only delegations offering limits, and only the admins holding it', () => {
    const projected = toLimitDelegations({
      version: 1,
      delegations: [
        delegation({
          admins: [
            { mail: 'both@ocp.msf.org', grants: 'all' },
            { mail: 'limits@ocp.msf.org', grants: ['limits'] },
            { mail: 'sender@ocp.msf.org', grants: ['announcements'] },
          ],
          limits: { maxOverrides: 40 },
        }),
        delegation({
          id: 'del-0000000000bb',
          capabilities: ['announcements'],
          admins: [{ mail: 'x@ocp.msf.org', grants: 'all' }],
        }),
      ],
      updatedBy: 'g',
      updatedAt: 'now',
    });
    expect(projected).toHaveLength(1);
    expect(projected[0].admins).toEqual([
      'both@ocp.msf.org',
      'limits@ocp.msf.org',
    ]);
    expect(projected[0].maxOverrides).toBe(40);
  });

  it('carries a DISABLED delegation through, so its overrides stay scoped-and-inert rather than orphaned', () => {
    const projected = toLimitDelegations({
      version: 1,
      delegations: [delegation({ enabled: false })],
      updatedBy: 'g',
      updatedAt: 'now',
    });
    expect(projected[0].enabled).toBe(false);
  });

  it('is empty for a missing document', () => {
    expect(toLimitDelegations(null)).toEqual([]);
  });
});

describe('fromLegacyLimitDelegations — the one-time migration mapping', () => {
  const legacy: LimitDelegation = {
    id: 'del-0000000000aa',
    label: 'OCP',
    enabled: true,
    admins: ['Admin@OCP.msf.org', 'admin@ocp.msf.org', 'second@ocp.msf.org'],
    jurisdiction: [{ scope: 'domain', targets: ['ocp.msf.org'] }],
    maxOverrides: 40,
    ...STAMP,
  };

  it('keeps the id, grants every current capability and gives each admin FULL permissions', () => {
    const document = fromLegacyLimitDelegations([legacy], 'system', 'now');
    expect(document.migratedFromLimitsAt).toBe('now');
    expect(document.delegations[0]).toMatchObject({
      id: legacy.id,
      capabilities: ['limits', 'announcements'],
      limits: { maxOverrides: 40 },
      createdBy: STAMP.createdBy,
    });
    expect(document.delegations[0].admins).toEqual([
      { mail: 'admin@ocp.msf.org', grants: 'all' },
      { mail: 'second@ocp.msf.org', grants: 'all' },
    ]);
  });

  it('round-trips through the limits projection unchanged', () => {
    const document = fromLegacyLimitDelegations([legacy], 'system', 'now');
    expect(toLimitDelegations(document)[0]).toMatchObject({
      id: legacy.id,
      admins: ['admin@ocp.msf.org', 'second@ocp.msf.org'],
      maxOverrides: 40,
      jurisdiction: legacy.jurisdiction,
    });
  });
});

describe('delegationsBlobPaths', () => {
  it('suffixes beta like the limits policy (beta and prod share the container)', () => {
    expect(delegationsBlobPaths(null).documentPath).toBe(
      'system/admin/delegations.json',
    );
    expect(delegationsBlobPaths('beta').documentPath).toBe(
      'system/admin/delegations.beta.json',
    );
  });
});

describe('resolveDelegatedAdminStatus', () => {
  const delegations = [
    delegation({
      admins: [{ mail: 'sender@ocp.msf.org', grants: ['announcements'] }],
    }),
    delegation({
      id: 'del-0000000000bb',
      enabled: false,
      admins: [{ mail: 'sender@ocp.msf.org', grants: 'all' }],
    }),
    delegation({
      id: 'del-0000000000cc',
      capabilities: ['limits'],
      admins: [{ mail: 'sender@ocp.msf.org', grants: 'all' }],
    }),
  ];

  it('names only ENABLED delegations that OFFER the grant and where the person HOLDS it', () => {
    expect(
      resolveDelegatedAdminStatus(
        { mail: 'sender@ocp.msf.org' },
        delegations,
        'announcements',
      ),
    ).toEqual({
      isGlobalAdmin: false,
      isDelegatedAdmin: true,
      delegationIds: ['del-0000000000aa'],
    });
  });

  it('a global admin is global, not delegated', () => {
    expect(
      resolveDelegatedAdminStatus(
        { mail: 'global@example.com' },
        delegations,
        'announcements',
      ),
    ).toEqual({
      isGlobalAdmin: true,
      isDelegatedAdmin: false,
      delegationIds: [],
    });
  });

  it('view-as: a demoted global admin holds exactly the named delegations that offer the grant', () => {
    const status = resolveDelegatedAdminStatus(
      {
        mail: 'global@example.com',
        viewAs: {
          overrides: {
            adminRole: 'local',
            limitDelegationIds: ['del-0000000000aa', 'del-0000000000cc'],
          },
        },
      } as never,
      delegations,
      'announcements',
    );
    expect(status).toEqual({
      isGlobalAdmin: false,
      isDelegatedAdmin: true,
      delegationIds: ['del-0000000000aa'],
    });
    expect(
      resolveDelegatedAdminStatus(
        {
          mail: 'global@example.com',
          viewAs: { overrides: { adminRole: 'none' } },
        } as never,
        delegations,
        'announcements',
      ).isDelegatedAdmin,
    ).toBe(false);
  });

  it('nobody is a delegated admin without delegations (outage = fail closed)', () => {
    expect(
      resolveDelegatedAdminStatus(
        { mail: 'sender@ocp.msf.org' },
        null,
        'announcements',
      ).isDelegatedAdmin,
    ).toBe(false);
  });
});
