import { canUseGrants } from '@/lib/services/grants/serverAccess';
import { isWorkflowEnabled } from '@/lib/services/workflows/policy/guard';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/workflows/policy/guard', () => ({
  isWorkflowEnabled: vi.fn(),
}));

const grantsUser = {
  companyName: 'MSF-USA',
  department: 'Program',
  jobTitle: 'Senior Grants Officer',
};

describe('canUseGrants', () => {
  beforeEach(() => vi.mocked(isWorkflowEnabled).mockReset());

  it('requires BOTH the directory rule and the admin policy', async () => {
    vi.mocked(isWorkflowEnabled).mockResolvedValue(true);
    expect(await canUseGrants(grantsUser)).toBe(true);

    vi.mocked(isWorkflowEnabled).mockResolvedValue(false);
    expect(await canUseGrants(grantsUser)).toBe(false);
  });

  it('never consults the policy for a user who fails the directory rule', async () => {
    vi.mocked(isWorkflowEnabled).mockResolvedValue(true);
    expect(await canUseGrants({ ...grantsUser, companyName: 'MSF-UK' })).toBe(
      false,
    );
    expect(isWorkflowEnabled).not.toHaveBeenCalled();
  });
});
