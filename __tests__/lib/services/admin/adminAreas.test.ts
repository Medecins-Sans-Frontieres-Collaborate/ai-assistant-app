import { resolveAdminAreas } from '@/lib/services/admin/adminAreas';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  AGENT_ACCESS_CONTROL_ENABLED: true,
  AGENT_ACCESS_ADMINS: 'admin@example.com',
}));
vi.mock('@/config/environment', () => ({ env: mockEnv }));
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: {
    getInstance: () => ({
      ensureFresh: vi.fn(),
      getSnapshot: () => ({
        config: {
          version: 1,
          localAdmins: [{ email: 'local@example.com', agentKeys: [] }],
          updatedBy: 'x',
          updatedAt: 'y',
        },
      }),
    }),
  },
}));

describe('resolveAdminAreas', () => {
  beforeEach(() => {
    mockEnv.AGENT_ACCESS_CONTROL_ENABLED = true;
  });

  it('gives a global admin workflows + view-as, a local admin neither', async () => {
    const globalAreas = (await resolveAdminAreas({ mail: 'admin@example.com' }))
      .areas;
    expect(globalAreas).toContain('workflows');
    expect(globalAreas).toContain('view-as');
    expect(globalAreas).toContain('limits');

    const localAreas = (await resolveAdminAreas({ mail: 'local@example.com' }))
      .areas;
    expect(localAreas).toContain('agents');
    expect(localAreas).not.toContain('workflows');
    expect(localAreas).not.toContain('view-as');
  });

  it('keeps ONLY view-as for a global admin viewing as a regular user', async () => {
    const { areas } = await resolveAdminAreas({
      mail: 'admin@example.com',
      viewAs: { overrides: { adminRole: 'none' } },
    });
    expect(areas).toEqual(['view-as']);
  });

  it('a global admin viewing as a local admin sees the local areas plus view-as', async () => {
    const { areas } = await resolveAdminAreas({
      mail: 'admin@example.com',
      viewAs: { overrides: { adminRole: 'local', localAdminKeys: [] } },
    });
    expect(areas).toContain('agents');
    expect(areas).not.toContain('limits');
    expect(areas).not.toContain('local-admins');
    expect(areas).toContain('view-as');
  });

  it('never offers view-as to a non-admin', async () => {
    const { areas } = await resolveAdminAreas({ mail: 'u@example.com' });
    expect(areas).toEqual([]);
  });
});
