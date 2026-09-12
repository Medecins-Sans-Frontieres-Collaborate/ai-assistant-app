import { LimitsPolicySchema } from '@/lib/services/limits/types';

import { describe, expect, it } from 'vitest';

/**
 * Rolling-deploy rule (robustness review 2026-09-12, LOW): `writePolicy`
 * re-parses the document with the READ schemas, so a field only a newer
 * replica knows must survive an older replica's parse-and-write.
 */
describe('read schemas keep unknown fields', () => {
  it('a policy, override and delegation carry unknown keys through a parse', () => {
    const stored = {
      version: 1,
      defaults: [],
      overrides: [
        {
          id: 'lim-000000000001',
          scope: 'user',
          targets: ['a@x.org'],
          entries: [],
          createdBy: 'x',
          createdAt: 'x',
          updatedBy: 'x',
          updatedAt: 'x',
          futureOverrideField: 'kept',
        },
      ],
      delegations: [
        {
          id: 'del-000000000001',
          createdBy: 'x',
          createdAt: 'x',
          updatedBy: 'x',
          updatedAt: 'x',
          futureDelegationField: 7,
        },
      ],
      updatedBy: 'x',
      updatedAt: 'x',
      futurePolicyField: { nested: true },
    };
    const parsed = LimitsPolicySchema.parse(stored) as Record<string, unknown>;
    expect(parsed.futurePolicyField).toEqual({ nested: true });
    expect(
      (parsed.overrides as Array<Record<string, unknown>>)[0]
        .futureOverrideField,
    ).toBe('kept');
    expect(
      (parsed.delegations as Array<Record<string, unknown>>)[0]
        .futureDelegationField,
    ).toBe(7);
  });
});
