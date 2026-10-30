/**
 * Skill catalog — the layer between stored records and consumers (the chat
 * pipeline, the user-facing catalog route).
 *
 * Merging (docs/SKILLS_DESIGN.md §2): compiled built-ins, each replaced by
 * an admin record with the same id when one exists (the orgAgentRegistry
 * pattern), plus admin-authored org skills. Visibility: the agent-access
 * rule engine under `skill::<id>` keys — no rule means org-wide
 * (default-allow), and a degraded group lookup fails closed like guides.
 */
import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import { SKILL_SOURCE } from '@/lib/services/agentAccess/types';

import { BUILTIN_SKILLS } from './builtinSkills';
import type { SkillRoutingEntry } from './skillRouting';
import { CatalogSkill, SKILL_LIMITS, Skill } from './types';

import { env } from '@/config/environment';

/**
 * Whether ORGANIZATION skills (admin-authored records, access rules, the
 * admin area) are available: they ride the agent-access storage and rule
 * machinery. Skills as a feature are always on — without this, the catalog
 * is the compiled built-ins plus the user's personal skills
 * (docs/SKILLS_DESIGN.md §4).
 */
export function orgSkillsAvailable(): boolean {
  return env.AGENT_ACCESS_CONTROL_ENABLED;
}

/**
 * Merges compiled built-ins with stored admin records. Pure — callers
 * supply the records — so the merge is unit-testable without storage.
 *
 * Order: built-ins first (in their compiled order, overridden in place),
 * then org skills by id. Deterministic order matters because the `always`
 * cap truncates from the end (resolveActiveSkills).
 */
