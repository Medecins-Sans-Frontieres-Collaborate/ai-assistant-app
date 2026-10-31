/**
 * SkillEnricher (docs/SKILLS_DESIGN.md §9): 'always' + forced delivery into
 * the system prompt, the platform-help section swap, the explicit-use
 * visibility marker, the user's automatic-selection toggle, and the agent-path gate.
 *
 * The catalog module is mocked at its seam (feature gate + visible-catalog
 * read); resolveActiveSkills stays REAL so these tests exercise the actual
 * composition the pipeline runs.
 */
import { createTestChatContext } from '@/__tests__/lib/services/chat/testUtils';
import { readSkillHistoryVersion } from '@/lib/services/agentAccess/accessRulesStore';
import {
  SkillCatalogEnricher,
  SkillEnricher,
} from '@/lib/services/chat/enrichers/SkillEnricher';
import { getVisibleSkills } from '@/lib/services/skills/skillCatalog';
import { CatalogSkill, Skill } from '@/lib/services/skills/types';

import {
  PLATFORM_ABOUT_PROMPT_SECTION,
  PLATFORM_FEATURES_PROMPT_SECTION,
} from '@/lib/utils/app/systemPrompt';

import { Mock, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/skills/skillCatalog', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/skills/skillCatalog')>();
  return {
    ...actual,
    getVisibleSkills: vi.fn(async () => []),
  };
});

vi.mock('@/lib/services/agentAccess/accessRulesStore', () => ({
  createAgentAccessBlobStorage: () => ({}),
  readSkillHistoryVersion: vi.fn(async () => null),
}));

const mockGetVisibleSkills = getVisibleSkills as Mock;
const mockReadHistory = readSkillHistoryVersion as Mock;

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

function entry(overrides: Partial<Skill> & { id: string }): CatalogSkill {
  return { skill: makeSkill(overrides), builtin: false, overridden: false };
}

/** A base prompt shaped like the real one: platform sections mid-document. */
const BASE_PROMPT = [
  '# Core Behavior',
  '',
  'Intro.',
  '',
  PLATFORM_ABOUT_PROMPT_SECTION,
  '',
  PLATFORM_FEATURES_PROMPT_SECTION,
  '',
  '## Communication',
  '',
  'Be clear.',
].join('\n');

