import { checkTokenBudget } from '@/lib/services/limits/tokenDebit';
import { readUsage } from '@/lib/services/limits/usageStore';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const policyRef = vi.hoisted(() => ({
  current: null as null | Record<string, unknown>,
}));

vi.mock('@/lib/services/limits/enforcement', () => ({
  currentPolicy: vi.fn(async () => policyRef.current),
  meteredCells: vi.fn((_policy: unknown, _principal: unknown, key: string) =>
    key === 'chat.tokensPerDay'
      ? [{ limitKey: key, value: 1000, source: 'global' }]
      : [],
  ),
}));
vi.mock('@/lib/services/limits/principal', () => ({
  buildPrincipal: vi.fn(() => ({ userId: 'oid-1' })),
}));
vi.mock('@/lib/services/limits/usageStore', () => ({
  readUsage: vi.fn(),
  reserve: vi.fn(),
}));

const user = { id: 'oid-1' } as never;

/**
 * The token pre-flight used to hard-code fail-open on a counter read
 * failure. docs/LIMITS.md promises `failMode: 'closed'` denies when a
 * counter is unreadable; now it does, and says so.
 */
describe('checkTokenBudget failMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('fails open when the policy says open', async () => {
    policyRef.current = { failMode: 'open', timezone: 'UTC' };
    vi.mocked(readUsage).mockRejectedValue(new Error('storage down'));
    expect(await checkTokenBudget(user)).toBeNull();
  });

  it('refuses with `unavailable` when the policy says closed and a token limit applies', async () => {
    policyRef.current = { failMode: 'closed', timezone: 'UTC' };
    vi.mocked(readUsage).mockRejectedValue(new Error('storage down'));
    expect(await checkTokenBudget(user)).toEqual({
      limitKey: 'chat.tokensPerDay',
      limit: 1000,
      used: 0,
      unavailable: true,
    });
  });

  it('still reports a genuine overage as before', async () => {
    policyRef.current = { failMode: 'closed', timezone: 'UTC' };
    vi.mocked(readUsage).mockResolvedValue({ 'chat.tokensPerDay': 1000 });
    expect(await checkTokenBudget(user)).toEqual({
      limitKey: 'chat.tokensPerDay',
      limit: 1000,
      used: 1000,
    });
  });
});
