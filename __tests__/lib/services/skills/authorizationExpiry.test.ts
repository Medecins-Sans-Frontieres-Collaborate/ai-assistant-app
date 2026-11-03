import { getVisibleSkills } from '@/lib/services/skills/skillCatalog';

import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ fetchedAt: 100_000 }));
vi.mock('@/config/environment', () => ({
  env: { AGENT_ACCESS_CONTROL_ENABLED: true },
}));
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: {
    getInstance: () => ({
      ensureFresh: async () => undefined,
      getSnapshot: () => ({
        fetchedAt: state.fetchedAt,
        rulesUnavailable: false,
      }),
      getSkills: () => [],
      evaluateAccess: () => ({ decision: 'allow' }),
    }),
  },
}));
describe('skill authorization snapshot expiry', () => {
  afterEach(() => vi.useRealTimers());
  it('never extends stale last-known-good grants through a storage outage', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(159_999);
    expect(await getVisibleSkills('user')).not.toEqual([]);
    vi.setSystemTime(160_000);
    expect(await getVisibleSkills('user')).toEqual([]);
  });
});
