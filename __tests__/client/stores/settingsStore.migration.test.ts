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

/**
 * `hiddenModelIds` (the per-user list of models/agents hidden from the picker)
 * was added in v19. Pre-v19 stores rehydrate it as `undefined`; the migration
 * backfills it to an empty array so downstream filtering never sees undefined.
 */
describe('settingsStore migration (v18 → v19)', () => {
  const migrate = useSettingsStore.persist.getOptions().migrate!;

  it('initializes hiddenModelIds to [] when migrating from v18', () => {
    const persisted = {
      customAgents: [],
      customAgentSources: [],
      // hiddenModelIds intentionally absent (pre-v19 shape)
    } as Record<string, unknown>;

    const result = migrate(persisted, 18) as Record<string, unknown>;

    expect(Array.isArray(result.hiddenModelIds)).toBe(true);
    expect(result.hiddenModelIds).toEqual([]);
  });

  it('preserves existing hiddenModelIds on a current-version store', () => {
    const hidden = ['gpt-4.1', 'org-hr-bot', 'foundry-ab12-xyz'];
    const persisted = {
      customAgents: [],
      customAgentSources: [],
      hiddenModelIds: hidden,
    } as Record<string, unknown>;

    const result = migrate(persisted, 19) as Record<string, unknown>;

    expect(result.hiddenModelIds).toEqual(hidden);
  });
});
