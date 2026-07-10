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

  it('preserves existing customAgentSources on a v18 store (v29 adds selection defaults)', () => {
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

    expect(result.customAgentSources).toEqual([
      {
        ...sources[0],
        autoAddNewAgents: true,
        excludedAgentNames: [],
        selectedAgentNames: [],
      },
    ]);
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

/**
 * MCP connectors (v22): `mcpServers` + `allowArbitraryMcpServers` back the
 * Connectors settings section. Pre-v22 stores rehydrate them as undefined;
 * the migration backfills [] / false so list rendering and the send-path
 * filter never operate on undefined.
 */
describe('settingsStore migration (v21 → v22)', () => {
  const migrate = useSettingsStore.persist.getOptions().migrate!;

  it('initializes mcpServers to [] and allowArbitraryMcpServers to false when migrating from v21', () => {
    const persisted = {
      customAgentSources: [],
      // mcpServers / allowArbitraryMcpServers intentionally absent
    } as Record<string, unknown>;

    const result = migrate(persisted, 21) as Record<string, unknown>;

    expect(result.mcpServers).toEqual([]);
    expect(result.allowArbitraryMcpServers).toBe(false);
  });

  it('preserves existing MCP config (including tokens) on a current-version store', () => {
    const servers = [
      {
        id: 'gh1',
        catalogKey: 'github',
        name: 'GitHub',
        url: '',
        authMode: 'bearer',
        authToken: 'github_pat_abc',
        enabled: true,
        createdAt: '2026-07-08',
      },
    ];
    const result = migrate(
      {
        mcpServers: servers,
        allowArbitraryMcpServers: true,
      } as Record<string, unknown>,
      23,
    ) as Record<string, unknown>;

    expect(result.mcpServers).toEqual(servers);
    expect(result.allowArbitraryMcpServers).toBe(true);
  });
});

/**
 * Auth modes + OAuth (v23): every MCP server gains an `authMode`; servers
 * whose CATALOG auth style is 'oauth' (Asana) get any stored PAT cleared —
 * a PAT saved under the old bearer assumption never worked against an
 * OAuth-only server and must not be relayed under the wrong scheme.
 */
describe('settingsStore migration (v22 → v23)', () => {
  const migrate = useSettingsStore.persist.getOptions().migrate!;

  it('backfills authMode: bearer for token-carrying servers, none otherwise', () => {
    const persisted = {
      mcpServers: [
        {
          id: 'github',
          catalogKey: 'github',
          name: 'GitHub',
          url: '',
          authToken: 'github_pat_x',
          enabled: true,
          createdAt: 'now',
        },
        {
          id: 'c1',
          name: 'Anon Server',
          url: 'https://mcp.example.com',
          enabled: true,
          createdAt: 'now',
        },
      ],
    } as Record<string, unknown>;

    const result = migrate(persisted, 22) as {
      mcpServers: Array<Record<string, unknown>>;
    };

    expect(result.mcpServers[0].authMode).toBe('bearer');
    expect(result.mcpServers[0].authToken).toBe('github_pat_x');
    expect(result.mcpServers[1].authMode).toBe('none');
  });

  it('converts catalog-oauth servers (Asana) to authMode oauth and CLEARS the mislabeled PAT', () => {
    const persisted = {
      mcpServers: [
        {
          id: 'asana',
          catalogKey: 'asana',
          name: 'Asana',
          url: '',
          authToken: '1/12345-old-pat',
          enabled: true,
          createdAt: 'now',
        },
      ],
    } as Record<string, unknown>;

    const result = migrate(persisted, 22) as {
      mcpServers: Array<Record<string, unknown>>;
    };

    expect(result.mcpServers[0].authMode).toBe('oauth');
    expect(result.mcpServers[0].authToken).toBeUndefined();
    expect(result.mcpServers[0].oauth).toBeUndefined();
  });

  it('preserves already-migrated servers on a current-version store', () => {
    const servers = [
      {
        id: 'asana',
        catalogKey: 'asana',
        name: 'Asana',
        url: '',
        authMode: 'oauth',
        oauth: { clientId: 'dcr-1', accessToken: 'at', refreshToken: 'rt' },
        enabled: true,
        createdAt: 'now',
      },
    ];
    const result = migrate(
      { mcpServers: servers } as Record<string, unknown>,
      23,
    ) as Record<string, unknown>;

    expect(result.mcpServers).toEqual(servers);
  });
});

/**
 * v29 adds per-source agent selection to customAgentSources. Defaults must
 * reproduce the pre-selection behavior exactly: auto-add everything,
 * exclude nothing.
 */
describe('settingsStore migration (v28 → v29)', () => {
  const migrate = useSettingsStore.persist.getOptions().migrate!;

  it('seeds selection defaults on pre-existing sources when migrating from v28', () => {
    const persisted = {
      customAgentSources: [
        {
          id: 's1',
          name: 'My Project',
          resourcePath: '/subs/x',
          createdAt: 'now',
        },
      ],
    } as Record<string, unknown>;

    const result = migrate(persisted, 28) as Record<string, unknown>;

    expect(result.customAgentSources).toEqual([
      {
        id: 's1',
        name: 'My Project',
        resourcePath: '/subs/x',
        createdAt: 'now',
        autoAddNewAgents: true,
        excludedAgentNames: [],
        selectedAgentNames: [],
      },
    ]);
  });

  it('preserves explicit selection state on a current-version store', () => {
    const sources = [
      {
        id: 's1',
        name: 'My Project',
        resourcePath: '/subs/x',
        createdAt: 'now',
        autoAddNewAgents: false,
        excludedAgentNames: ['old-agent'],
        selectedAgentNames: ['picked-agent'],
      },
    ];
    const result = migrate(
      { customAgentSources: sources } as Record<string, unknown>,
      29,
    ) as Record<string, unknown>;

    expect(result.customAgentSources).toEqual(sources);
  });
});
