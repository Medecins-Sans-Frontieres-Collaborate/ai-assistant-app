import {
  parseSkillBundle,
  serializeSkillBundle,
} from '@/lib/services/skills/skillBundle';
import {
  buildSkillCatalog,
  getSkillRoutingCatalog,
  resolveActiveSkills,
} from '@/lib/services/skills/skillCatalog';
import {
  parseSkillMarkdown,
  serializeSkillMarkdown,
} from '@/lib/services/skills/skillMarkdown';
import {
  SKILL_LIMITS,
  UserSkillSchema,
  UserSkillsRequestSchema,
} from '@/lib/services/skills/types';
import {
  normalizeUserSkills,
  personalSkillCatalog,
  personalSkillFromBundle,
} from '@/lib/services/skills/userSkills';

import { skillSelectionForRequest } from '@/lib/utils/shared/chat/skillSelection';

import { describe, expect, it } from 'vitest';

const skill = {
  id: 'platform-help',
  name: 'My Help',
  description: 'Help with my weekly reports',
  instructions: 'Use my template.',
  activation: 'auto' as const,
  enabled: true,
};
describe('personal skills', () => {
  it('rejects export metadata that could forge identity, activation, or YAML keys', () => {
    for (const key of [
      'name',
      'description',
      'metadata.msf-activation',
      'bad\nkey',
    ]) {
      expect(
        UserSkillSchema.safeParse({
          ...skill,
          foreignFrontmatter: { [key]: 'override' },
        }).success,
      ).toBe(false);
    }
  });
  it('bounds combined foreign metadata as well as each individual value', () => {
    const foreignFrontmatter = Object.fromEntries(
      Array.from({ length: 70 }, (_, i) => [
        `metadata.field-${i}`,
        'x'.repeat(1024),
      ]),
    );
    expect(
      UserSkillSchema.safeParse({ ...skill, foreignFrontmatter }).success,
    ).toBe(false);
  });
  it('cannot override organization identities, even when names collide', () => {
    const catalog = [
      ...buildSkillCatalog([]),
      ...personalSkillCatalog([skill]),
    ];
    expect(catalog.map((entry) => entry.skill.id)).toEqual([
      'platform-help',
      'user:platform-help',
    ]);
    const active = resolveActiveSkills(catalog, ['user:platform-help']).active;
    expect(active[0].skill.instructions).toBe('Use my template.');
    expect(active[0].skill.documents).toEqual([]);
    expect(active[0].skill.applyToAgents).toBe(false);
    expect(
      getSkillRoutingCatalog(catalog, []).map((entry) => entry.id),
    ).toContain('user:platform-help');
  });
  it('disabled and off skills never reach the catalog', () => {
    expect(
      personalSkillCatalog([
        { ...skill, enabled: false },
        { ...skill, id: 'off', activation: 'off' },
      ]),
    ).toEqual([]);
  });
  it('rejects documents, permissions and forged server-owned identity fields', () => {
    for (const extra of [
      { documents: [] },
      { applyToAgents: true },
      { personal: true },
      { id: 'user:gdpr' },
    ]) {
      expect(UserSkillSchema.safeParse({ ...skill, ...extra }).success).toBe(
        false,
      );
    }
  });
  it('normalizes persisted duplicates and corruption without dropping valid siblings', () => {
    expect(
      normalizeUserSkills([skill, null, skill, { ...skill, id: 'report' }]).map(
        (entry) => entry.id,
      ),
    ).toEqual(['platform-help', 'report']);
    expect(normalizeUserSkills(undefined)).toEqual([]);
  });
  it('caps serialized UTF-8 payloads and rejects duplicate ids', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      ...skill,
      id: `skill-${i}`,
      instructions: 'x'.repeat(16000),
    }));
    expect(UserSkillsRequestSchema.safeParse(many).success).toBe(false);
    expect(UserSkillsRequestSchema.safeParse([skill, skill]).success).toBe(
      false,
    );
    expect(
      UserSkillsRequestSchema.safeParse(
        Array.from({ length: 21 }, (_, i) => ({ ...skill, id: `skill-${i}` })),
      ).success,
    ).toBe(false);
    expect(UserSkillsRequestSchema.safeParse([skill]).success).toBe(true);
  });
  it('preserves namespaced pins and deduplicates organization/personal choices independently', () => {
    expect(
      skillSelectionForRequest(
        ['platform-help', 'user:platform-help'],
        ['user:platform-help'],
      ).forcedSkillIds,
    ).toEqual(['platform-help', 'user:platform-help']);
  });
  it('imports text references into the reviewed body and exports an unprefixed standard identity', () => {
    const bundle = parseSkillBundle(
      serializeSkillBundle({ ...skill, applyToAgents: true }, [
        {
          path: 'references/style.md',
          bytes: new TextEncoder().encode('Use plain language.'),
        },
      ]),
    );
    const personal = personalSkillFromBundle(bundle);
    expect(personal.instructions).toContain('Use plain language.');
    expect(personal).not.toHaveProperty('applyToAgents');
    const exported = parseSkillMarkdown(
      serializeSkillMarkdown({ ...personal, applyToAgents: false }),
    );
    expect(exported.ok && exported.skill.id).toBe('platform-help');
  });
  it('refuses binary resources and text references exceeding the instruction cap', () => {
    const bundle = {
      skill: { ...skill, applyToAgents: false },
      skipped: [],
      resources: [
        { path: 'references/policy.pdf', bytes: new Uint8Array([1]) },
      ],
    };
    expect(() => personalSkillFromBundle(bundle)).toThrow(/binary/);
    bundle.resources = [
      {
        path: 'references/policy.md',
        bytes: new TextEncoder().encode(
          'x'.repeat(SKILL_LIMITS.instructionsMaxBytes),
        ),
      },
    ];
    expect(() => personalSkillFromBundle(bundle)).toThrow();
  });
});
