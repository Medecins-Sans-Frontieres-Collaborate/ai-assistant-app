/**
 * Live visibility (docs/SKILLS_DESIGN.md §10): per-turn selections are
 * announced through the activity channel while the model works; standing
 * 'always' skills stay silent, like their (absent) record.
 */
import { createTestChatContext } from '@/__tests__/lib/services/chat/testUtils';
import { SkillEnricher } from '@/lib/services/chat/enrichers/SkillEnricher';
import {
  getVisibleSkills,
  skillsFeatureEnabled,
} from '@/lib/services/skills/skillCatalog';
import { CatalogSkill, Skill } from '@/lib/services/skills/types';

import { Mock, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/skills/skillCatalog', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/skills/skillCatalog')>();
  return {
    ...actual,
    skillsFeatureEnabled: vi.fn(() => true),
    getVisibleSkills: vi.fn(async () => []),
  };
});

const mockFeatureEnabled = skillsFeatureEnabled as Mock;
const mockGetVisibleSkills = getVisibleSkills as Mock;

function entry(overrides: Partial<Skill> & { id: string }): CatalogSkill {
  return {
    skill: {
      version: 1,
      name: overrides.id.toUpperCase(),
      description: `About ${overrides.id}`,
      activation: 'auto',
      applyToAgents: false,
      instructions: `Instructions for ${overrides.id}`,
      documents: [],
      updatedAt: '2026-10-24T00:00:00.000Z',
      ...overrides,
    },
    builtin: false,
    overridden: false,
  };
}

describe('SkillEnricher live activity', () => {
  beforeEach(() => {
    mockFeatureEnabled.mockReturnValue(true);
  });

  it('announces a single applied skill by name', async () => {
    mockGetVisibleSkills.mockResolvedValue([entry({ id: 'gdpr' })]);
    const emitActivity = vi.fn(async () => undefined);
    await new SkillEnricher().execute({
      ...createTestChatContext({ systemPrompt: 'Base' }),
      emitActivity,
      emitMarker: vi.fn(),
      skillCatalog: [entry({ id: 'gdpr' })],
      skillRouting: { relevantSkills: ['gdpr'] },
    });
    expect(emitActivity).toHaveBeenCalledWith('chat.activity.applyingSkill', {
      skills: 'GDPR',
    });
  });

  it('announces several skills with the plural key, forced before routed', async () => {
    mockGetVisibleSkills.mockResolvedValue([
      entry({ id: 'gdpr' }),
      entry({ id: 'forms' }),
    ]);
    const emitActivity = vi.fn(async () => undefined);
    await new SkillEnricher().execute({
      ...createTestChatContext({ systemPrompt: 'Base' }),
      emitActivity,
      emitMarker: vi.fn(),
      forcedSkillIds: ['forms'],
      skillCatalog: [entry({ id: 'gdpr' })],
      skillRouting: { relevantSkills: ['gdpr'] },
    });
    expect(emitActivity).toHaveBeenCalledWith('chat.activity.applyingSkills', {
      skills: 'FORMS, GDPR',
    });
  });

  it('announces the skills-only routing wait before calling the router', async () => {
    mockGetVisibleSkills.mockResolvedValue([entry({ id: 'gdpr' })]);
    const emitActivity = vi.fn(async () => undefined);
    const determineSkills = vi.fn().mockResolvedValue({ relevantSkills: [] });
    await new SkillEnricher({ determineSkills }).execute({
      ...createTestChatContext({ systemPrompt: 'Base' }),
      emitActivity,
      emitMarker: vi.fn(),
      skillCatalog: [entry({ id: 'gdpr' })],
    });
    expect(emitActivity).toHaveBeenCalledWith('chat.activity.selectingSkills');
    expect(determineSkills).toHaveBeenCalledTimes(1);
  });

  it('stays silent when only standing (always) skills are active', async () => {
    mockGetVisibleSkills.mockResolvedValue([
      entry({ id: 'house-style', activation: 'always' }),
    ]);
    const emitActivity = vi.fn(async () => undefined);
    const result = await new SkillEnricher().execute({
      ...createTestChatContext({ systemPrompt: 'Base' }),
      emitActivity,
      emitMarker: vi.fn(),
      skillRouting: { relevantSkills: [] },
    });
    expect(result.systemPrompt).toContain('Instructions for house-style');
    expect(emitActivity).not.toHaveBeenCalled();
  });
});
