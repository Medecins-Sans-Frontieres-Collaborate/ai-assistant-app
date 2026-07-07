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

/**
 * `starredModelIds` (models surfaced in the picker's "Your models" section)
 * was added in v20. Pre-v20 stores rehydrate it as `undefined`; the migration
 * backfills it to an empty array.
 */
describe('settingsStore migration (v19 → v20)', () => {
  const migrate = useSettingsStore.persist.getOptions().migrate!;

  it('initializes starredModelIds to [] when migrating from v19', () => {
    const persisted = {
      customAgents: [],
      customAgentSources: [],
      hiddenModelIds: [],
      // starredModelIds intentionally absent (pre-v20 shape)
    } as Record<string, unknown>;

    const result = migrate(persisted, 19) as Record<string, unknown>;

    expect(Array.isArray(result.starredModelIds)).toBe(true);
    expect(result.starredModelIds).toEqual([]);
  });

  it('preserves existing starredModelIds on a current-version store', () => {
    const starred = ['gpt-5.2', 'org-hr-bot'];
    const persisted = {
      customAgents: [],
      customAgentSources: [],
      hiddenModelIds: [],
      starredModelIds: starred,
    } as Record<string, unknown>;

    const result = migrate(persisted, 20) as Record<string, unknown>;

    expect(result.starredModelIds).toEqual(starred);
  });

  it('backfills both hidden and starred lists from a very old store', () => {
    const result = migrate(
      { customAgents: [] } as Record<string, unknown>,
      17,
    ) as Record<string, unknown>;

    expect(result.customAgentSources).toEqual([]);
    expect(result.hiddenModelIds).toEqual([]);
    expect(result.starredModelIds).toEqual([]);
  });
});

/**
 * v21 adds token-usage tracking (tokenUsageStats + tokenUsageFirstTrackedAt).
 */
describe('settingsStore migration (v20 → v21)', () => {
  const migrate = useSettingsStore.persist.getOptions().migrate!;

  it('initializes token usage fields when migrating from v20', () => {
    const result = migrate(
      { customAgents: [], starredModelIds: [] } as Record<string, unknown>,
      20,
    ) as Record<string, unknown>;

    expect(result.tokenUsageStats).toEqual({});
    expect(result.tokenUsageFirstTrackedAt).toBeNull();
  });

  it('preserves existing token usage stats on a current-version store', () => {
    const stats = {
      'gpt-5.2|EU|none': { promptTokens: 1, completionTokens: 2, requests: 1 },
    };
    const result = migrate(
      {
        tokenUsageStats: stats,
        tokenUsageFirstTrackedAt: '2026-07-06',
      } as Record<string, unknown>,
      21,
    ) as Record<string, unknown>;

    expect(result.tokenUsageStats).toEqual(stats);
    expect(result.tokenUsageFirstTrackedAt).toBe('2026-07-06');
  });
});
