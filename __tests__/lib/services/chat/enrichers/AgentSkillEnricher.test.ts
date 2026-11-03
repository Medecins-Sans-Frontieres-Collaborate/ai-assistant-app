import { createTestChatContext } from '@/__tests__/lib/services/chat/testUtils';
import { AgentSkillEnricher } from '@/lib/services/chat/enrichers/AgentSkillEnricher';
import {
  getVisibleSkills,
  orgSkillsAvailable,
} from '@/lib/services/skills/skillCatalog';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/skills/skillCatalog', () => ({
  getVisibleSkills: vi.fn(),
  orgSkillsAvailable: vi.fn(() => true),
}));
describe('agent skill eligibility', () => {
  beforeEach(() => {
    vi.mocked(orgSkillsAvailable).mockReturnValue(true);
    vi.mocked(getVisibleSkills).mockResolvedValue([]);
  });
  it('keeps default agent prompts unchanged and offers no unconfigured skills', async () => {
    const context = createTestChatContext({
      botId: 'agent',
      systemPrompt: 'Persona',
      model: { supportsTools: true },
    });
    const result = await new AgentSkillEnricher().execute(context);
    expect(result.systemPrompt).toBe('Persona');
    expect(result.agentSkillsEnabled).toBe(false);
  });
  it('offers only opted-in org skills and refuses personal/disabled forced references', async () => {
    vi.mocked(getVisibleSkills).mockResolvedValue([
      {
        builtin: false,
        overridden: false,
        skill: {
          id: 'gdpr',
          name: 'GDPR',
          description: 'Privacy',
          version: 1,
          activation: 'auto',
          applyToAgents: true,
          documents: [],
          instructions: 'Sensitive instructions',
          updatedAt: '',
        },
      },
    ]);
    const context = {
      ...createTestChatContext({
        botId: 'agent',
        systemPrompt: 'Persona',
        model: { supportsTools: true },
      }),
      forcedSkillIds: ['gdpr', 'user:gdpr', 'missing'],
    };
    const result = await new AgentSkillEnricher().execute(context);
    expect(result.agentSkillsEnabled).toBe(true);
    expect(result.forcedSkillIds).toEqual(['gdpr']);
    expect(result.systemPrompt).toBe('Persona');
  });
  it('with the auto toggle off, offers only requested and admin-always skills', async () => {
    const skill = (id: string, activation: 'auto' | 'always') => ({
      builtin: false,
      overridden: false,
      skill: {
        id,
        name: id,
        description: 'd',
        version: 1,
        activation,
        applyToAgents: true,
        documents: [],
        instructions: 'i',
        updatedAt: '',
      },
    });
    vi.mocked(getVisibleSkills).mockResolvedValue([
      skill('auto-only', 'auto'),
      skill('standing', 'always'),
      skill('requested', 'auto'),
    ]);
    const base = createTestChatContext({
      botId: 'agent',
      systemPrompt: 'Persona',
      model: { supportsTools: true },
    });

    const off = await new AgentSkillEnricher().execute({
      ...base,
      skillsAuto: false,
      forcedSkillIds: ['requested'],
    });
    expect(off.agentSkillsEnabled).toBe(true);
    expect(off.forcedSkillIds).toEqual(['requested']);

    // Nothing requested and no standing skill → no skill tools at all, so
    // the native code interpreter is not displaced for this agent turn.
    vi.mocked(getVisibleSkills).mockResolvedValue([skill('auto-only', 'auto')]);
    const nothing = await new AgentSkillEnricher().execute({
      ...base,
      skillsAuto: false,
    });
    expect(nothing.agentSkillsEnabled).toBe(false);
  });
  it('does not run on standard conversations or without agent-access storage (org skills)', () => {
    const enricher = new AgentSkillEnricher();
    expect(enricher.shouldRun(createTestChatContext({}))).toBe(false);
    vi.mocked(orgSkillsAvailable).mockReturnValue(false);
    expect(enricher.shouldRun(createTestChatContext({ botId: 'agent' }))).toBe(
      false,
    );
  });
});

describe('persona skill scope (§5.4)', () => {
  const visible = (id: string, applyToAgents: boolean) => ({
    builtin: false,
    overridden: false,
    skill: {
      id,
      name: id,
      description: 'd',
      version: 1,
      activation: 'auto' as const,
      applyToAgents,
      documents: [],
      instructions: 'body',
      updatedAt: '',
    },
  });
  const persona = (
    skillAccess: 'inherit' | 'none' | 'selected',
    skillIds: string[] = [],
  ) => ({
    version: 1 as const,
    id: 'prompt-1',
    name: 'Persona',
    description: '',
    systemPrompt: 'Persona',
    modelId: 'gpt',
    skillAccess,
    skillIds,
    createdBy: 'a',
    createdAt: '',
    updatedBy: 'a',
    updatedAt: '',
  });
  beforeEach(() => {
    vi.mocked(getVisibleSkills).mockResolvedValue([
      visible('agent-ok', true),
      visible('plain', false),
    ]);
  });
  it('"none" switches skill tools off and tells the user why a request was dropped', async () => {
    const emitMarker = vi.fn();
    const context = {
      ...createTestChatContext({
        botId: 'prompt-1',
        systemPrompt: 'Persona',
        model: { supportsTools: true },
      }),
      promptAgent: persona('none'),
      forcedSkillIds: ['agent-ok'],
      emitMarker,
    };
    const result = await new AgentSkillEnricher().execute(context as never);
    expect(result.agentSkillsEnabled).toBe(false);
    expect(result.skillScope).toEqual({ mode: 'none' });
    expect(result.forcedSkillIds).toEqual([]);
    expect(emitMarker.mock.calls[0][0]).toContain('does not use skills');
  });
  it('"selected" offers the listed skills even without the per-skill agent flag', async () => {
    const context = {
      ...createTestChatContext({
        botId: 'prompt-1',
        systemPrompt: 'Persona',
        model: { supportsTools: true },
      }),
      promptAgent: persona('selected', ['plain']),
      forcedSkillIds: ['plain', 'agent-ok'],
    };
    const result = await new AgentSkillEnricher().execute(context as never);
    expect(result.agentSkillsEnabled).toBe(true);
    expect(result.skillScope).toEqual({ mode: 'selected', ids: ['plain'] });
    expect(result.forcedSkillIds).toEqual(['plain']);
  });
  it('a persona without a scope inherits the agent-enabled set', async () => {
    const context = {
      ...createTestChatContext({
        botId: 'prompt-1',
        systemPrompt: 'Persona',
        model: { supportsTools: true },
      }),
      promptAgent: persona('inherit'),
    };
    const result = await new AgentSkillEnricher().execute(context as never);
    expect(result.skillScope).toEqual({ mode: 'agent' });
    expect(result.agentSkillsEnabled).toBe(true);
  });
});