export function buildSkillCatalog(storedSkills: Skill[]): CatalogSkill[] {
  const storedById = new Map(storedSkills.map((skill) => [skill.id, skill]));

  const catalog: CatalogSkill[] = BUILTIN_SKILLS.map((builtin) => {
    const override = storedById.get(builtin.id);
    return {
      skill: override ?? builtin,
      builtin: true,
      overridden: !!override,
    };
  });

  const builtinIds = new Set(BUILTIN_SKILLS.map((skill) => skill.id));
  const orgSkills = storedSkills
    .filter((skill) => !builtinIds.has(skill.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const skill of orgSkills) {
    catalog.push({ skill, builtin: false, overridden: false });
  }

  return catalog;
}

/**
 * The catalog a USER may see: 'off' records dropped, access rules applied. Callers that evaluate group-restricted rules reliably must
 * warm the group cache first (resolveUserGroupIds in routes); a degraded
 * lookup yields 'unavailable' and the skill is treated as not visible —
 * fail closed, the guides contract.
 */
export async function getVisibleSkills(
  userMail: string | undefined,
): Promise<CatalogSkill[]> {
  // No agent-access storage: built-ins only, org-wide (nothing to filter by).
  if (!orgSkillsAvailable())
    return buildSkillCatalog([]).filter(
      (entry) => entry.skill.activation !== 'off',
    );

  const service = AgentAccessService.getInstance();
  await service.ensureFresh();
  const snapshot = service.getSnapshot();
  // A storage outage must not extend the documented revocation window by
  // serving last-known-good grants indefinitely. Other agent behavior stays
  // unchanged; skills fail closed on an expired authorization snapshot.
  if (
    snapshot.rulesUnavailable ||
    snapshot.fetchedAt === null ||
    (typeof snapshot.fetchedAt === 'number' &&
      Date.now() - snapshot.fetchedAt >= 60_000)
  )
    return [];

  return buildSkillCatalog(service.getSkills()).filter(
    (entry) =>
      entry.skill.activation !== 'off' &&
      service.evaluateAccess({
        userMail,
        source: SKILL_SOURCE,
        agentName: entry.skill.id,
      }).decision === 'allow',
  );
}

/** How a skill entered the turn's active set (docs/SKILLS_DESIGN.md §10). */
export type SkillActivationPath = 'forced' | 'pinned' | 'routed' | 'always';

/** Metadata for the router, excluding off/standing and explicitly chosen skills. */
export function getSkillRoutingCatalog(
  visible: CatalogSkill[],
  forcedIds: readonly string[],
  taskText = '',
): SkillRoutingEntry[] {
  const forced = new Set(forcedIds);
  const eligible = visible.filter(
    ({ skill }) => skill.activation === 'auto' && !forced.has(skill.id),
  );
  const text = taskText.slice(-12000).toLowerCase();
  const terms = new Set(text.match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  const rank = (entry: CatalogSkill) => {
    const skill = entry.skill;
    const name = skill.name.toLowerCase();
    const words = new Set(
      `${skill.id} ${name} ${skill.description.slice(0, 1024)}`
        .toLowerCase()
        .match(/[\p{L}\p{N}]{3,}/gu) ?? [],
    );
    return (
      (text.includes(skill.id) || (name.length >= 3 && text.includes(name))
        ? 1000
        : 0) + [...words].filter((word) => terms.has(word)).length
    );
  };
  // Personal skills have a bounded library (20) and cannot be starved by an
  // organization with 50+ entries. For the remaining slots prefer metadata
  // matching the current task rather than an alphabetical prefix.
  const personal = eligible
    .filter((entry) => entry.personal)
    .slice(0, SKILL_LIMITS.maxUserSkills);
  const organization = eligible
    .filter((entry) => !entry.personal)
    .map((entry, index) => ({ entry, index, score: rank(entry) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, SKILL_LIMITS.maxRouterCatalog - personal.length)
    .map(({ entry }) => entry);
  return [...organization, ...personal].map(({ skill }) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
  }));
}

export interface ActiveSkill {
  skill: Skill;
  via: SkillActivationPath;
}

export interface ActiveSkillsResolution {
  active: ActiveSkill[];
  /**
   * Forced ids that did not resolve (unknown, hidden by access rules, or
   * activation 'off'). Reported, never silent: an explicit request that
   * quietly did nothing would be worse than an error
   * (docs/SKILLS_DESIGN.md §10).
   */
  droppedForcedIds: string[];
}

/**
 * Resolves the active set for one turn from the user's visible catalog:
 * forced skills (explicit use — attribution wins when a skill is both
 * forced and 'always') then 'always' skills, deduplicated, capped.
 * Pure and synchronous — the enricher supplies the inputs.
 */
export function resolveActiveSkills(
  visible: CatalogSkill[],
  forcedSkillIds: readonly string[],
  selection: {
    relevantSkills?: readonly string[];
    pinnedSkillIds?: readonly string[];
  } = {},
): ActiveSkillsResolution {
  const visibleById = new Map(
    visible
      .filter(({ skill }) => skill.activation !== 'off')
      .map((entry) => [entry.skill.id, entry.skill]),
  );

  const active: ActiveSkill[] = [];
  const activeIds = new Set<string>();
  const droppedForcedIds: string[] = [];

  for (const id of forcedSkillIds.slice(0, SKILL_LIMITS.maxForcedPerTurn)) {
    if (activeIds.has(id)) continue;
    const skill = visibleById.get(id);
    if (!skill) {
      droppedForcedIds.push(id);
      continue;
    }
    active.push({
      skill,
      via: selection.pinnedSkillIds?.includes(id) ? 'pinned' : 'forced',
    });
    activeIds.add(id);
  }

  let routedCount = 0;
  for (const id of selection.relevantSkills ?? []) {
    const skill = visibleById.get(id);
    if (!skill || skill.activation !== 'auto' || activeIds.has(id)) continue;
    if (routedCount >= SKILL_LIMITS.maxAutoPerTurn) break;
    active.push({ skill, via: 'routed' });
    activeIds.add(id);
    routedCount += 1;
  }

  let alwaysCount = 0;
  for (const entry of visible) {
    if (entry.skill.activation !== 'always') continue;
    if (alwaysCount >= SKILL_LIMITS.maxAlwaysPerTurn) break;
    if (activeIds.has(entry.skill.id)) continue;
    alwaysCount += 1;
    active.push({ skill: entry.skill, via: 'always' });
    activeIds.add(entry.skill.id);
  }

  return { active, droppedForcedIds };
}
