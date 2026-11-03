/**
 * Built-in skills: compiled defaults merged under admin records by the
 * catalog (docs/SKILLS_DESIGN.md §2) — the orgAgentRegistry pattern. An
 * admin record with a built-in's id OVERRIDES it (any field, including
 * activation: 'off' to disable); deleting the override restores the
 * compiled default. Built-ins are never deleted, only overridden.
 */
import {
  BASE_SYSTEM_PROMPT,
  PLATFORM_ABOUT_PROMPT_SECTION,
  PLATFORM_FEATURES_PROMPT_SECTION,
  extractPromptSection,
} from '@/lib/utils/app/systemPrompt';

import { Skill } from './types';

/** Preserve deployment-authored platform wording when moving it into a built-in skill. */
export function platformHelpInstructions(base = BASE_SYSTEM_PROMPT): string {
  return [
    extractPromptSection(base, '## About the MSF AI Assistant') ??
      PLATFORM_ABOUT_PROMPT_SECTION,
    extractPromptSection(base, '## Features') ??
      PLATFORM_FEATURES_PROMPT_SECTION,
  ].join('\n\n');
}

/**
 * platform-help carries the platform sections EXTRACTED from the base
 * prompt — imported from systemPrompt.ts, never copied, so the two can
 * never drift (docs/SKILLS_DESIGN.md §3). SkillEnricher removes the
 * sections from the effective base prompt whenever this skill is
 * deliverable for the turn's user, and the skill re-injects them.
 *
 * Phase 2 routes this skill automatically. Data-entry safety remains in the
 * permanent core prompt. Admin overrides (including existing 'always'
 * records) keep their authored activation mode.
 */
export const BUILTIN_SKILLS: readonly Skill[] = [
  {
    version: 1,
    id: 'platform-help',
    name: 'Platform Help',
    description:
      'Questions about the MSF AI Assistant itself: its features and what it can do, data privacy, where conversations are stored, file uploads, transcription, translation, Microsoft 365 integration, downloads and exports, voice input, mobile/PWA use, settings, or how to get support. Also capability questions like "can you email this?" or "how do I attach a file?".',
    activation: 'auto',
    applyToAgents: false,
    instructions: platformHelpInstructions(),
    documents: [],
    updatedAt: '2026-10-24T00:00:00.000Z',
  },
];

/** Lookup for override merging and id-collision checks. */
export const BUILTIN_SKILL_IDS: ReadonlySet<string> = new Set(
  BUILTIN_SKILLS.map((skill) => skill.id),
);

export function getBuiltinSkill(id: string): Skill | undefined {
  return BUILTIN_SKILLS.find((skill) => skill.id === id);
}