describe('SkillEnricher', () => {
  const enricher = new SkillEnricher();

  beforeEach(() => {
    mockGetVisibleSkills.mockResolvedValue([]);
  });

  describe('shouldRun', () => {
    it('runs on a standard turn when the feature is enabled', () => {
      expect(enricher.shouldRun(createTestChatContext({}))).toBe(true);
    });

    it('does not run on agent turns (botId)', () => {
      expect(
        enricher.shouldRun(createTestChatContext({ botId: 'prompt-abc' })),
      ).toBe(false);
    });

    it('does not run in Foundry agent mode', () => {
      const context = createTestChatContext({
        agentMode: true,
        model: { agentId: 'agent-1' },
      });
      expect(enricher.shouldRun(context)).toBe(false);
    });
  });

  describe('executeStage', () => {
    it('enforces an aggregate instruction budget without cutting instruction bodies in half', async () => {
      const visible = Array.from({ length: 5 }, (_, index) =>
        entry({
          id: `large-${index}`,
          activation: 'always',
          instructions: 'unique-token-'.repeat(1200),
        }),
      );
      mockGetVisibleSkills.mockResolvedValue(visible);
      const result = await enricher.execute(
        createTestChatContext({ systemPrompt: 'Core safety' }),
      );
      expect(result.skillTokensUsed).toBeLessThanOrEqual(12000);
      expect(result.activeSkills!.length).toBeLessThan(5);
      for (const active of result.activeSkills!)
        expect(result.systemPrompt).toContain(active.instructions);
      expect(result.systemPrompt).toContain('context budget');
    });
    it('does not deliver instructions revoked during a long tool run', async () => {
      mockGetVisibleSkills.mockResolvedValue([]);
      const result = await enricher.execute({
        ...createTestChatContext({ systemPrompt: BASE_PROMPT }),
        skillCatalog: [
          entry({
            id: 'revoked',
            instructions: 'Secret organization guidance',
          }),
        ],
        forcedSkillIds: ['revoked'],
      });
      expect(result.systemPrompt).not.toContain('Secret organization guidance');
    });
    it('prepares personal metadata without shadowing organization skills', async () => {
      mockGetVisibleSkills.mockResolvedValue([entry({ id: 'gdpr' })]);
      const result = await new SkillCatalogEnricher().execute({
        ...createTestChatContext({}),
        userSkills: [
          {
            id: 'gdpr',
            name: 'My GDPR',
            description: 'My preferences',
            instructions: 'Personal wording',
            activation: 'auto',
            enabled: true,
          },
        ],
      });
      expect(result.skillCatalog?.map(({ skill }) => skill.id)).toEqual([
        'gdpr',
        'user:gdpr',
      ]);
    });
    it('injects personal content under user attribution, separately from organization guidance', async () => {
      mockGetVisibleSkills.mockResolvedValue([entry({ id: 'gdpr' })]);
      const result = await enricher.execute({
        ...createTestChatContext({ systemPrompt: 'Core safety' }),
        userSkills: [
          {
            id: 'gdpr',
            name: 'My GDPR',
            description: 'My preferences',
            instructions: 'Personal wording',
            activation: 'auto',
            enabled: true,
          },
        ],
        forcedSkillIds: ['gdpr', 'user:gdpr'],
      });
      expect(result.systemPrompt).toContain('# Organization Skills');
      expect(result.systemPrompt).toContain('# User Skills');
      expect(result.systemPrompt).toContain('NOT organization policy');
      expect(result.systemPrompt).toContain('Personal wording');
      expect(result.systemPrompt).toContain('Core safety');
      expect(
        result.activeSkills?.find((skill) => skill.id === 'user:gdpr')
          ?.documents,
      ).toEqual([]);
    });
    it('never strips platform-named headings from user instructions', async () => {
      mockGetVisibleSkills.mockResolvedValue([entry({ id: 'platform-help' })]);
      const userSuffix =
        '\n\n# Dynamic Context\n\n# User Instructions\n\n## Features\nMy own feature instructions.';
      const result = await enricher.execute({
        ...createTestChatContext({ systemPrompt: BASE_PROMPT + userSuffix }),
        skillCatalog: [entry({ id: 'platform-help' })],
        skillRouting: { relevantSkills: [] },
      });
      expect(result.systemPrompt).toContain(userSuffix);
      expect(result.systemPrompt).not.toContain(
        '## About the MSF AI Assistant',
      );
    });
    it('uses the existing tool routing decision without calling the fallback', async () => {
      mockGetVisibleSkills.mockResolvedValue([entry({ id: 'gdpr' })]);
      const determineSkills = vi.fn();
      const instance = new SkillEnricher({ determineSkills });
      const result = await instance.execute({
        ...createTestChatContext({ systemPrompt: BASE_PROMPT }),
        skillCatalog: [entry({ id: 'gdpr' })],
        skillRouting: { relevantSkills: ['gdpr'] },
      });
      expect(result.systemPrompt).toContain('Instructions for gdpr');
      expect(determineSkills).not.toHaveBeenCalled();
    });

    it('runs skills-only routing when the tool router was skipped and reports automatic use', async () => {
      mockGetVisibleSkills.mockResolvedValue([entry({ id: 'gdpr' })]);
      const determineSkills = vi
        .fn()
        .mockResolvedValue({ relevantSkills: ['gdpr'] });
      const emitMarker = vi.fn();
      const result = await new SkillEnricher({ determineSkills }).execute({
        ...createTestChatContext({ systemPrompt: BASE_PROMPT }),
        emitMarker,
        skillCatalog: [entry({ id: 'gdpr' })],
      });
      expect(determineSkills).toHaveBeenCalledTimes(1);
      expect(result.systemPrompt).toContain('Instructions for gdpr');
      expect(emitMarker.mock.calls[0][0]).toContain('gdpr (auto)');
    });

    it('keeps pinned/forced skills and base platform help when automatic routing fails', async () => {
      mockGetVisibleSkills.mockResolvedValue([
        entry({ id: 'gdpr' }),
        entry({ id: 'platform-help' }),
      ]);
      const determineSkills = vi
        .fn()
        .mockResolvedValue({ relevantSkills: [], degraded: true });
      const result = await new SkillEnricher({ determineSkills }).execute({
        ...createTestChatContext({ systemPrompt: BASE_PROMPT }),
        skillCatalog: [entry({ id: 'gdpr' }), entry({ id: 'platform-help' })],
        forcedSkillIds: ['gdpr'],
        pinnedSkillIds: ['gdpr'],
      });
      expect(result.systemPrompt).toContain('Instructions for gdpr');
      expect(result.systemPrompt).toContain('## About the MSF AI Assistant');
      expect(result.skillRouting?.degraded).toBe(true);
    });

    it('does not retry a failed shared routing decision', async () => {
      const determineSkills = vi.fn();
      await new SkillEnricher({ determineSkills }).execute({
        ...createTestChatContext({ systemPrompt: BASE_PROMPT }),
        skillCatalog: [entry({ id: 'gdpr' })],
        skillRouting: { degraded: true, relevantSkills: [] },
      });
      expect(determineSkills).not.toHaveBeenCalled();
    });
    it('leaves the prompt untouched when nothing is visible', async () => {
      const context = createTestChatContext({ systemPrompt: BASE_PROMPT });
      const result = await enricher.execute(context);
      expect(result.systemPrompt).toBe(BASE_PROMPT);
      expect(result.errors).toHaveLength(0);
    });

    it('injects an always skill under the Organization Skills heading', async () => {
      mockGetVisibleSkills.mockResolvedValue([
        entry({ id: 'standing', name: 'Standing', activation: 'always' }),
      ]);
      const result = await enricher.execute(
        createTestChatContext({ systemPrompt: BASE_PROMPT }),
      );
      expect(result.systemPrompt).toContain('# Organization Skills');
      expect(result.systemPrompt).toContain('## Skill: Standing');
      expect(result.systemPrompt).toContain('Instructions for standing');
    });

    it('does not inject auto skills without a forced id (phase 1: no router)', async () => {
      mockGetVisibleSkills.mockResolvedValue([entry({ id: 'dormant' })]);
      const result = await enricher.execute(
        createTestChatContext({ systemPrompt: BASE_PROMPT }),
      );
      expect(result.systemPrompt).toBe(BASE_PROMPT);
    });

    it('injects a forced auto skill', async () => {
      mockGetVisibleSkills.mockResolvedValue([entry({ id: 'gdpr' })]);
      const context = {
        ...createTestChatContext({ systemPrompt: BASE_PROMPT }),
        forcedSkillIds: ['gdpr'],
      };
      const result = await enricher.execute(context);
      expect(result.systemPrompt).toContain('## Skill: gdpr');
    });

    it('swaps the platform sections out of the base prompt when platform-help is deliverable', async () => {
      mockGetVisibleSkills.mockResolvedValue([
        entry({
          id: 'platform-help',
          name: 'Platform Help',
          activation: 'always',
          instructions: `${PLATFORM_ABOUT_PROMPT_SECTION}\n\n${PLATFORM_FEATURES_PROMPT_SECTION}`,
        }),
      ]);
      const result = await enricher.execute(
        createTestChatContext({ systemPrompt: BASE_PROMPT }),
      );
      // The content appears exactly once: carried by the skill, removed from
      // the base prompt body.
      const aboutMatches = result.systemPrompt.split(
        '## About the MSF AI Assistant',
      ).length;
      expect(aboutMatches).toBe(2); // one occurrence → two split parts
      expect(result.systemPrompt).toContain('## Skill: Platform Help');
      // The rest of the base prompt survives intact
      expect(result.systemPrompt).toContain('## Communication');
      expect(result.systemPrompt).toContain('Be clear.');
    });

    it('keeps the base sections when platform-help is not visible', async () => {
      mockGetVisibleSkills.mockResolvedValue([entry({ id: 'other' })]);
      const result = await enricher.execute(
        createTestChatContext({ systemPrompt: BASE_PROMPT }),
      );
      expect(result.systemPrompt).toContain('## About the MSF AI Assistant');
    });

    it('emits a marker for explicit use, including dropped ids', async () => {
      mockGetVisibleSkills.mockResolvedValue([
        entry({ id: 'gdpr', name: 'GDPR Guidance' }),
      ]);
      const markers: string[] = [];
      const context = {
        ...createTestChatContext({
          systemPrompt: BASE_PROMPT,
          emitMarker: async (marker: string) => {
            markers.push(marker);
          },
        }),
        forcedSkillIds: ['gdpr', 'missing'],
      };
      const result = await enricher.execute(context);
      expect(result.errors).toHaveLength(0);
      expect(markers).toHaveLength(1);
      expect(markers[0]).toContain('GDPR Guidance (requested)');
      expect(markers[0]).toContain('missing (unavailable)');
      expect(markers[0]).toContain('incomplete');
    });

    it('emits NO marker when only always skills activate', async () => {
      mockGetVisibleSkills.mockResolvedValue([
        entry({ id: 'standing', activation: 'always' }),
      ]);
      const markers: string[] = [];
      const context = createTestChatContext({
        systemPrompt: BASE_PROMPT,
        emitMarker: async (marker: string) => {
          markers.push(marker);
        },
      });
      await enricher.execute(context);
      expect(markers).toHaveLength(0);
    });

    it('degrades to an unchanged prompt when the catalog read fails', async () => {
      mockGetVisibleSkills.mockRejectedValue(new Error('storage down'));
      const result = await enricher.execute(
        createTestChatContext({ systemPrompt: BASE_PROMPT }),
      );
      expect(result.systemPrompt).toBe(BASE_PROMPT);
      expect(result.errors).toHaveLength(1);
    });
  });

  describe('user toggle (skillsAuto: false)', () => {
    it('skips automatic selection and personal skills but keeps requested and always skills', async () => {
      mockGetVisibleSkills.mockResolvedValue([
        entry({ id: 'gdpr' }),
        entry({ id: 'house-style', activation: 'always' }),
        entry({ id: 'platform-help' }),
      ]);
      const determineSkills = vi.fn();
      const result = await new SkillEnricher({ determineSkills }).execute({
        ...createTestChatContext({ systemPrompt: BASE_PROMPT }),
        emitMarker: vi.fn(),
        skillsAuto: false,
        forcedSkillIds: ['gdpr', 'user:report'],
        userSkills: [
          {
            id: 'report',
            name: 'Report',
            description: 'd',
            instructions: 'Personal instructions',
            activation: 'auto',
            enabled: true,
          },
        ],
      });
      expect(determineSkills).not.toHaveBeenCalled();
      expect(result.systemPrompt).toContain('Instructions for gdpr');
      expect(result.systemPrompt).toContain('Instructions for house-style');
      expect(result.systemPrompt).not.toContain('Personal instructions');
      // The platform sections stay: platform-help can no longer be routed in.
      expect(result.systemPrompt).toContain(PLATFORM_ABOUT_PROMPT_SECTION);
      expect(result.activeSkills?.map((skill) => skill.id)).toEqual([
        'gdpr',
        'house-style',
      ]);
    });

    it('still swaps the platform sections when platform-help is requested explicitly', async () => {
      mockGetVisibleSkills.mockResolvedValue([entry({ id: 'platform-help' })]);
      const result = await new SkillEnricher().execute({
        ...createTestChatContext({ systemPrompt: BASE_PROMPT }),
        emitMarker: vi.fn(),
        skillsAuto: false,
        forcedSkillIds: ['platform-help'],
      });
      expect(result.systemPrompt).not.toContain(PLATFORM_ABOUT_PROMPT_SECTION);
      expect(result.systemPrompt).toContain('Instructions for platform-help');
    });

    it('gives the router an empty catalog when automatic selection is off', async () => {
      mockGetVisibleSkills.mockResolvedValue([entry({ id: 'gdpr' })]);
      const result = await new SkillCatalogEnricher().execute({
        ...createTestChatContext({}),
        skillsAuto: false,
      });
      expect(result.skillCatalog).toEqual([]);
    });
  });
});

