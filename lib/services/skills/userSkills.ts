/** Client/server personal-skill helpers. This module has no server storage imports. */
import type { SkillBundle } from './skillBundle';
import {
  CatalogSkill,
  SKILL_LIMITS,
  UserSkill,
  UserSkillSchema,
} from './types';

/** Sanitizes persisted content without discarding valid entries beside a corrupt item. */
export function normalizeUserSkills(value: unknown): UserSkill[] {
  if (!Array.isArray(value)) return [];
  const result: UserSkill[] = [];
  for (const entry of value) {
    const parsed = UserSkillSchema.safeParse(entry);
    if (parsed.success && !result.some((skill) => skill.id === parsed.data.id))
      result.push(parsed.data);
    if (result.length >= SKILL_LIMITS.maxUserSkills) break;
  }
  return result;
}

/** User bodies are request-local and cannot shadow a compiled/admin skill id. */
export function personalSkillCatalog(
  skills: readonly UserSkill[],
): CatalogSkill[] {
  return skills
    .filter((skill) => skill.enabled && skill.activation !== 'off')
    .map((skill) => ({
      skill: {
        ...skill,
        id: `user:${skill.id}`,
        version: 1,
        applyToAgents: false,
        documents: [],
        updatedAt: '',
      },
      builtin: false,
      overridden: false,
      personal: true,
    }));
}

/** Personal bundles may inline text references only; binary assets require organization storage. */
export function personalSkillFromBundle(bundle: SkillBundle): UserSkill {
  const {
    applyToAgents: _ignored,
    requireConsent: _consent,
    ...fields
  } = bundle.skill;
  let instructions = fields.instructions;
  for (const resource of bundle.resources) {
    if (
      !/\.(md|markdown|txt|csv|tsv|json|xml|html|htm|tex)$/i.test(
        resource.path,
      ) &&
      !/(^|\/)licen[sc]e$/i.test(resource.path)
    ) {
      throw new Error(
        'Personal skills cannot store binary documents or assets. Import the SKILL.md alone, or ask an admin to publish the bundle.',
      );
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      resource.bytes,
    );
    if (text.includes('\0'))
      throw new Error('A reference contains binary data');
    instructions += `\n\n## Bundled reference: ${resource.path}\n\n${text}`;
  }
  return UserSkillSchema.parse({ ...fields, instructions, enabled: true });
}
