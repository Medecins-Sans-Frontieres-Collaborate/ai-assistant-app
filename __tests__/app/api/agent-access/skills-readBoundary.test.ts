import { resolveAdminStatus } from '@/lib/services/agentAccess/adminAuth';

import { GET } from '@/app/api/agent-access/skills/route';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({
  auth: async () => ({ user: { mail: 'local@msf.org' } }),
}));
vi.mock('@/lib/services/skills/skillCatalog', () => ({
  skillsFeatureEnabled: () => true,
}));
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: {
    getInstance: () => ({
      isEnabled: () => true,
      getSnapshot: () => ({ config: {} }),
    }),
  },
}));
vi.mock('@/lib/services/agentAccess/adminAuth', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/lib/services/agentAccess/adminAuth')
  >()),
  resolveAdminStatus: vi.fn(() => ({
    isGlobalAdmin: false,
    isLocalAdmin: true,
    editableAgentKeys: [],
  })),
}));
vi.mock(
  '@/lib/services/agentAccess/accessRulesStore',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@/lib/services/agentAccess/accessRulesStore')
    >()),
    createAgentAccessBlobStorage: () => ({}),
    readConfig: async () => ({ config: {} }),
    listAllSkills: async () => [
      {
        canonicalKey: 'skill::platform-help',
        etag: 'v1',
        record: {
          version: 1,
          id: 'platform-help',
          name: 'Restricted Help',
          description: 'Private',
          instructions: 'Private override instructions',
          activation: 'auto',
          applyToAgents: false,
          documents: [],
          updatedAt: '',
        },
      },
    ],
  }),
);
describe('admin skill listing boundaries', () => {
  it('does not expose a private built-in override to an unrelated local admin', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(
      'Private override instructions',
    );
  });
  it('allows a global administrator to inspect the actual override', async () => {
    vi.mocked(resolveAdminStatus).mockReturnValueOnce({
      isGlobalAdmin: true,
      isLocalAdmin: false,
      editableAgentKeys: '*',
    });
    const response = await GET();
    expect(await response.text()).toContain('Private override instructions');
  });
});
