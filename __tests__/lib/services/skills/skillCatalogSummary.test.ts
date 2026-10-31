/**
 * The advertised skill catalog (docs/SKILLS_DESIGN.md §5.6): stable order,
 * a character budget that admits priority ids first, and per-thread deltas.
 */
import {
  buildAdvertisedCatalog,
  renderSkillCatalogDelta,
  renderSkillCatalogMessage,
} from '@/lib/services/skills/skillCatalogSummary';
import type { Skill } from '@/lib/services/skills/types';

import { describe, expect, it } from 'vitest';

const skill = (id: string, description = `About ${id}`): { skill: Skill } => ({
  skill: {
    version: 1,
    id,
    name: id.toUpperCase(),
    description,
    instructions: `SECRET BODY ${id}`,
    activation: 'auto',
    applyToAgents: true,
    documents: [],
    updatedAt: '2026-10-30T00:00:00.000Z',
  },
});

describe('buildAdvertisedCatalog', () => {
  it('sorts by id, never includes bodies, and truncates long descriptions', () => {
    const catalog = buildAdvertisedCatalog([
      skill('zeta'),
      skill('alpha', 'x'.repeat(2000)),
    ]);
    expect(catalog.entries.map((entry) => entry.id)).toEqual(['alpha', 'zeta']);
    expect(catalog.json).not.toContain('SECRET BODY');
    expect(catalog.entries[0].description.length).toBeLessThanOrEqual(400);
    expect(catalog.omitted).toEqual([]);
  });

  it('admits priority ids before the budget runs out and reports omissions', () => {
    const skills = Array.from({ length: 40 }, (_, index) =>
      skill(`skill-${String(index).padStart(2, '0')}`, 'y'.repeat(390)),
    );
    const catalog = buildAdvertisedCatalog(skills, {
      maxChars: 2000,
      priorityIds: ['skill-39'],
    });
    expect(catalog.entries.some((entry) => entry.id === 'skill-39')).toBe(true);
    expect(catalog.omitted.length).toBeGreaterThan(0);
    expect(catalog.json.length).toBeLessThanOrEqual(2000 + 50);
    // Final order is by id regardless of admission order.
    const ids = catalog.entries.map((entry) => entry.id);
    expect(ids).toEqual([...ids].sort());
  });
});

describe('catalog messages', () => {
  it('renders the full catalog for a new thread and only changes afterwards', () => {
    const before = buildAdvertisedCatalog([skill('a'), skill('b')]);
    const full = renderSkillCatalogMessage(before);
    expect(full).toContain('"a"');
    expect(full).toContain('"b"');

    const after = buildAdvertisedCatalog([
      skill('b', 'changed description'),
      skill('c'),
    ]);
    const delta = renderSkillCatalogDelta(before.entries, after.entries)!;
    expect(delta).toContain('c');
    expect(delta).toContain('b');
    expect(delta).toMatch(/a/);
    expect(delta).not.toContain('SECRET BODY');
    expect(renderSkillCatalogDelta(after.entries, after.entries)).toBeNull();
  });
});
