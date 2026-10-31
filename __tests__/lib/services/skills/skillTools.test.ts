import { readSkill } from '@/lib/services/agentAccess/accessRulesStore';
import { uploadJson } from '@/lib/services/agentAccess/blobCas';
import { mintContinuationToken } from '@/lib/services/limits/continuationToken';
import {
  getVisibleSkills,
  orgSkillsAvailable,
} from '@/lib/services/skills/skillCatalog';
import { retrieveSkillReferences } from '@/lib/services/skills/skillReferences';
import {
  SKILL_SERVER_ID,
  createSkillToolExecutor,
  restoreAgentSkillState,
} from '@/lib/services/skills/skillTools';
import type { Skill } from '@/lib/services/skills/types';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/skills/skillCatalog', () => ({
  getVisibleSkills: vi.fn(),
  orgSkillsAvailable: vi.fn(() => true),
}));
vi.mock('@/lib/services/agentAccess/accessRulesStore', () => ({
  readSkill: vi.fn(),
  createAgentAccessBlobStorage: () => ({}),
}));
vi.mock('@/lib/services/skills/skillReferences', () => ({
  retrieveSkillReferences: vi.fn(),
}));
vi.mock('@/lib/services/agentAccess/blobCas', () => ({ uploadJson: vi.fn() }));
const skill: Skill = {
  id: 'gdpr',
  version: 1,
  name: 'GDPR',
  description: 'Data protection',
  instructions: 'Cite privacy policy',
  activation: 'auto',
  applyToAgents: true,
  documents: [],
  updatedAt: '',
};
const entry = (s: Skill) => ({ skill: s, builtin: false, overridden: false });
describe('agent skill executor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(orgSkillsAvailable).mockReturnValue(true);
    vi.mocked(getVisibleSkills).mockResolvedValue([
      entry(skill),
      entry({ ...skill, id: 'off-agent', applyToAgents: false }),
    ]);
    vi.mocked(readSkill).mockResolvedValue({ skill, etag: 'v1' });
    vi.mocked(retrieveSkillReferences).mockResolvedValue({
      text: 'Source evidence',
      citations: [],
      quoteSources: {},
      unavailable: [],
    });
  });
  it('lists only opted-in organization metadata, never bodies', async () => {
    const executor = (await createSkillToolExecutor({ userMail: 'user' }))!;
    const tools = await executor.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['load_skill']);
    expect(JSON.stringify(tools)).not.toContain('Cite privacy policy');
    expect(tools[0].inputSchema).toMatchObject({
      properties: { id: { enum: ['gdpr'] } },
    });
  });
  it('reserves load calls independently and refuses a fourth even in one parallel batch', async () => {
    const executor = (await createSkillToolExecutor({}))!;
    const calls = await Promise.all(
      Array.from({ length: 4 }, () =>
        executor.callTool('load_skill', { id: 'gdpr' }),
      ),
    );
    expect(calls.filter((call) => !call.isError)).toHaveLength(3);
    expect(calls[3].resultText).toMatch(/limit reached/);
  });
  it('refuses a revoked skill after listing and rejects personal references', async () => {
    const executor = (await createSkillToolExecutor({}))!;
    vi.mocked(readSkill).mockResolvedValue({
      skill: { ...skill, applyToAgents: false },
      etag: 'v2',
    });
    expect(
      (await executor.callTool('load_skill', { id: 'gdpr' })).isError,
    ).toBe(true);
    expect(
      (await executor.callTool('load_skill', { id: 'user:gdpr' })).isError,
    ).toBe(true);
  });
  it('preloads forced skills as tool results, without editing the persona', async () => {
    const executor = (await createSkillToolExecutor({ forcedIds: ['gdpr'] }))!;
    const preloads = await executor.preload!();
    expect(preloads[0].toolName).toBe('load_skill');
    expect(preloads[0].result.resultText).toContain('Cite privacy policy');
    expect(executor.continuationState!().loads).toBe(1);
  });
  it('requires loading before document search, then caps searches at four', async () => {
    const withDocs = {
      ...skill,
      documents: [
        {
          fileId: '11111111-1111-1111-1111-111111111111',
          filename: 'policy.md',
          sizeBytes: 4,
          indexStatus: 'indexed' as const,
          nextChunk: 1,
          embeddingDeployment: 'embed',
        },
      ],
    };
    vi.mocked(getVisibleSkills).mockResolvedValue([entry(withDocs)]);
    vi.mocked(readSkill).mockResolvedValue({ skill: withDocs, etag: 'v1' });
    const executor = (await createSkillToolExecutor({}))!;
    expect(
      (
        await executor.callTool('search_skill_documents', {
          id: 'gdpr',
          query: 'policy',
        })
      ).isError,
    ).toBe(true);
    await executor.callTool('load_skill', { id: 'gdpr' });
    expect((await executor.listTools()).map((tool) => tool.name)).toContain(
      'search_skill_documents',
    );
    for (let i = 0; i < 3; i++)
      expect(
        (
          await executor.callTool('search_skill_documents', {
            id: 'gdpr',
            query: 'policy',
          })
        ).isError,
      ).toBe(false);
    expect(
      (
        await executor.callTool('search_skill_documents', {
          id: 'gdpr',
          query: 'policy',
        })
      ).resultText,
    ).toMatch(/limit/);
  });
  it('preloaded inline references never consume an uncounted indexed search', async () => {
    const inline = {
      ...skill,
      documents: [
        {
          fileId: '11111111-1111-1111-1111-111111111111',
          filename: 'policy.md',
          sizeBytes: 4,
          indexStatus: 'inline' as const,
          nextChunk: 0,
        },
      ],
    };
    vi.mocked(readSkill).mockResolvedValue({ skill: inline, etag: 'v1' });
    const executor = (await createSkillToolExecutor({}))!;
    await executor.callTool('load_skill', { id: 'gdpr' });
    expect(vi.mocked(retrieveSkillReferences).mock.calls[0][4]).toBe(true);
  });
  it('withholds tools after three independent skill rounds', async () => {
    const executor = (await createSkillToolExecutor({}))!;
    for (let i = 0; i < 3; i++) executor.completeRound();
    expect(await executor.listTools()).toEqual([]);
    expect(
      (await executor.callTool('load_skill', { id: 'gdpr' })).isError,
    ).toBe(true);
  });
});

