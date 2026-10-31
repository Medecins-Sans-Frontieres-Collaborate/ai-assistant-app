/**
 * Skill source sync (docs/SKILLS_DESIGN.md §12): URL/path safety, import,
 * admin-flag preservation, conflicts, and unchanged-version skips.
 */
import {
  readSkill,
  writeSkill,
  writeSkillHistoryEntry,
} from '@/lib/services/agentAccess/accessRulesStore';
import {
  mutateSkillSource,
  readSkillSources,
} from '@/lib/services/skills/skillSourceStore';
import {
  autoSyncSkillSources,
  resolveSourceFile,
  syncSkillSource,
  validateSourceUrl,
} from '@/lib/services/skills/skillSourceSync';
import type { Skill, SkillSource } from '@/lib/services/skills/types';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/agentAccess/accessRulesStore', () => ({
  createAgentAccessBlobStorage: () => ({}),
  readSkill: vi.fn(),
  writeSkill: vi.fn(async () => '"etag"'),
  writeSkillHistoryEntry: vi.fn(async () => undefined),
}));
vi.mock('@/lib/services/skills/skillSourceStore', () => ({
  mutateSkillSource: vi.fn(),
  readSkillSources: vi.fn(),
}));
vi.mock('@/lib/utils/server/net/publicUrlGuard', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/lib/utils/server/net/publicUrlGuard')
    >();
  return {
    ...actual,
    // DNS/private-range checks are covered by the guard's own tests.
    fetchPublicUrl: vi.fn(
      async (url: string, options: { fetchImpl?: typeof fetch }) => ({
        response: await (options.fetchImpl ?? fetch)(url),
        resolvedUrl: url,
      }),
    ),
  };
});

const INDEX = 'https://skills.example.org/catalog/index.json';
const source = (): SkillSource => ({
  id: '11111111-1111-4111-8111-111111111111',
  url: INDEX,
  addedBy: 'admin',
  addedAt: '2026-10-30T00:00:00.000Z',
  entries: [],
});

function fakeFetch(files: Record<string, string | number>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const body = files[url];
    if (body === undefined) return new Response('nope', { status: 404 });
    if (typeof body === 'number') return new Response('err', { status: body });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
}

const SKILL_MD = (name: string, body = 'Follow the policy.') =>
  `---\nname: ${name}\ndescription: Guidance for ${name}\n---\n\n${body}\n`;

describe('source URL and file resolution safety', () => {
  it('accepts only https URLs without credentials', () => {
    expect(validateSourceUrl(INDEX).href).toBe(INDEX);
    expect(() => validateSourceUrl('http://example.org/index.json')).toThrow(
      /https/,
    );
    expect(() => validateSourceUrl('https://u:p@example.org/i.json')).toThrow(
      /credentials/,
    );
    expect(() => validateSourceUrl('not a url')).toThrow();
  });
  it('resolves files under the index directory on the same origin only', () => {
    const index = new URL(INDEX);
    expect(resolveSourceFile(index, 'gdpr', 'SKILL.md').href).toBe(
      'https://skills.example.org/catalog/gdpr/SKILL.md',
    );
    expect(() => resolveSourceFile(index, 'gdpr', '../../etc')).toThrow();
    expect(() => resolveSourceFile(index, 'gdpr', '/abs/SKILL.md')).toThrow();
    expect(() =>
      resolveSourceFile(index, 'gdpr', 'https://evil.example/SKILL.md'),
    ).toThrow();
  });
});

