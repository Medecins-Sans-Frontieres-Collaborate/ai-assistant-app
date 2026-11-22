import { parseJsonResponse } from '../helpers';

import { GET } from '@/app/api/limits/insights/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Usage evidence is global-admin only, and is read in the policy's timezone
 * so its days match the counters.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  isGlobalAdmin: vi.fn(),
  currentPolicy: vi.fn(),
  loadUsageInsights: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/services/agentAccess/adminAuth', () => ({
  isGlobalAdmin: mocks.isGlobalAdmin,
}));
vi.mock('@/lib/services/limits/enforcement', () => ({
  currentPolicy: mocks.currentPolicy,
}));
vi.mock('@/lib/services/limits/usageInsights', () => ({
  loadUsageInsights: mocks.loadUsageInsights,
}));

describe('GET /api/limits/insights', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: 'u', mail: 'a@b.org' } });
    mocks.currentPolicy.mockResolvedValue({ timezone: 'Europe/Paris' });
    mocks.loadUsageInsights.mockResolvedValue({ status: 'ready', cells: {} });
  });

  it('401s without a session', async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it('403s anyone who is not a global admin, without reading usage', async () => {
    mocks.isGlobalAdmin.mockReturnValue(false);
    expect((await GET()).status).toBe(403);
    expect(mocks.loadUsageInsights).not.toHaveBeenCalled();
  });

  it('answers a global admin, in the policy timezone', async () => {
    mocks.isGlobalAdmin.mockReturnValue(true);
    const response = await GET();
    expect(response.status).toBe(200);
    expect((await parseJsonResponse(response)).data.status).toBe('ready');
    expect(mocks.loadUsageInsights).toHaveBeenCalledWith('Europe/Paris');
  });
});
