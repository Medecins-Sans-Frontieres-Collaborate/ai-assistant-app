/**
 * Workflow token spend debits the SAME pool as chat and is separable
 * afterwards (docs/WORKFLOW_EMISSIONS_DESIGN.md §7b): the real cell and its
 * shadow twin must ride ONE reservation, or the split could drift from the
 * total it splits.
 */
import { debitTokenUsage } from '@/lib/services/limits/tokenDebit';
import { reserve } from '@/lib/services/limits/usageStore';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/limits/enforcement', () => ({
  currentPolicy: vi.fn().mockResolvedValue({ timezone: 'UTC' }),
  meteredCells: vi
    .fn()
    .mockImplementation((_policy, _principal, limitKey: string) =>
      limitKey === 'chat.tokensPerDay'
        ? [{ limitKey: 'chat.tokensPerDay', value: 1000, source: 'global' }]
        : [],
    ),
}));

vi.mock('@/lib/services/limits/periods', () => ({
  periodKindForWindow: vi.fn().mockReturnValue('day'),
}));

vi.mock('@/lib/services/limits/principal', () => ({
  buildPrincipal: vi.fn().mockReturnValue({ userId: 'user-1' }),
}));

vi.mock('@/lib/services/limits/usageStore', () => ({
  reserve: vi.fn().mockResolvedValue({ allowed: true }),
}));

const user = { id: 'user-1' } as never;
const reserveMock = vi.mocked(reserve);

describe('debitTokenUsage surfaces', () => {
  beforeEach(() => vi.clearAllMocks());

  it('debits only the real cell for chat', async () => {
    await debitTokenUsage(user, 120);

    const counters = reserveMock.mock.calls[0][2];
    expect(counters.map((c) => c.cell)).toEqual(['chat.tokensPerDay']);
    expect(counters[0].cost).toBe(120);
  });

  it('debits the real cell AND its shadow twin for a workflow run', async () => {
    await debitTokenUsage(user, 120, 'workflow');

    expect(reserveMock).toHaveBeenCalledTimes(1);
    const counters = reserveMock.mock.calls[0][2];
    expect(counters.map((c) => c.cell)).toEqual([
      'chat.tokensPerDay',
      'chat.tokensPerDay#workflow',
    ]);
    // Same cost on both, so the shadow is a true subset of the total.
    expect(counters.every((c) => c.cost === 120)).toBe(true);
    // The shadow reports the REAL key on denial, and can never gate anything:
    // an effectively infinite ceiling, exactly like the cell it shadows.
    expect(counters[1].limitKey).toBe('chat.tokensPerDay');
    expect(counters[1].limit).toBe(Number.MAX_SAFE_INTEGER);
  });
});
