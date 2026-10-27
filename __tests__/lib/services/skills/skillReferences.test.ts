import { readSkill } from '@/lib/services/agentAccess/accessRulesStore';
import { readPreparedSkillDocument } from '@/lib/services/skills/skillDocumentStore';
import { retrieveSkillReferences } from '@/lib/services/skills/skillReferences';
import { searchSkillChunks } from '@/lib/services/skills/skillSearch';
import type { Skill } from '@/lib/services/skills/types';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/agentAccess/accessRulesStore', () => ({
  createAgentAccessBlobStorage: vi.fn(() => ({})),
  readSkill: vi.fn(),
}));
vi.mock('@/lib/services/skills/skillDocumentStore', () => ({
  readPreparedSkillDocument: vi.fn(),
}));
vi.mock('@/lib/services/skills/skillSearch', () => ({
  searchSkillChunks: vi.fn(async () => []),
}));
vi.mock('@/lib/utils/server/tiktoken/tiktokenCache', () => ({
  countTokens: vi.fn(async (text: string) => text.length),
}));

const document = {
  fileId: '11111111-1111-1111-1111-111111111111',
  filename: 'policy.md',
  resourcePath: 'references/policy.md',
  sizeBytes: 100,
  indexStatus: 'inline' as const,
  nextChunk: 0,
};
const skill: Skill = {
  version: 1,
  id: 'gdpr',
  name: 'GDPR',
  description: 'Privacy',
  instructions: 'Cite sources',
  activation: 'auto',
  applyToAgents: false,
  updatedAt: '',
  documents: [document],
};
describe('skill evidence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readSkill).mockResolvedValue({ skill, etag: 'v1' });
    vi.mocked(readPreparedSkillDocument).mockResolvedValue({
      text: 'Retention is 30 days.',
      tokens: 10,
      chunks: [],
    });
  });
  it('continues existing web citation numbering and records verifiable passages', async () => {
    const existing = [
      { number: 4, title: 'Web', url: 'https://example.test', date: '' },
    ];
    const result = await retrieveSkillReferences(
      [skill],
      'retention?',
      existing,
    );
    expect(result.citations[0].number).toBe(5);
    expect(result.citations[0].url).toBe(
      `/api/skills/gdpr/documents/${document.fileId}`,
    );
    expect(result.quoteSources).toEqual({ '5': 'Retention is 30 days.' });
    expect(result.text).toContain('Source 5');
    expect(searchSkillChunks).not.toHaveBeenCalled();
    expect(existing).toHaveLength(1);
  });
  it('does not expose a document removed from the current manifest', async () => {
    vi.mocked(readSkill).mockResolvedValue({
      skill: { ...skill, documents: [] },
      etag: 'v2',
    });
    expect(
      (await retrieveSkillReferences([skill], 'policy', [])).citations,
    ).toEqual([]);
    expect(readPreparedSkillDocument).not.toHaveBeenCalled();
  });
  it('retains inline evidence when the indexed search fails', async () => {
    const mixed: Skill = {
      ...skill,
      documents: [
        document,
        {
          ...document,
          fileId: '22222222-2222-2222-2222-222222222222',
          indexStatus: 'indexed',
          embeddingDeployment: 'embed',
        },
      ],
    };
    vi.mocked(readSkill).mockResolvedValue({ skill: mixed, etag: 'v2' });
    vi.mocked(searchSkillChunks).mockRejectedValueOnce(
      new Error('Search down'),
    );
    const result = await retrieveSkillReferences([mixed], 'policy', []);
    expect(result.citations).toHaveLength(1);
    expect(result.unavailable).toContain('GDPR');
  });
  it('omits inactive skills rather than reading their resources', async () => {
    vi.mocked(readSkill).mockResolvedValue({
      skill: { ...skill, activation: 'off' },
      etag: 'v2',
    });
    const result = await retrieveSkillReferences([skill], 'policy', []);
    expect(result.citations).toEqual([]);
    expect(readPreparedSkillDocument).not.toHaveBeenCalled();
  });
});
