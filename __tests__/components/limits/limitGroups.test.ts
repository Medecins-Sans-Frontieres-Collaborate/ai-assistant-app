/**
 * Drift guard for the UI-side feature grouping, in the spirit of
 * __tests__/lib/services/limits/catalog.test.ts: the grouping is
 * presentational, but a catalog key missing from it would silently vanish
 * from the admin UI, which is exactly the class of bug a positive
 * invariant catches.
 */
import {
  LIMIT_GROUPS,
  groupOfKey,
  seedValueFor,
} from '@/components/Limits/limitGroups';

import { LIMIT_DEFINITIONS, getLimitDefinition } from '@/config/limits';
import { describe, expect, it } from 'vitest';

describe('limitGroups drift guard', () => {
  it('covers every catalog key exactly once across gates and members', () => {
    const seen = new Map<string, number>();
    for (const group of LIMIT_GROUPS) {
      const keys = [
        ...(group.gateKey ? [group.gateKey] : []),
        ...group.memberKeys,
      ];
      for (const key of keys) {
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
    }
    for (const def of LIMIT_DEFINITIONS) {
      expect(
        seen.get(def.key),
        `catalog key "${def.key}" must appear in exactly one group`,
      ).toBe(1);
    }
    // And nothing beyond the catalog.
    expect(seen.size).toBe(LIMIT_DEFINITIONS.length);
  });

  it('only references keys that exist in the catalog', () => {
    for (const group of LIMIT_GROUPS) {
      for (const key of [
        ...(group.gateKey ? [group.gateKey] : []),
        ...group.memberKeys,
      ]) {
        expect(
          getLimitDefinition(key),
          `group "${group.id}" references unknown key "${key}"`,
        ).toBeDefined();
      }
    }
  });

  it('every gateKey is a boolean-unit, non-perModel definition', () => {
    for (const group of LIMIT_GROUPS) {
      if (!group.gateKey) continue;
      const def = getLimitDefinition(group.gateKey);
      expect(def?.unit, `gate "${group.gateKey}" must be boolean`).toBe(
        'boolean',
      );
      // model.allowed is perModel and must never become a group gate: it
      // is a per-model cell, and dimming a whole group off it would be
      // wrong for every other model.
      expect(
        def?.perModel,
        `gate "${group.gateKey}" must not be perModel`,
      ).toBe(false);
    }
  });

  it('groupOfKey resolves members and gates to their group', () => {
    expect(groupOfKey('feature.codeInterpreter.enabled')?.id).toBe(
      'codeInterpreter',
    );
    expect(groupOfKey('feature.codeInterpreter.runsPerDay')?.id).toBe(
      'codeInterpreter',
    );
    expect(groupOfKey('not.a.key')).toBeUndefined();
  });

  describe('seedValueFor', () => {
    it('seeds booleans blocked, never unlimited', () => {
      const def = getLimitDefinition('feature.webSearch.enabled')!;
      expect(seedValueFor(def)).toBe(false);
    });

    it('seeds counters with a concrete number, never null', () => {
      const def = getLimitDefinition('feature.codeInterpreter.runsPerDay')!;
      expect(seedValueFor(def)).toBe(100);
    });

    it('clamps the seed to a compiled hard ceiling', () => {
      const def = getLimitDefinition('feature.mcp.roundsPerRequest')!;
      expect(seedValueFor(def)).toBe(25);
    });
  });
});
