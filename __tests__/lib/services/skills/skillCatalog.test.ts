/**
 * Catalog merge + active-set resolution (docs/SKILLS_DESIGN.md §2, §5): the
 * pure logic the enricher and routes compose. Storage and access rules are
 * out of scope here (the inputs are supplied).
 */
import { BUILTIN_SKILLS } from '@/lib/services/skills/builtinSkills';
import {
  buildSkillCatalog,
  getSkillRoutingCatalog,
  resolveActiveSkills,
} from '@/lib/services/skills/skillCatalog';
import { CatalogSkill, Skill } from '@/lib/services/skills/types';

import { describe, expect, it } from 'vitest';

function makeSkill(overrides: Partial<Skill> & { id: string }): Skill {
  return {
    version: 1,
    name: overrides.id,
    description: `About ${overrides.id}`,
    activation: 'auto',
    applyToAgents: false,
    instructions: `Instructions for ${overrides.id}`,
    documents: [],
    updatedAt: '2026-10-24T00:00:00.000Z',
    ...overrides,
  };
}

function catalogEntry(
  overrides: Partial<Skill> & { id: string },
): CatalogSkill {
  return { skill: makeSkill(overrides), builtin: false, overridden: false };
}

describe('buildSkillCatalog', () => {
  it('a large organization catalog cannot starve personal or explicitly named matching auto skills', () => {
    const large = Array.from({ length: 60 }, (_, i) =>
      catalogEntry({
        id: `generic-${i}`,
        description: 'Generic office topics',
      }),
    );
    large.push(
      catalogEntry({
        id: 'specific-gdpr',
        name: 'Special privacy guidance',
        description: 'GDPR retention',
      }),
    );
    large.push({ ...catalogEntry({ id: 'user:report' }), personal: true });
    const ids = getSkillRoutingCatalog(
      large,
      [],
      'Use Special privacy guidance for GDPR retention',
    ).map((entry) => entry.id);
    expect(ids).toHaveLength(50);
    expect(ids).toContain('specific-gdpr');
    expect(ids).toContain('user:report');
  });
  it('serves compiled built-ins when nothing is stored', () => {
    const catalog = buildSkillCatalog([]);
    expect(catalog.map((entry) => entry.skill.id)).toEqual(
      BUILTIN_SKILLS.map((skill) => skill.id),
    );
    expect(catalog[0]).toMatchObject({ builtin: true, overridden: false });
  });

  it('replaces a built-in with its admin override in place', () => {
    const override = makeSkill({
      id: 'platform-help',
      activation: 'off',
      instructions: 'Overridden.',
    });
    const catalog = buildSkillCatalog([override]);
    const entry = catalog.find((item) => item.skill.id === 'platform-help')!;
    expect(entry.skill.activation).toBe('off');
    expect(entry.skill.instructions).toBe('Overridden.');
    expect(entry).toMatchObject({ builtin: true, overridden: true });
  });

  it('appends org skills after built-ins, sorted by id', () => {
    const catalog = buildSkillCatalog([
      makeSkill({ id: 'zulu' }),
      makeSkill({ id: 'gdpr' }),
    ]);
    expect(catalog.map((entry) => entry.skill.id)).toEqual([
      ...BUILTIN_SKILLS.map((skill) => skill.id),
      'gdpr',
      'zulu',
    ]);
  });
});

describe('resolveActiveSkills', () => {
  it('routes only auto/visible skills, with pinned attribution winning over auto', () => {
    const visible = [
      catalogEntry({ id: 'gdpr' }),
      catalogEntry({ id: 'report' }),
      catalogEntry({ id: 'disabled', activation: 'off' }),
    ];
    expect(
      getSkillRoutingCatalog(visible, ['gdpr']).map((entry) => entry.id),
    ).toEqual(['report']);
    const { active } = resolveActiveSkills(visible, ['gdpr'], {
      relevantSkills: ['gdpr', 'report', 'disabled', 'unknown'],
      pinnedSkillIds: ['gdpr'],
    });
    expect(active.map(({ skill, via }) => [skill.id, via])).toEqual([
      ['gdpr', 'pinned'],
      ['report', 'routed'],
    ]);
  });
  it('activates forced skills and reports unknown ids as dropped', () => {
    const visible = [catalogEntry({ id: 'gdpr' })];
    const { active, droppedForcedIds } = resolveActiveSkills(visible, [
      'gdpr',
      'missing',
    ]);
    expect(active).toEqual([{ skill: visible[0].skill, via: 'forced' }]);
    expect(droppedForcedIds).toEqual(['missing']);
  });

  it('activates always skills without any forced ids', () => {
    const visible = [
      catalogEntry({ id: 'auto-one' }),
      catalogEntry({ id: 'standing', activation: 'always' }),
    ];
    const { active } = resolveActiveSkills(visible, []);
    expect(active).toEqual([{ skill: visible[1].skill, via: 'always' }]);
  });

  it('a skill both forced and always activates ONCE, attributed forced', () => {
    const visible = [catalogEntry({ id: 'standing', activation: 'always' })];
    const { active } = resolveActiveSkills(visible, ['standing']);
    expect(active).toHaveLength(1);
    expect(active[0].via).toBe('forced');
  });

  it('caps forced skills at 3 and always skills at 5', () => {
    const forcedPool = Array.from({ length: 4 }, (_, i) =>
      catalogEntry({ id: `forced-${i}` }),
    );
    const alwaysPool = Array.from({ length: 6 }, (_, i) =>
      catalogEntry({ id: `always-${i}`, activation: 'always' }),
    );
    const { active } = resolveActiveSkills(
      [...forcedPool, ...alwaysPool],
      forcedPool.map((entry) => entry.skill.id),
    );
    expect(active.filter((entry) => entry.via === 'forced')).toHaveLength(3);
    expect(active.filter((entry) => entry.via === 'always')).toHaveLength(5);
  });

  it('dedupes a repeated forced id', () => {
    const visible = [catalogEntry({ id: 'gdpr' })];
    const { active } = resolveActiveSkills(visible, ['gdpr', 'gdpr']);
    expect(active).toHaveLength(1);
  });
});