describe('signed skill continuation state', () => {
  it('splitting sibling approval cards cannot fork the same skill budget', async () => {
    vi.stubEnv('AUTH_SECRET', 'test-secret');
    const state = {
      loads: 1,
      searches: 0,
      loaded: ['gdpr'],
      rounds: 1,
      checkpoint: '11111111-1111-4111-8111-111111111111',
    };
    const a = mintContinuationToken('user', 'a', Date.now(), {
      [SKILL_SERVER_ID]: state,
    })!;
    const b = mintContinuationToken('user', 'b', Date.now(), {
      [SKILL_SERVER_ID]: state,
    })!;
    const claims = new Set<string>();
    vi.mocked(uploadJson).mockImplementation(async (_storage, path) => {
      if (claims.has(path)) throw new Error('Already claimed');
      claims.add(path);
      return '"etag"';
    });
    expect(
      (
        await restoreAgentSkillState('user', 1, [
          { id: 'a', continuationToken: a },
        ])
      ).loads,
    ).toBe(1);
    expect(
      (
        await restoreAgentSkillState('user', 1, [
          { id: 'b', continuationToken: b },
        ])
      ).loads,
    ).toBe(3);
    vi.mocked(uploadJson).mockReset();
    vi.unstubAllEnvs();
  });
  it('restores authenticated budgets, but unsigned or modified resumes are exhausted', async () => {
    vi.stubEnv('AUTH_SECRET', 'test-secret');
    const state = { loads: 2, searches: 3, loaded: ['gdpr'], rounds: 2 };
    const token = mintContinuationToken('user', 'approval', Date.now(), {
      [SKILL_SERVER_ID]: {
        ...state,
        checkpoint: '22222222-2222-4222-8222-222222222222',
      },
    })!;
    expect(
      await restoreAgentSkillState('user', 1, [
        { id: 'approval', continuationToken: token },
      ]),
    ).toEqual(state);
    expect(
      (
        await restoreAgentSkillState('other-user', 1, [
          { id: 'approval', continuationToken: token },
        ])
      ).loads,
    ).toBe(3);
    expect(
      (await restoreAgentSkillState('user', 1, [{ id: 'approval' }])).rounds,
    ).toBe(3);
    expect(await restoreAgentSkillState('user', 0, [])).toEqual({
      loads: 0,
      searches: 0,
      loaded: [],
      rounds: 0,
    });
    vi.unstubAllEnvs();
  });
  it('rejects a replayed or parallel skill continuation with an exhausted budget', async () => {
    vi.stubEnv('AUTH_SECRET', 'test-secret');
    const token = mintContinuationToken('user', 'approval', Date.now(), {
      [SKILL_SERVER_ID]: { loads: 1, searches: 0, loaded: ['gdpr'], rounds: 1 },
    })!;
    vi.mocked(uploadJson).mockRejectedValueOnce(new Error('Already claimed'));
    expect(
      (
        await restoreAgentSkillState('user', 1, [
          { id: 'approval', continuationToken: token },
        ])
      ).rounds,
    ).toBe(3);
    vi.unstubAllEnvs();
  });
});

describe('agent skill executor — user auto toggle', () => {
  const entry = (id: string, activation: 'auto' | 'always') => ({
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
      instructions: 'body',
      updatedAt: '',
    } as unknown as Skill,
  });
  beforeEach(() => {
    vi.mocked(orgSkillsAvailable).mockReturnValue(true);
    vi.mocked(getVisibleSkills).mockResolvedValue([
      entry('auto-only', 'auto'),
      entry('standing', 'always'),
      entry('requested', 'auto'),
    ]);
  });
  it('with auto off, the catalog holds only requested and admin-always skills', async () => {
    const executor = (await createSkillToolExecutor({
      autoEnabled: false,
      forcedIds: ['requested'],
    }))!;
    const [load] = await executor.listTools();
    expect(load.name).toBe('load_skill');
    const ids = (load.inputSchema as { properties: { id: { enum: string[] } } })
      .properties.id.enum;
    expect(ids.sort()).toEqual(['requested', 'standing']);
  });
  it('with auto off and nothing requested or standing, offers no skill tools at all', async () => {
    vi.mocked(getVisibleSkills).mockResolvedValue([entry('auto-only', 'auto')]);
    expect(await createSkillToolExecutor({ autoEnabled: false })).toBeNull();
  });
});

