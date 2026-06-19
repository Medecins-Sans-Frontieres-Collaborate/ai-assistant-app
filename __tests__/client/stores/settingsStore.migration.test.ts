import { useSettingsStore } from '@/client/stores/settingsStore';
import { describe, expect, it } from 'vitest';

/**
 * The `customAgentSources` field was added without a version bump, so stores
 * persisted before v18 rehydrate it as `undefined` — and any `.map`/`.find`
 * over it then throws. The v17→v18 migration backfills it to an empty array.
 */
describe('settingsStore migration (v17 → v18)', () => {
  const migrate = useSettingsStore.persist.getOptions().migrate!;

  it('initializes customAgentSources to [] when migrating from v17', () => {
    const persisted = {
      customAgents: [],
      // customAgentSources intentionally absent (pre-v18 shape)
    } as Record<string, unknown>;

    const result = migrate(persisted, 17) as Record<string, unknown>;

    expect(Array.isArray(result.customAgentSources)).toBe(true);
    expect(result.customAgentSources).toEqual([]);
  });

  it('preserves existing customAgentSources on a current-version store', () => {
    const sources = [
      {
        id: 's1',
        name: 'My Project',
        resourcePath: '/subs/x',
        createdAt: 'now',
      },
    ];
    const persisted = {
      customAgents: [],
      customAgentSources: sources,
    } as Record<string, unknown>;

    const result = migrate(persisted, 18) as Record<string, unknown>;

    expect(result.customAgentSources).toEqual(sources);
  });
});
