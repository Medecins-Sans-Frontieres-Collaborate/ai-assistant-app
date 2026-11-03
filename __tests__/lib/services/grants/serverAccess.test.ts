import { NextRequest } from 'next/server';

import {
  canUseGrants,
  hasGrantsAccess,
} from '@/lib/services/grants/serverAccess';
import { resolveUserGroupIds } from '@/lib/services/m365/groupMembership';
import { isWorkflowEnabled } from '@/lib/services/workflows/policy/guard';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/grants/access', () => ({
  canAccessGrants: (groupIds: string[] | null | undefined) =>
    groupIds?.includes('grants-group') ?? false,
}));
vi.mock('@/lib/services/m365/groupMembership', () => ({
  resolveUserGroupIds: vi.fn(),
}));
vi.mock('@/lib/services/workflows/policy/guard', () => ({
  isWorkflowEnabled: vi.fn(),
}));

const request = new NextRequest('http://localhost/api/grants/documents');
const session = {
  user: { id: 'u1', displayName: 'Test', mail: 'test@example.org' },
  expires: '',
} as never;

describe('grants server access', () => {
  beforeEach(() => {
    vi.mocked(resolveUserGroupIds).mockReset();
    vi.mocked(isWorkflowEnabled).mockReset();
  });

  it('hasGrantsAccess follows group membership', async () => {
    vi.mocked(resolveUserGroupIds).mockResolvedValue(['grants-group']);
    expect(await hasGrantsAccess(request, session)).toBe(true);

    vi.mocked(resolveUserGroupIds).mockResolvedValue(['other']);
    expect(await hasGrantsAccess(request, session)).toBe(false);
  });

  it('hasGrantsAccess never asks Graph without a session', async () => {
    expect(await hasGrantsAccess(request, null)).toBe(false);
    expect(resolveUserGroupIds).not.toHaveBeenCalled();
  });

  it('canUseGrants requires BOTH membership and the admin policy', async () => {
    vi.mocked(resolveUserGroupIds).mockResolvedValue(['grants-group']);
    vi.mocked(isWorkflowEnabled).mockResolvedValue(true);
    expect(await canUseGrants(request, session)).toBe(true);

    vi.mocked(isWorkflowEnabled).mockResolvedValue(false);
    expect(await canUseGrants(request, session)).toBe(false);
  });

  it('canUseGrants never consults the policy for a non-member', async () => {
    vi.mocked(resolveUserGroupIds).mockResolvedValue([]);
    vi.mocked(isWorkflowEnabled).mockResolvedValue(true);
    expect(await canUseGrants(request, session)).toBe(false);
    expect(isWorkflowEnabled).not.toHaveBeenCalled();
  });
});
