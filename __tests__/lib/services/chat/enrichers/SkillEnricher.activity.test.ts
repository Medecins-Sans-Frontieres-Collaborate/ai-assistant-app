/**
 * Live visibility (docs/SKILLS_DESIGN.md §10): per-turn selections are
 * explicit requests are announced through the activity channel while the
 * model works. Automatic routing and standing/pinned guidance stay silent;
 * automatically applied skills still have a completed-use record.
 */
import { createTestChatContext } from '@/__tests__/lib/services/chat/testUtils';
import { SkillEnricher } from '@/lib/services/chat/enrichers/SkillEnricher';
import { getVisibleSkills } from '@/lib/services/skills/skillCatalog';
import { CatalogSkill, Skill } from '@/lib/services/skills/types';

import { Mock, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/skills/skillCatalog', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/skills/skillCatalog')>();
  return {
    ...actual,
    getVisibleSkills: vi.fn(async () => []),
  };
});

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
    mockGetVisibleSkills.mockResolvedValue([]);
  });

  it('announces a single explicitly requested skill by name', async () => {
    mockGetVisibleSkills.mockResolvedValue([entry({ id: 'gdpr' })]);
    const emitActivity = vi.fn(async () => undefined);
    await new SkillEnricher().execute({
      ...createTestChatContext({ systemPrompt: 'Base', stream: false }),
      emitActivity,
      emitMarker: vi.fn(),
      forcedSkillIds: ['gdpr'],
      skillCatalog: [entry({ id: 'gdpr' })],
      skillRouting: { relevantSkills: ['gdpr'] },
    });
    expect(emitActivity).toHaveBeenCalledWith('chat.activity.applyingSkill', {
      skills: 'GDPR',
    });
  });

  it('announces only the explicitly requested skill when another is routed', async () => {
    mockGetVisibleSkills.mockResolvedValue([
      entry({ id: 'gdpr' }),
      entry({ id: 'forms' }),
    ]);
    const emitActivity = vi.fn(async () => undefined);
    const emitMarker = vi.fn();
    const result = await new SkillEnricher().execute({
      ...createTestChatContext({ systemPrompt: 'Base', stream: false }),
      emitActivity,
      emitMarker,
      forcedSkillIds: ['forms'],
      skillCatalog: [entry({ id: 'gdpr' })],
      skillRouting: { relevantSkills: ['gdpr'] },
    });
    expect(emitActivity).toHaveBeenCalledExactlyOnceWith(
      'chat.activity.applyingSkill',
      { skills: 'FORMS' },
    );
    expect(result.systemPrompt).toContain('Instructions for forms');
    expect(result.systemPrompt).toContain('Instructions for gdpr');
    expect(emitMarker).toHaveBeenCalledTimes(1);
    expect(emitMarker.mock.calls[0][0]).toContain('FORMS (requested)');
    expect(emitMarker.mock.calls[0][0]).toContain('GDPR (auto)');
  });

  it('announces several explicitly requested skills with the plural key', async () => {
    mockGetVisibleSkills.mockResolvedValue([
      entry({ id: 'gdpr' }),
      entry({ id: 'forms' }),
    ]);
    const emitActivity = vi.fn(async () => undefined);
    await new SkillEnricher().execute({
      ...createTestChatContext({ systemPrompt: 'Base', stream: false }),
      emitActivity,
      emitMarker: vi.fn(),
      forcedSkillIds: ['forms', 'gdpr'],
    });
    expect(emitActivity).toHaveBeenCalledExactlyOnceWith(
      'chat.activity.applyingSkills',
      { skills: 'FORMS, GDPR' },
    );
  });

  it('records automatically applied skills without changing live activity', async () => {
    mockGetVisibleSkills.mockResolvedValue([entry({ id: 'gdpr' })]);
    const emitActivity = vi.fn(async () => undefined);
    const emitMarker = vi.fn();
    const result = await new SkillEnricher().execute({
      ...createTestChatContext({ systemPrompt: 'Base', stream: false }),
      emitActivity,
      emitMarker,
      skillRouting: { relevantSkills: ['gdpr'] },
    });
    expect(result.systemPrompt).toContain('Instructions for gdpr');
    expect(emitActivity).not.toHaveBeenCalled();
    expect(emitMarker).toHaveBeenCalledTimes(1);
    expect(emitMarker.mock.calls[0][0]).toContain('GDPR (auto)');
  });

  it('keeps routing in the background without changing live activity', async () => {
    mockGetVisibleSkills.mockResolvedValue([entry({ id: 'gdpr' })]);
    const emitActivity = vi.fn(async () => undefined);
    const determineSkills = vi.fn(async () => {
      expect(emitActivity).not.toHaveBeenCalled();
      return { relevantSkills: ['gdpr'] };
    });
    const result = await new SkillEnricher({ determineSkills }).execute({
      ...createTestChatContext({ systemPrompt: 'Base', stream: false }),
      emitActivity,
      emitMarker: vi.fn(),
      skillCatalog: [entry({ id: 'gdpr' })],
    });
    expect(emitActivity).not.toHaveBeenCalled();
    expect(determineSkills).toHaveBeenCalledTimes(1);
    expect(result.systemPrompt).toContain('Instructions for gdpr');
  });

  it('stays silent when only pinned skills are active', async () => {
    mockGetVisibleSkills.mockResolvedValue([entry({ id: 'gdpr' })]);
    const emitActivity = vi.fn(async () => undefined);
    const result = await new SkillEnricher().execute({
      ...createTestChatContext({ systemPrompt: 'Base', stream: false }),
      emitActivity,
      emitMarker: vi.fn(),
      forcedSkillIds: ['gdpr'],
      pinnedSkillIds: ['gdpr'],
      skillRouting: { relevantSkills: [] },
    });
    expect(result.systemPrompt).toContain('Instructions for gdpr');
    expect(emitActivity).not.toHaveBeenCalled();
  });

  it('stays silent when only standing (always) skills are active', async () => {
    mockGetVisibleSkills.mockResolvedValue([
      entry({ id: 'house-style', activation: 'always' }),
    ]);
    const emitActivity = vi.fn(async () => undefined);
    const emitMarker = vi.fn();
    const result = await new SkillEnricher().execute({
      ...createTestChatContext({ systemPrompt: 'Base', stream: false }),
      emitActivity,
      emitMarker,
      skillRouting: { relevantSkills: [] },
    });
    expect(result.systemPrompt).toContain('Instructions for house-style');
    expect(emitActivity).not.toHaveBeenCalled();
    expect(emitMarker).not.toHaveBeenCalled();
  });
});