describe('tools delivery (§5.6): the model loads skills itself', () => {
  beforeEach(() => {
    mockGetVisibleSkills.mockResolvedValue([
      entry({ id: 'alpha' }),
      entry({ id: 'beta' }),
      entry({ id: 'standing', activation: 'always' }),
    ]);
    mockReadHistory.mockResolvedValue(null);
  });
  it('skips the router, injects only forced and always skills, and excludes them from the tool catalog', async () => {
    const router = { determineSkills: vi.fn() };
    const emitMarker = vi.fn();
    const context = {
      ...createTestChatContext({
        systemPrompt: BASE_PROMPT,
        model: { supportsTools: true },
      }),
      forcedSkillIds: ['alpha'],
      emitMarker,
    };
    const prepared = await new SkillCatalogEnricher().execute(context);
    expect(prepared.skillCatalog).toEqual([]);
    const result = await new SkillEnricher(router).execute(prepared);
    expect(router.determineSkills).not.toHaveBeenCalled();
    expect(result.systemPrompt).toContain('Instructions for alpha');
    expect(result.systemPrompt).toContain('Instructions for standing');
    expect(result.systemPrompt).not.toContain('Instructions for beta');
    expect(result.standardSkillTools?.excludeIds.sort()).toEqual([
      'alpha',
      'standing',
    ]);
    // Platform sections leave the base prompt: the model can load the skill.
    mockGetVisibleSkills.mockResolvedValue([entry({ id: 'platform-help' })]);
    const swapped = await new SkillEnricher(router).execute(
      createTestChatContext({
        systemPrompt: BASE_PROMPT,
        model: { supportsTools: true },
      }),
    );
    expect(swapped.systemPrompt).not.toContain(PLATFORM_ABOUT_PROMPT_SECTION);
  });
  it('falls back to prompt delivery for non-tool models, non-streaming turns, and custom sources', async () => {
    const router = {
      determineSkills: vi.fn(async () => ({ relevantSkills: ['beta'] })),
    };
    for (const options of [
      { model: { supportsTools: false } },
      { model: { supportsTools: true }, stream: false },
      { model: { supportsTools: true, isCustomSourceModel: true } },
    ]) {
      router.determineSkills.mockClear();
      const context = createTestChatContext({
        systemPrompt: BASE_PROMPT,
        ...options,
      } as never);
      const prepared = await new SkillCatalogEnricher().execute(context);
      const result = await new SkillEnricher(router).execute(prepared);
      expect(router.determineSkills).toHaveBeenCalledTimes(1);
      expect(result.systemPrompt).toContain('Instructions for beta');
      expect(result.standardSkillTools).toBeUndefined();
    }
  });
});

