import { NextRequest } from 'next/server';

import { writeSkill } from '@/lib/services/agentAccess/accessRulesStore';
import { AgentAccessConflictError } from '@/lib/services/agentAccess/blobCas';
import { authorizeSkillDocuments } from '@/lib/services/skills/skillDocumentAuth';
import {
  discardSkillFiles,
  storeSkillFiles,
} from '@/lib/services/skills/skillDocumentStore';
import type { Skill } from '@/lib/services/skills/types';

import {
  DELETE,
  POST,
} from '@/app/api/agent-access/skills/[id]/documents/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/skills/skillDocumentAuth', () => ({
  authorizeSkillDocuments: vi.fn(),
}));
vi.mock('@/lib/services/skills/skillDocumentStore', () => ({
  discardSkillFiles: vi.fn(),
  storeSkillFiles: vi.fn(),
  readSkillOriginal: vi.fn(),
}));
vi.mock('@/lib/services/skills/skillSearch', () => ({
  deleteSkillChunks: vi.fn(),
}));
vi.mock('@/lib/services/agentAccess/accessRulesStore', () => ({
  writeSkill: vi.fn(),
  writeSkillHistoryEntry: vi.fn(),
}));
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: { getInstance: () => ({ invalidate: vi.fn() }) },
}));

const doc = {
  fileId: '11111111-1111-1111-1111-111111111111',
  filename: 'a.md',
  sizeBytes: 1,
  indexStatus: 'pending' as const,
  nextChunk: 0,
};
const skill: Skill = {
  id: 'gdpr',
  version: 1,
  name: 'GDPR',
  description: 'd',
  instructions: 'i',
  activation: 'auto',
  applyToAgents: false,
  documents: [],
  updatedAt: '',
};
const context = { params: Promise.resolve({ id: 'gdpr' }) };
const request = (etag = '"v1"') => {
  const form = new FormData();
  form.append('files', new File(['a'], 'a.md'));
  return new NextRequest(
    'http://localhost/api/agent-access/skills/gdpr/documents',
    { method: 'POST', headers: { 'if-match': etag }, body: form },
  );
};

describe('skill resource mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authorizeSkillDocuments).mockResolvedValue({
      storage: {},
      skill,
      etag: '"v1"',
      userMail: 'admin',
    } as never);
    vi.mocked(storeSkillFiles).mockResolvedValue([doc]);
    vi.mocked(writeSkill).mockResolvedValue('"v2"');
  });
  it('publishes uploaded resources in a CAS-protected manifest', async () => {
    expect((await POST(request(), context)).status).toBe(200);
    expect(vi.mocked(writeSkill).mock.calls[0][1].documents).toEqual([doc]);
  });
  it('rejects stale editors before writing originals', async () => {
    expect((await POST(request('"stale"'), context)).status).toBe(409);
    expect(storeSkillFiles).not.toHaveBeenCalled();
  });
  it('cleans unreferenced originals if a concurrent edit wins the publish CAS', async () => {
    vi.mocked(writeSkill).mockRejectedValueOnce(new AgentAccessConflictError());
    expect((await POST(request(), context)).status).toBe(409);
    expect(discardSkillFiles).toHaveBeenCalledWith({}, 'gdpr', [doc]);
  });
  it('removes a reference from the manifest before blob cleanup', async () => {
    vi.mocked(authorizeSkillDocuments).mockResolvedValue({
      storage: {},
      skill: { ...skill, documents: [doc] },
      etag: '"v1"',
      userMail: 'admin',
    } as never);
    const req = new NextRequest(
      `http://localhost/api/agent-access/skills/gdpr/documents?fileId=${doc.fileId}`,
      { method: 'DELETE', headers: { 'if-match': '"v1"' } },
    );
    expect((await DELETE(req, context)).status).toBe(200);
    expect(vi.mocked(writeSkill).mock.calls[0][1].documents).toEqual([]);
    expect(vi.mocked(writeSkill).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(discardSkillFiles).mock.invocationCallOrder[0],
    );
  });
});
