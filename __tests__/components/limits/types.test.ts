import { toPolicyPutDelegation } from '@/client/hooks/settings/useLimitsAdmin';

import { LimitOverride } from '@/lib/services/limits/types';

import {
  emptyDelegation,
  emptyOverride,
  newDelegationId,
  scopedOverrideBody,
} from '@/components/Limits/types';

import { describe, expect, it } from 'vitest';

describe('scopedOverrideBody', () => {
  /**
   * Design §5: the scoped PUT body is strict and carries no delegationId,
   * priority, ceiling or audit fields — a body with any of them is a 400.
   */
  it('strips delegationId, priority, ceiling flags and audit fields', () => {
    const override: LimitOverride = {
      id: 'lim-0123456789ab',
      label: 'OCP',
      enabled: true,
      scope: 'user',
      targets: [' a@ocp.msf.org ', '', 'b@ocp.msf.org'],
      priority: 7,
      delegationId: 'del-0123456789ab',
      entries: [
        { limitKey: 'chat.messagesPerDay', value: 100, ceiling: true },
        {
          limitKey: 'model.requests',
          modelId: 'gpt-5.2',
          value: 10,
          ceiling: false,
        },
      ],
      createdBy: 'x@y.org',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedBy: 'x@y.org',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const body = scopedOverrideBody(override);
    expect(body).toEqual({
      id: 'lim-0123456789ab',
      label: 'OCP',
      enabled: true,
      scope: 'user',
      targets: ['a@ocp.msf.org', 'b@ocp.msf.org'],
      entries: [
        { limitKey: 'chat.messagesPerDay', value: 100 },
        { limitKey: 'model.requests', modelId: 'gpt-5.2', value: 10 },
      ],
    });
    expect(body).not.toHaveProperty('delegationId');
    expect(body).not.toHaveProperty('priority');
    for (const entry of body.entries)
      expect(entry).not.toHaveProperty('ceiling');
  });
});

describe('emptyOverride / emptyDelegation', () => {
  it('stamps delegationId only when given and keeps priority 0', () => {
    expect(emptyOverride('user')).not.toHaveProperty('delegationId');
    const scoped = emptyOverride('domain', 'del-0123456789ab');
    expect(scoped.delegationId).toBe('del-0123456789ab');
    expect(scoped.priority).toBe(0);
    expect(scoped.entries).toEqual([]);
  });

  it('a new delegation opens on one empty domain predicate with the default budget', () => {
    const d = emptyDelegation();
    expect(d.id).toMatch(/^del-[0-9a-f]{12}$/);
    expect(d.jurisdiction).toEqual([{ scope: 'domain', targets: [] }]);
    expect(d.maxOverrides).toBe(25);
    expect(d.enabled).toBe(true);
    expect(newDelegationId()).toMatch(/^del-[0-9a-f]{12}$/);
  });
});

describe('toPolicyPutDelegation', () => {
  it('omits the id for a NEW delegation and keeps it for a stored one', () => {
    const d = emptyDelegation();
    expect(toPolicyPutDelegation(d, true)).not.toHaveProperty('id');
    expect(toPolicyPutDelegation(d, false).id).toBe(d.id);
  });

  it('lowercases/dedupes admins, drops empty predicates and never sends audit fields', () => {
    const d = {
      ...emptyDelegation(),
      admins: [
        ' Alice@OCP.msf.org',
        'alice@ocp.msf.org',
        '',
        'bob@ocp.msf.org',
      ],
      jurisdiction: [
        { scope: 'domain' as const, targets: [] },
        { scope: 'user' as const, targets: [' carol@ocp.msf.org ', ' '] },
      ],
      maxOverrides: 10,
    };
    expect(toPolicyPutDelegation(d, false)).toEqual({
      id: d.id,
      label: '',
      enabled: true,
      admins: ['alice@ocp.msf.org', 'bob@ocp.msf.org'],
      jurisdiction: [{ scope: 'user', targets: ['carol@ocp.msf.org'] }],
      maxOverrides: 10,
    });
  });
});
