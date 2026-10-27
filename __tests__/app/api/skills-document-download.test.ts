import { NextRequest } from 'next/server';

import { readSkill } from '@/lib/services/agentAccess/accessRulesStore';
import { readSkillOriginal } from '@/lib/services/skills/skillDocumentStore';

import { GET } from '@/app/api/skills/[id]/documents/[fileId]/route';
import { auth } from '@/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const access = vi.hoisted(() => vi.fn());
vi.mock('@/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/services/skills/skillCatalog', () => ({
  skillsFeatureEnabled: () => true,
}));
vi.mock('@/lib/services/m365/groupMembership', () => ({
  resolveUserGroupIds: vi.fn(),
}));
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: {
    getInstance: () => ({ ensureFresh: vi.fn(), evaluateAccess: access }),
  },
}));
vi.mock('@/lib/services/agentAccess/accessRulesStore', () => ({
  createAgentAccessBlobStorage: () => ({}),
  readSkill: vi.fn(),
}));
vi.mock('@/lib/services/skills/skillDocumentStore', () => ({
  readSkillOriginal: vi.fn(),
}));
const fileId = '11111111-1111-1111-1111-111111111111';
const context = { params: Promise.resolve({ id: 'gdpr', fileId }) };
describe('skill citation downloads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue({
      user: { mail: 'user@msf.org' },
    } as never);
    access.mockReturnValue({ decision: 'allow' });
    vi.mocked(readSkill).mockResolvedValue({
      skill: {
        activation: 'auto',
        documents: [{ fileId, filename: 'policy.html' }],
      },
    } as never);
    vi.mocked(readSkillOriginal).mockResolvedValue(
      Buffer.from('<html>reference</html>'),
    );
  });
  it('serves original bytes as a private attachment, never executable HTML', async () => {
    const response = await GET(
      new NextRequest('http://localhost/resource'),
      context,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'application/octet-stream',
    );
    expect(response.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
  it('checks access again when a user follows a citation link', async () => {
    access.mockReturnValue({ decision: 'deny' });
    expect(
      (await GET(new NextRequest('http://localhost/resource'), context)).status,
    ).toBe(404);
    expect(readSkillOriginal).not.toHaveBeenCalled();
  });
  it('refuses stale source URLs after manifest removal', async () => {
    vi.mocked(readSkill).mockResolvedValue({
      skill: { activation: 'auto', documents: [] },
    } as never);
    expect(
      (await GET(new NextRequest('http://localhost/resource'), context)).status,
    ).toBe(404);
    expect(readSkillOriginal).not.toHaveBeenCalled();
  });
});
