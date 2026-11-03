import { readSkill } from '@/lib/services/agentAccess/accessRulesStore';
import { resolveAdminStatus } from '@/lib/services/agentAccess/adminAuth';
import { orgSkillsAvailable } from '@/lib/services/skills/skillCatalog';
import { authorizeSkillDocuments } from '@/lib/services/skills/skillDocumentAuth';

import { auth } from '@/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/services/skills/skillCatalog', () => ({
  orgSkillsAvailable: vi.fn(() => true),
}));
vi.mock('@/lib/services/agentAccess/adminAuth', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/lib/services/agentAccess/adminAuth')
  >()),
  resolveAdminStatus: vi.fn(),
}));
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: {
    getInstance: () => ({
      ensureFresh: vi.fn(),
      getSnapshot: () => ({ config: {} }),
    }),
  },
}));
vi.mock('@/lib/services/agentAccess/accessRulesStore', () => ({
  createAgentAccessBlobStorage: () => ({}),
  readSkill: vi.fn(),
}));

describe('resource admin gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(orgSkillsAvailable).mockReturnValue(true);
    vi.mocked(auth).mockResolvedValue({
      user: { mail: 'admin@msf.org' },
    } as never);
    vi.mocked(resolveAdminStatus).mockReturnValue({
      isGlobalAdmin: false,
      isLocalAdmin: true,
      editableAgentKeys: ['skill::gdpr'],
    });
    vi.mocked(readSkill).mockResolvedValue({
      skill: { id: 'gdpr', documents: [] },
      etag: 'v1',
    } as never);
  });
  it('permits a delegated skill key', async () => {
    expect((await authorizeSkillDocuments('gdpr')).response).toBeUndefined();
  });
  it('denies another skill before accessing its stored body', async () => {
    expect((await authorizeSkillDocuments('other')).response?.status).toBe(403);
    expect(readSkill).not.toHaveBeenCalled();
  });
  it('requires global admin for built-in resources even with a delegated key', async () => {
    vi.mocked(resolveAdminStatus).mockReturnValue({
      isGlobalAdmin: false,
      isLocalAdmin: true,
      editableAgentKeys: ['skill::platform-help'],
    });
    expect(
      (await authorizeSkillDocuments('platform-help')).response?.status,
    ).toBe(403);
  });
  it('is absent without agent-access storage', async () => {
    vi.mocked(orgSkillsAvailable).mockReturnValue(false);
    expect((await authorizeSkillDocuments('gdpr')).response?.status).toBe(404);
    expect(auth).not.toHaveBeenCalled();
  });
});
