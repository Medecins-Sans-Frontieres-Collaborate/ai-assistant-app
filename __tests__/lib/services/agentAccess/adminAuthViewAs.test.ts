import {
  isGlobalAdmin,
  resolveAdminStatus,
} from '@/lib/services/agentAccess/adminAuth';
import { AgentAccessConfig } from '@/lib/services/agentAccess/types';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  AGENT_ACCESS_ADMINS: 'admin@example.com',
}));
vi.mock('@/config/environment', () => ({ env: mockEnv }));

const config: AgentAccessConfig = {
  version: 1,
  localAdmins: [{ email: 'local@example.com', agentKeys: ['src/a'] }],
  updatedBy: 'x',
  updatedAt: 'y',
};

describe('adminAuth with view-as', () => {
  beforeEach(() => {
    mockEnv.AGENT_ACCESS_ADMINS = 'admin@example.com';
  });

  it('a session user without viewAs behaves exactly like the bare mail', () => {
    expect(isGlobalAdmin({ mail: 'admin@example.com' })).toBe(true);
    expect(isGlobalAdmin({ mail: 'user@example.com' })).toBe(false);
    expect(resolveAdminStatus({ mail: 'local@example.com' }, config)).toEqual({
      isGlobalAdmin: false,
      isLocalAdmin: true,
      editableAgentKeys: ['src/a'],
    });
  });

  it('viewAs "none" demotes a global admin to a regular user', () => {
    const user = {
      mail: 'admin@example.com',
      viewAs: { overrides: { adminRole: 'none' as const } },
    };
    expect(isGlobalAdmin(user)).toBe(false);
    expect(resolveAdminStatus(user, config)).toEqual({
      isGlobalAdmin: false,
      isLocalAdmin: false,
      editableAgentKeys: [],
    });
  });

  it('viewAs "local" demotes to a local admin with the given keys', () => {
    const user = {
      mail: 'admin@example.com',
      viewAs: {
        overrides: {
          adminRole: 'local' as const,
          localAdminKeys: ['Src/B', 'src/b'],
        },
      },
    };
    expect(isGlobalAdmin(user)).toBe(false);
    expect(resolveAdminStatus(user, config)).toEqual({
      isGlobalAdmin: false,
      isLocalAdmin: true,
      editableAgentKeys: ['src/b'],
    });
    expect(
      resolveAdminStatus(
        {
          mail: 'admin@example.com',
          viewAs: { overrides: { adminRole: 'local' } },
        },
        config,
      ).editableAgentKeys,
    ).toEqual([]);
  });

  it('the bare-mail form is the REAL identity and ignores demotion', () => {
    // Callers that must reach the real admin (view-as controls) use this.
    expect(isGlobalAdmin('admin@example.com')).toBe(true);
  });

  it('viewAs on a non-admin grants nothing', () => {
    const user = {
      mail: 'user@example.com',
      viewAs: {
        overrides: { adminRole: 'local' as const, localAdminKeys: ['src/a'] },
      },
    };
    expect(isGlobalAdmin(user)).toBe(false);
    expect(resolveAdminStatus(user, config)).toEqual({
      isGlobalAdmin: false,
      isLocalAdmin: false,
      editableAgentKeys: [],
    });
  });
});