describe('syncSkillSource', () => {
  let current: SkillSource;
  beforeEach(() => {
    vi.clearAllMocks();
    current = source();
    vi.mocked(mutateSkillSource).mockImplementation(
      async (_storage, _id, update) => {
        current = update(current);
        return current;
      },
    );
    vi.mocked(readSkill).mockResolvedValue(null);
  });

  it('imports SKILL.md entries as sourced org skills and records the outcome', async () => {
    const fetchImpl = fakeFetch({
      [INDEX]: JSON.stringify({
        skills: [
          {
            name: 'gdpr',
            version: '1.0.0',
            files: ['SKILL.md', 'references/a.md'],
          },
          { name: 'Bad Name', files: ['SKILL.md'] },
          { name: 'no-md', files: ['README.md'] },
          { name: 'mismatch', files: ['SKILL.md'] },
          { name: 'platform-help', files: ['SKILL.md'] },
        ],
      }),
      'https://skills.example.org/catalog/gdpr/SKILL.md': SKILL_MD('gdpr'),
      'https://skills.example.org/catalog/mismatch/SKILL.md': SKILL_MD('other'),
    });
    const { source: result } = await syncSkillSource({} as never, current.id, {
      fetchImpl,
      actor: 'admin@example.org',
    });
    expect(result?.lastSyncStatus).toBe('ok');
    expect(result?.syncLeaseUntil).toBeUndefined();
    const byId = Object.fromEntries(
      (result?.entries ?? []).map((entry) => [entry.id, entry.status]),
    );
    expect(byId).toEqual({
      gdpr: 'synced',
      'Bad Name': 'invalid',
      'no-md': 'invalid',
      mismatch: 'invalid',
      'platform-help': 'conflict',
    });
    expect(writeSkill).toHaveBeenCalledTimes(1);
    const written = vi.mocked(writeSkill).mock.calls[0][1] as Skill;
    expect(written).toMatchObject({
      id: 'gdpr',
      instructions: 'Follow the policy.',
      source: { sourceId: current.id, version: '1.0.0' },
      updatedBy: 'admin@example.org',
      activation: 'auto',
    });
    expect(vi.mocked(writeSkill).mock.calls[0][2]).toBeNull();
    expect(writeSkillHistoryEntry).toHaveBeenCalledTimes(1);
    expect(
      result?.entries.find((entry) => entry.id === 'gdpr')?.detail,
    ).toMatch(/reference file/);
  });

  it('clamps a new sourced skill: never always, never agent-enabled, consent honoured', async () => {
    const fetchImpl = fakeFetch({
      [INDEX]: JSON.stringify({
        skills: [{ name: 'loud', files: ['SKILL.md'] }],
      }),
      'https://skills.example.org/catalog/loud/SKILL.md': `---\nname: loud\ndescription: d\nmetadata:\n  msf-activation: always\n  msf-apply-to-agents: "true"\n  msf-require-consent: "true"\n---\n\nBody.\n`,
    });
    await syncSkillSource({} as never, current.id, { fetchImpl });
    const written = vi.mocked(writeSkill).mock.calls[0][1] as Skill;
    expect(written).toMatchObject({
      activation: 'auto',
      applyToAgents: false,
      requireConsent: true,
    });
  });

  it('rejects a SKILL.md that redirects off the source origin', async () => {
    const { fetchPublicUrl } =
      await import('@/lib/utils/server/net/publicUrlGuard');
    vi.mocked(fetchPublicUrl).mockImplementationOnce(async (url, options) => ({
      response: await (options?.fetchImpl ?? fetch)(url),
      resolvedUrl: url,
    }));
    vi.mocked(fetchPublicUrl).mockImplementationOnce(async (url, options) => ({
      response: await (options?.fetchImpl ?? fetch)(url),
      resolvedUrl: 'https://evil.example/x/SKILL.md',
    }));
    const fetchImpl = fakeFetch({
      [INDEX]: JSON.stringify({
        skills: [{ name: 'gdpr', files: ['SKILL.md'] }],
      }),
      'https://skills.example.org/catalog/gdpr/SKILL.md': SKILL_MD('gdpr'),
    });
    const { source: result } = await syncSkillSource({} as never, current.id, {
      fetchImpl,
    });
    expect(result?.entries[0]).toMatchObject({ id: 'gdpr', status: 'invalid' });
    expect(result?.entries[0].detail).toMatch(/origin/);
    expect(writeSkill).not.toHaveBeenCalled();
  });

  it('never overwrites an admin-created or foreign-sourced skill', async () => {
    vi.mocked(readSkill).mockImplementation(async (_s, id) => ({
      skill: {
        version: 1,
        id,
        name: id,
        description: 'd',
        instructions: 'ADMIN BODY',
        activation: 'always',
        applyToAgents: true,
        documents: [],
        updatedAt: 'x',
        ...(id === 'foreign'
          ? { source: { sourceId: 'other-source', syncedAt: 'x' } }
          : {}),
      } as Skill,
      etag: '"e"',
    }));
    const fetchImpl = fakeFetch({
      [INDEX]: JSON.stringify({
        skills: [
          { name: 'mine', files: ['SKILL.md'] },
          { name: 'foreign', files: ['SKILL.md'] },
        ],
      }),
      'https://skills.example.org/catalog/mine/SKILL.md': SKILL_MD('mine'),
      'https://skills.example.org/catalog/foreign/SKILL.md':
        SKILL_MD('foreign'),
    });
    const { source: result } = await syncSkillSource({} as never, current.id, {
      fetchImpl,
    });
    expect(result?.entries.map((entry) => entry.status)).toEqual([
      'conflict',
      'conflict',
    ]);
    expect(writeSkill).not.toHaveBeenCalled();
  });

  it('refreshes its own skills keeping admin flags, and skips unchanged versions without fetching', async () => {
    current = {
      ...current,
      entries: [{ id: 'gdpr', version: '1.0.0', status: 'synced' }],
    };
    vi.mocked(readSkill).mockResolvedValue({
      skill: {
        version: 1,
        id: 'gdpr',
        name: 'Old',
        description: 'old',
        instructions: 'OLD',
        activation: 'always',
        applyToAgents: true,
        requireConsent: true,
        documents: [],
        createdBy: 'source:x',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        source: { sourceId: current.id, version: '1.0.0', syncedAt: 'x' },
      } as Skill,
      etag: '"e1"',
    });
    const unchanged = fakeFetch({
      [INDEX]: JSON.stringify({
        skills: [{ name: 'gdpr', version: '1.0.0', files: ['SKILL.md'] }],
      }),
    });
    await syncSkillSource({} as never, current.id, { fetchImpl: unchanged });
    expect(writeSkill).not.toHaveBeenCalled();
    expect(unchanged).toHaveBeenCalledTimes(1);

    // Same content refetched (force) → still no write, no updatedAt bump.
    const identical = fakeFetch({
      [INDEX]: JSON.stringify({
        skills: [{ name: 'gdpr', version: '1.0.0', files: ['SKILL.md'] }],
      }),
      'https://skills.example.org/catalog/gdpr/SKILL.md': `---\nname: gdpr\ndescription: old\n---\n\nOLD\n`,
    });
    vi.mocked(readSkill).mockResolvedValueOnce({
      skill: {
        version: 1,
        id: 'gdpr',
        name: 'Gdpr',
        description: 'old',
        instructions: 'OLD',
        activation: 'always',
        applyToAgents: true,
        documents: [],
        updatedAt: 'x',
        source: { sourceId: current.id, version: '1.0.0', syncedAt: 'x' },
      } as Skill,
      etag: '"e1"',
    });
    await syncSkillSource({} as never, current.id, {
      fetchImpl: identical,
      force: true,
    });
    expect(writeSkill).not.toHaveBeenCalled();

    const bumped = fakeFetch({
      [INDEX]: JSON.stringify({
        skills: [{ name: 'gdpr', version: '1.1.0', files: ['SKILL.md'] }],
      }),
      'https://skills.example.org/catalog/gdpr/SKILL.md': SKILL_MD(
        'gdpr',
        'NEW BODY',
      ),
    });
    await syncSkillSource({} as never, current.id, { fetchImpl: bumped });
    const written = vi.mocked(writeSkill).mock.calls[0][1] as Skill;
    expect(written).toMatchObject({
      instructions: 'NEW BODY',
      activation: 'always',
      applyToAgents: true,
      requireConsent: true,
      createdBy: 'source:x',
      source: { version: '1.1.0' },
    });
    expect(vi.mocked(writeSkill).mock.calls[0][2]).toBe('"e1"');
  });

  it('a failed index fetch records the error and keeps the previous entries', async () => {
    current = {
      ...current,
      entries: [{ id: 'gdpr', version: '1.0.0', status: 'synced' }],
    };
    const { source: result } = await syncSkillSource({} as never, current.id, {
      fetchImpl: fakeFetch({ [INDEX]: 500 }),
    });
    expect(result?.lastSyncStatus).toBe('error');
    expect(result?.lastError).toMatch(/500/);
    expect(result?.entries).toHaveLength(1);
  });

  it('respects a live lease held by another replica', async () => {
    current = { ...current, syncLeaseUntil: Date.now() + 60_000 };
    const fetchImpl = fakeFetch({});
    const result = await syncSkillSource({} as never, current.id, {
      fetchImpl,
    });
    expect(result.busy).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('autoSyncSkillSources', () => {
  it('syncs one due source per call and leaves fresh ones alone', async () => {
    const fresh = {
      ...source(),
      id: '22222222-2222-4222-8222-222222222222',
      lastSyncAt: new Date().toISOString(),
    };
    const due = { ...source(), lastSyncAt: '2026-01-01T00:00:00.000Z' };
    vi.mocked(readSkillSources).mockResolvedValue({
      document: { version: 1, sources: [fresh, due] },
      etag: '"x"',
    });
    let leased: string | undefined;
    vi.mocked(mutateSkillSource).mockImplementation(async (_s, id, update) => {
      leased = id;
      return update(due);
    });
    vi.mocked(readSkill).mockResolvedValue(null);
    await autoSyncSkillSources({} as never);
    expect(leased).toBe(due.id);
  });
});