describe('skill executor — scopes, consent, and record output (§5.5/§5.6)', () => {
  const org = (id: string, overrides: Partial<Skill> = {}) => ({
    builtin: false,
    overridden: false,
    skill: {
      ...skill,
      id,
      name: id,
      instructions: `BODY OF ${id}`,
      ...overrides,
    } as Skill,
  });
  beforeEach(() => {
    vi.mocked(orgSkillsAvailable).mockReturnValue(true);
    vi.mocked(getVisibleSkills).mockResolvedValue([
      org('open'),
      org('careful', { requireConsent: true }),
      org('by-request', { activation: 'manual' }),
      org('no-agents', { applyToAgents: false }),
    ]);
    vi.mocked(readSkill).mockImplementation(async (_storage, id) => ({
      skill: {
        ...skill,
        id,
        name: id,
        instructions: `BODY OF ${id}`,
        applyToAgents: id !== 'no-agents',
        activation: id === 'by-request' ? 'manual' : 'auto',
        requireConsent: id === 'careful',
      } as Skill,
      etag: 'v1',
    }));
  });
  const enumOf = async (
    executor: NonNullable<Awaited<ReturnType<typeof createSkillToolExecutor>>>,
  ) => {
    const [load] = await executor.listTools();
    return (
      load.inputSchema as { properties: { id: { enum: string[] } } }
    ).properties.id.enum.sort();
  };

  it('standard scope advertises every visible non-manual skill plus personal skills, and loads a personal body', async () => {
    const executor = (await createSkillToolExecutor({
      scope: { mode: 'standard' },
      personalSkills: [
        {
          id: 'mine',
          name: 'Mine',
          description: 'd',
          activation: 'auto',
          instructions: 'PERSONAL BODY',
          enabled: true,
        },
      ],
    }))!;
    expect(await enumOf(executor)).toEqual([
      'careful',
      'no-agents',
      'open',
      'user:mine',
    ]);
    const result = await executor.callTool('load_skill', { id: 'user:mine' });
    expect(result.isError).toBe(false);
    expect(result.resultText).toContain('PERSONAL BODY');
    // Manual skills are never advertised, but an explicit request admits one.
    const forced = (await createSkillToolExecutor({
      scope: { mode: 'standard' },
      forcedIds: ['by-request'],
      excludeIds: ['open'],
    }))!;
    expect(await enumOf(forced)).toEqual([
      'by-request',
      'careful',
      'no-agents',
    ]);
  });

  it('selected scope offers exactly the persona list and refuses the rest at load time', async () => {
    const executor = (await createSkillToolExecutor({
      scope: { mode: 'selected', ids: ['no-agents'] },
    }))!;
    expect(await enumOf(executor)).toEqual(['no-agents']);
    expect(
      (await executor.callTool('load_skill', { id: 'no-agents' })).isError,
    ).toBe(false);
    expect(
      (await executor.callTool('load_skill', { id: 'open' })).isError,
    ).toBe(true);
    expect(
      await createSkillToolExecutor({ scope: { mode: 'none' } }),
    ).toBeNull();
  });

  it('consent-gated skills need approval unless requested, and are hidden where no approval is possible', async () => {
    const executor = (await createSkillToolExecutor({}))!;
    expect(executor.requiresApproval?.('load_skill', { id: 'careful' })).toBe(
      true,
    );
    expect(executor.requiresApproval?.('load_skill', { id: 'open' })).toBe(
      false,
    );
    expect(
      executor.requiresApproval?.('search_skill_documents', { query: 'x' }),
    ).toBe(false);
    const requested = (await createSkillToolExecutor({
      forcedIds: ['careful'],
    }))!;
    expect(requested.requiresApproval?.('load_skill', { id: 'careful' })).toBe(
      false,
    );
    const foundry = (await createSkillToolExecutor({
      consentSupported: false,
    }))!;
    expect(await enumOf(foundry)).toEqual(['open']);
    const foundryForced = (await createSkillToolExecutor({
      consentSupported: false,
      forcedIds: ['careful'],
    }))!;
    expect(await enumOf(foundryForced)).toEqual(['careful', 'open']);
  });

  it('record output summarizes a load without the instruction body', async () => {
    const executor = (await createSkillToolExecutor({}))!;
    const result = await executor.callTool('load_skill', { id: 'open' });
    const shown = executor.recordOutput!('load_skill', { id: 'open' }, result);
    expect(result.resultText).toContain('BODY OF open');
    expect(shown).not.toContain('BODY OF');
    expect(shown).toMatch(/open/);
  });
});
