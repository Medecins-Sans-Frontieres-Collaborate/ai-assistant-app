import { ADMIN_AREA_IDS } from '@/lib/services/admin/adminAreas';

import { ADMIN_AREAS, ADMIN_GROUPS } from '@/components/Admin/areas';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Registry invariants for the admin area rail.
 *
 * ⚠ `.test.tsx`, not `.test.ts`, although nothing here renders. A `.test.ts`
 * under `__tests__/components/Admin/` is matched by NEITHER vitest config
 * (jsdom takes `.test.tsx` only; the node config enumerates specific
 * component subdirectories) and would report green by never running — the same
 * trap vitest.config.node.mts documents for the design guards.
 */

const messages = JSON.parse(
  readFileSync(resolve(__dirname, '../../../messages/en.json'), 'utf8'),
) as Record<string, unknown>;

function lookup(key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object'
          ? (node as Record<string, unknown>)[part]
          : undefined,
      messages,
    );
}

describe('admin area registry', () => {
  it('places every area in exactly one group', () => {
    const placed = ADMIN_GROUPS.flatMap((group) => group.areas);

    // Sorted comparison: order WITHIN a group is a design decision this test
    // must not freeze, but membership is an invariant — an area added to the
    // resolver and forgotten here would never appear in the rail at all.
    expect([...placed].sort()).toEqual([...ADMIN_AREA_IDS].sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  it('has a descriptor for every placed area', () => {
    for (const group of ADMIN_GROUPS) {
      for (const id of group.areas) {
        expect(ADMIN_AREAS[id], `${id} has no descriptor`).toBeDefined();
        expect(ADMIN_AREAS[id].id).toBe(id);
      }
    }
  });

  it('has no empty group', () => {
    for (const group of ADMIN_GROUPS) {
      expect(group.areas.length, `${group.id} is empty`).toBeGreaterThan(0);
    }
  });

  it('resolves every label and description key in en.json', () => {
    for (const group of ADMIN_GROUPS) {
      expect(typeof lookup(group.labelKey), group.labelKey).toBe('string');
    }
    for (const area of Object.values(ADMIN_AREAS)) {
      expect(typeof lookup(area.labelKey), area.labelKey).toBe('string');
      expect(typeof lookup(area.descriptionKey), area.descriptionKey).toBe(
        'string',
      );
    }
  });

  it('points every area href at its own admin route', () => {
    for (const [id, area] of Object.entries(ADMIN_AREAS)) {
      expect(area.href).toBe(`/admin/${id}`);
    }
  });
});