describe('consent (§5.5) and version pins (§5.7)', () => {
  beforeEach(() => {
    mockGetVisibleSkills.mockResolvedValue([
      entry({ id: 'careful', requireConsent: true }),
      entry({ id: 'gdpr', updatedAt: '2026-10-30T00:00:00.000Z' }),
    ]);
    mockReadHistory.mockResolvedValue(null);
  });
  it('a routed consent-gated skill is reported, not applied; a requested one applies', async () => {
    const router = {
      determineSkills: vi.fn(async () => ({ relevantSkills: ['careful'] })),
    };
    const emitMarker = vi.fn();
    const base = createTestChatContext({
      systemPrompt: BASE_PROMPT,
      model: { supportsTools: false },
    });
    const routed = await new SkillEnricher(router).execute({
      ...(await new SkillCatalogEnricher().execute(base)),
      emitMarker,
    });
    expect(routed.systemPrompt).not.toContain('Instructions for careful');
    expect(emitMarker.mock.calls[0][0]).toContain('careful (needs approval)');

    emitMarker.mockClear();
    const requested = await new SkillEnricher(router).execute({
      ...(await new SkillCatalogEnricher().execute(base)),
      forcedSkillIds: ['careful'],
      emitMarker,
    });
    expect(requested.systemPrompt).toContain('Instructions for careful');
    expect(emitMarker.mock.calls[0][0]).toContain('careful (requested)');
  });
  it('replays the pinned historical body when it exists, else the current one with a note', async () => {
    mockReadHistory.mockResolvedValue(
      makeSkill({
        id: 'gdpr',
        instructions: 'OLD GDPR BODY',
        updatedAt: '2026-10-01T00:00:00.000Z',
      }),
    );
    const emitMarker = vi.fn();
    const base = createTestChatContext({
      systemPrompt: BASE_PROMPT,
      model: { supportsTools: false },
    });
    const pinned = await new SkillEnricher().execute({
      ...base,
      forcedSkillIds: ['gdpr'],
      skillVersions: { gdpr: '2026-10-01T00:00:00.000Z' },
      emitMarker,
    });
    expect(pinned.systemPrompt).toContain('OLD GDPR BODY');
    expect(pinned.systemPrompt).not.toContain('Instructions for gdpr');
    const marker = emitMarker.mock.calls[0][0] as string;
    expect(marker).toContain('gdpr (requested, as originally run)');
    expect(marker).toContain('2026-10-01T00:00:00.000Z');
    expect(mockReadHistory.mock.calls[0].slice(1, 3)).toEqual([
      'gdpr',
      '2026-10-01T00:00:00.000Z',
    ]);

    mockReadHistory.mockResolvedValue(null);
    emitMarker.mockClear();
    const current = await new SkillEnricher().execute({
      ...base,
      forcedSkillIds: ['gdpr'],
      skillVersions: { gdpr: '2026-10-01T00:00:00.000Z' },
      emitMarker,
    });
    expect(current.systemPrompt).toContain('Instructions for gdpr');
    expect(emitMarker.mock.calls[0][0]).toContain(
      'gdpr (requested, updated since)',
    );
    // A pin equal to the current version is a no-op: no history read.
    mockReadHistory.mockClear();
    await new SkillEnricher().execute({
      ...base,
      forcedSkillIds: ['gdpr'],
      skillVersions: { gdpr: '2026-10-30T00:00:00.000Z' },
      emitMarker,
    });
    expect(mockReadHistory).not.toHaveBeenCalled();
  });
});
