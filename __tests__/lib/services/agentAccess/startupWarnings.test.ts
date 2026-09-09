import { buildAccessControlWarnings } from '@/lib/services/agentAccess/startupWarnings';

import { describe, expect, it } from 'vitest';

describe('buildAccessControlWarnings', () => {
  it('says nothing when the feature is off and no admins are configured', () => {
    expect(
      buildAccessControlWarnings({
        enabled: false,
        globalAdminCount: 0,
        localAdminCount: null,
      }),
    ).toEqual([]);
  });

  it('says nothing for a fully configured deployment', () => {
    expect(
      buildAccessControlWarnings({
        enabled: true,
        globalAdminCount: 2,
        localAdminCount: null,
      }),
    ).toEqual([]);
  });

  it('warns when admins are configured but the feature is off', () => {
    // The trap this whole module exists for: the operator did the visible
    // half of the setup and saw nothing happen.
    const [warning] = buildAccessControlWarnings({
      enabled: false,
      globalAdminCount: 3,
      localAdminCount: null,
    });

    expect(warning).toContain('3 admin(s)');
    expect(warning).toContain('AGENT_ACCESS_CONTROL_ENABLED=true');
  });

  it('warns when enforcing with no global and no local admins', () => {
    const [warning] = buildAccessControlWarnings({
      enabled: true,
      globalAdminCount: 0,
      localAdminCount: 0,
    });

    expect(warning).toContain('nobody can create or change them');
    expect(warning).toContain('AGENT_ACCESS_ADMINS');
  });

  it('stays quiet when local admins cover an empty global roster', () => {
    // Zero global admins with a populated delegation map is a legitimate,
    // supported state — warning about it would train operators to ignore
    // these messages.
    expect(
      buildAccessControlWarnings({
        enabled: true,
        globalAdminCount: 0,
        localAdminCount: 2,
      }),
    ).toEqual([]);
  });

  it('hedges rather than asserting an empty roster it could not read', () => {
    // A transient storage outage must not produce a false "nobody can author
    // rules" alarm.
    const [warning] = buildAccessControlWarnings({
      enabled: true,
      globalAdminCount: 0,
      localAdminCount: null,
    });

    expect(warning).toContain('could not be read');
    expect(warning).not.toContain('nobody can create or change them');
  });

  it('hedges when the config global-admin roster could not be read', () => {
    // Global admins = env ∪ config roster. An unreadable roster is an unknown,
    // not a zero: a storage outage must not produce a false "nobody can
    // author" alarm — and it takes precedence over the local-admin count,
    // which cannot settle the question either way.
    for (const localAdminCount of [0, 2, null]) {
      const warnings = buildAccessControlWarnings({
        enabled: true,
        globalAdminCount: 0,
        localAdminCount,
        globalRosterUnreadable: true,
      });

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('global-admin roster');
      expect(warnings[0]).toContain('could not be read');
      expect(warnings[0]).not.toContain('nobody can create or change them');
    }
  });

  it('counts config-roster admins as global admins (no warning when only the roster is populated)', () => {
    expect(
      buildAccessControlWarnings({
        enabled: true,
        globalAdminCount: 1,
        localAdminCount: 0,
        globalRosterUnreadable: false,
      }),
    ).toEqual([]);
  });

  it('never emits both warnings at once (they are mutually exclusive)', () => {
    for (const enabled of [true, false]) {
      for (const globalAdminCount of [0, 1]) {
        for (const localAdminCount of [0, 1, null]) {
          for (const globalRosterUnreadable of [true, false, undefined]) {
            expect(
              buildAccessControlWarnings({
                enabled,
                globalAdminCount,
                localAdminCount,
                globalRosterUnreadable,
              }).length,
            ).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });
});
