import {
  EMISSIONS_CHIP_AUTOHIDE_DEFAULT_MS,
  EMISSIONS_CHIP_AUTOHIDE_MIN_MS,
  EMISSIONS_CHIP_VISIBILITY_DEFAULT,
} from '@/lib/utils/shared/emissions';
import {
  DEFAULT_MAP_TIMELAPSE,
  MAX_CARDS_MAX,
} from '@/lib/utils/shared/geo/timelapsePacing';

import { InterpreterMode } from '@/types/interpreterMode';
import { DEFAULT_WEB_SEARCH_OPTIONS } from '@/types/webSearch';

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

/**
 * v34 adds the adjustable context window (conversation compaction) and the
 * Memories opt-in. Backfill must reproduce prior behavior exactly: the old
 * hard-coded 80-message window, memories off.
 */
describe('settingsStore migration (v33 → v34)', () => {
  const migrate = useSettingsStore.persist.getOptions().migrate!;

  it('backfills contextWindowSize=80 and memoriesEnabled=false when migrating from v33', () => {
    const persisted = {
      customAgents: [],
      // contextWindowSize / memoriesEnabled intentionally absent (pre-v34)
    } as Record<string, unknown>;

    const result = migrate(persisted, 33) as Record<string, unknown>;

    expect(result.contextWindowSize).toBe(80);
    expect(result.memoriesEnabled).toBe(false);
  });

  it('preserves existing values on a current-version store', () => {
    const persisted = {
      contextWindowSize: 120,
      memoriesEnabled: true,
    } as Record<string, unknown>;

    const result = migrate(persisted, 34) as Record<string, unknown>;

    expect(result.contextWindowSize).toBe(120);
    expect(result.memoriesEnabled).toBe(true);
  });
});

/**
 * v35 → v36: automatic fetching of pasted links. Defaults ON, so an existing
 * user gets the behavior without hunting for a setting; the toggle exists for
 * those who would rather links stayed inert.
 */
describe('settingsStore migration (v35 → v36)', () => {
  const migrate = useSettingsStore.persist.getOptions().migrate!;

  it('backfills autoFetchPastedLinks=true when migrating from v35', () => {
    const persisted = {
      customAgents: [],
      // autoFetchPastedLinks intentionally absent (pre-v36)
    } as Record<string, unknown>;

    const result = migrate(persisted, 35) as Record<string, unknown>;

    expect(result.autoFetchPastedLinks).toBe(true);
  });

  it('preserves an explicit opt-out on a current-version store', () => {
    const persisted = {
      autoFetchPastedLinks: false,
    } as Record<string, unknown>;

    const result = migrate(persisted, 36) as Record<string, unknown>;

    expect(result.autoFetchPastedLinks).toBe(false);
  });
});

/**
 * v36 → v37: time-lapse pacing. Clamped rather than replaced wholesale, so a
 * hand-edited or half-written value keeps whatever part of it was usable
 * instead of silently reverting the user's tuning.
 */
describe('settingsStore migration (v36 → v37)', () => {
  const migrate = useSettingsStore.persist.getOptions().migrate!;

  it('seeds mapTimelapse defaults when migrating from v36', () => {
    const persisted = {
      customAgents: [],
      // mapTimelapse intentionally absent (pre-v37)
    } as Record<string, unknown>;

    const result = migrate(persisted, 36) as Record<string, unknown>;

    expect(result.mapTimelapse).toEqual(DEFAULT_MAP_TIMELAPSE);
  });

  it('keeps a tuned value, clamping only what is out of range', () => {
    const persisted = {
      mapTimelapse: { cardDurationMs: 4200, maxCardsPerDate: 40 },
    } as Record<string, unknown>;

    const result = migrate(persisted, 36) as Record<string, unknown>;

    expect(result.mapTimelapse).toEqual({
      cardDurationMs: 4200,
      maxCardsPerDate: MAX_CARDS_MAX,
    });
  });

  it('preserves an already-migrated value on a current-version store', () => {
    const mapTimelapse = { cardDurationMs: 1400, maxCardsPerDate: 2 };
    const result = migrate({ mapTimelapse }, 37) as Record<string, unknown>;

    expect(result.mapTimelapse).toEqual(mapTimelapse);
  });
});

/**
 * v37 → v38: the auto-clear-resolved-edits preference. Defaults OFF so an
 * upgrade never starts silently discarding a user's decision record.
 */
describe('settingsStore migration (v37 → v38)', () => {
  const migrate = useSettingsStore.persist.getOptions().migrate!;

  it('backfills autoClearResolvedEdits=false when migrating from v37', () => {
    const persisted = {
      customAgents: [],
      // autoClearResolvedEdits intentionally absent (pre-v38)
    } as Record<string, unknown>;

    const result = migrate(persisted, 37) as Record<string, unknown>;

    expect(result.autoClearResolvedEdits).toBe(false);
  });

  it('preserves an opted-in value', () => {
    const persisted = {
      autoClearResolvedEdits: true,
    } as Record<string, unknown>;

    const result = migrate(persisted, 37) as Record<string, unknown>;

    expect(result.autoClearResolvedEdits).toBe(true);
  });
});

/**
 * v38 → v39: custom quality criteria for the translation workflow. A
 * separate list from documentCriteria on purpose — the rubrics are
 * domain-specific, so one shared list would cross-contaminate both pickers.
 */
describe('settingsStore migration (v38 → v39)', () => {
  const migrate = useSettingsStore.persist.getOptions().migrate!;

  it('backfills translationCriteria to an empty list', () => {
    const persisted = {
      customAgents: [],
      // translationCriteria intentionally absent (pre-v39)
    } as Record<string, unknown>;

    const result = migrate(persisted, 38) as Record<string, unknown>;

    expect(result.translationCriteria).toEqual([]);
  });

  it('preserves existing criteria and leaves documentCriteria alone', () => {
    const translationCriteria = [
      {
        id: 'custom:a',
        name: 'House style',
        rubric: 'Use the imperative',
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedAt: '2026-07-18T00:00:00.000Z',
      },
    ];
    const documentCriteria = [{ id: 'custom:b', name: 'Brand', rubric: 'x' }];

    const result = migrate(
      { translationCriteria, documentCriteria },
      38,
    ) as Record<string, unknown>;

    expect(result.translationCriteria).toEqual(translationCriteria);
    expect(result.documentCriteria).toEqual(documentCriteria);
  });

  it('repairs a non-array value', () => {
    const result = migrate({ translationCriteria: 'oops' }, 38) as Record<
      string,
      unknown
    >;
    expect(result.translationCriteria).toEqual([]);
  });
});

/**
 * v40 → v41: extractionRecipes → savedStructures, now shared with the data
 * workflow. The delicate part is `required`: recipes treated an absent flag
 * as *required*, the shared type treats it as *optional*. The migration must
 * therefore write the flag explicitly, or every saved recipe silently
 * loosens into nullable unions.
 */
describe('settingsStore migration (v40 → v41)', () => {
  const migrate = useSettingsStore.persist.getOptions().migrate!;

  const recipe = (fields: Record<string, unknown>[]) => ({
    id: 'r1',
    name: 'Invoices',
    instructions: 'find invoices',
    fields,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  });

  it('renames the collection and drops the legacy key', () => {
    const result = migrate({ extractionRecipes: [recipe([])] }, 40) as Record<
      string,
      unknown
    >;

    expect(result.savedStructures).toHaveLength(1);
    expect(result).not.toHaveProperty('extractionRecipes');
    expect(result.savedStructures).toMatchObject([
      { id: 'r1', name: 'Invoices', instructions: 'find invoices' },
    ]);
  });

  it('stamps required:true on fields that omitted the flag', () => {
    const result = migrate(
      {
        extractionRecipes: [
          recipe([
            { id: 'a', name: 'a', type: 'text' },
            { id: 'b', name: 'b', type: 'number', required: true },
          ]),
        ],
      },
      40,
    ) as Record<string, unknown>;

    const fields = (result.savedStructures as { fields: unknown[] }[])[0]
      .fields;
    expect(fields).toEqual([
      { id: 'a', name: 'a', type: 'text', required: true },
      { id: 'b', name: 'b', type: 'number', required: true },
    ]);
  });

  it('preserves explicitly optional fields', () => {
    const result = migrate(
      {
        extractionRecipes: [
          recipe([{ id: 'a', name: 'a', type: 'text', required: false }]),
        ],
      },
      40,
    ) as Record<string, unknown>;

    const fields = (result.savedStructures as { fields: unknown[] }[])[0]
      .fields;
    expect(fields).toEqual([
      { id: 'a', name: 'a', type: 'text', required: false },
    ]);
  });

  it('backfills an empty list when there were no recipes', () => {
    const result = migrate({ customAgents: [] }, 40) as Record<string, unknown>;
    expect(result.savedStructures).toEqual([]);
  });

  it('repairs a non-array legacy value and a non-array fields list', () => {
    expect(
      (migrate({ extractionRecipes: 'oops' }, 40) as Record<string, unknown>)
        .savedStructures,
    ).toEqual([]);

    const result = migrate(
      { extractionRecipes: [{ id: 'r1', name: 'x', fields: 'oops' }] },
      40,
    ) as Record<string, unknown>;
    expect(
      (result.savedStructures as { fields: unknown[] }[])[0].fields,
    ).toEqual([]);
  });

  it('carries a very old store through v23→24 and on to savedStructures', () => {
    // v23 predates extractionRecipes entirely; the v24 block backfills the
    // legacy key and v41 must then rename it rather than stepping past it.
    const result = migrate({ customAgents: [] }, 23) as Record<string, unknown>;

    expect(result.savedStructures).toEqual([]);
    expect(result).not.toHaveProperty('extractionRecipes');
  });
});

/**
 * v43 → v44 adds the per-user emissions chip visibility setting. It defaults
 * to `always` — the behavior existing users already have — so the migration is
 * a no-op for them. Both fields round-trip through localStorage, so a stale or
 * hand-edited value must be repaired rather than trusted at the render path.
 */
describe('settingsStore migration (v43 → v44)', () => {
  const migrate = useSettingsStore.persist.getOptions().migrate!;

  it('backfills emissions chip defaults when migrating from v43', () => {
    const result = migrate({}, 43) as Record<string, unknown>;

    expect(result.emissionsChipVisibility).toBe(
      EMISSIONS_CHIP_VISIBILITY_DEFAULT,
    );
    expect(result.emissionsChipAutoHideMs).toBe(
      EMISSIONS_CHIP_AUTOHIDE_DEFAULT_MS,
    );
  });

  it('preserves a deliberate choice', () => {
    const result = migrate(
      { emissionsChipVisibility: 'auto', emissionsChipAutoHideMs: 8000 },
      43,
    ) as Record<string, unknown>;

    expect(result.emissionsChipVisibility).toBe('auto');
    expect(result.emissionsChipAutoHideMs).toBe(8000);
  });

  it('repairs an unrecognized mode and clamps an out-of-range delay', () => {
    const result = migrate(
      { emissionsChipVisibility: 'sometimes', emissionsChipAutoHideMs: 10 },
      43,
    ) as Record<string, unknown>;

    expect(result.emissionsChipVisibility).toBe(
      EMISSIONS_CHIP_VISIBILITY_DEFAULT,
    );
    expect(result.emissionsChipAutoHideMs).toBe(EMISSIONS_CHIP_AUTOHIDE_MIN_MS);
  });
});

describe('settingsStore migration (v45 → v46)', () => {
  const migrate = useSettingsStore.persist.getOptions().migrate!;

  it('backfills defaultInterpreterMode to INTELLIGENT (default enabled)', () => {
    const result = migrate({}, 45) as Record<string, unknown>;

    expect(result.defaultInterpreterMode).toBe(InterpreterMode.INTELLIGENT);
  });

  it('preserves a deliberate OFF choice on re-migration', () => {
    const result = migrate(
      { defaultInterpreterMode: InterpreterMode.OFF },
      45,
    ) as Record<string, unknown>;

    expect(result.defaultInterpreterMode).toBe(InterpreterMode.OFF);
  });

  it('repairs an unrecognized value', () => {
    const result = migrate({ defaultInterpreterMode: 'turbo' }, 45) as Record<
      string,
      unknown
    >;

    expect(result.defaultInterpreterMode).toBe(InterpreterMode.INTELLIGENT);
  });
});

describe('settingsStore migration (v46 → v47)', () => {
  const migrate = useSettingsStore.persist.getOptions().migrate!;

  it('backfills default web-search options', () => {
    const result = migrate({}, 46) as Record<string, unknown>;

    expect(result.webSearchOptions).toEqual(DEFAULT_WEB_SEARCH_OPTIONS);
  });

  it('preserves valid persisted options and clamps invalid ones', () => {
    const result = migrate(
      { webSearchOptions: { resultCount: 12, freshness: 'week' } },
      46,
    ) as Record<string, unknown>;
    // Absent provider backfills to the store default — 'combined' since
    // combined (Bing + headlines) became the product default.
    expect(result.webSearchOptions).toEqual({
      resultCount: 12,
      freshness: 'week',
      provider: 'combined',
    });

    const repaired = migrate(
      { webSearchOptions: { resultCount: 99, freshness: 'yesteryear' } },
      46,
    ) as Record<string, unknown>;
    expect(repaired.webSearchOptions).toEqual({
      resultCount: 15,
      freshness: 'auto',
      provider: 'combined',
    });
  });
});

describe('settingsStore migration (v47 → v48)', () => {
  const migrate = useSettingsStore.persist.getOptions().migrate!;

  it('backfills the provider field on existing options', () => {
    const result = migrate(
      { webSearchOptions: { resultCount: 10, freshness: 'day' } },
      47,
    ) as Record<string, unknown>;

    expect(result.webSearchOptions).toEqual({
      resultCount: 10,
      freshness: 'day',
      provider: 'combined',
    });
  });

  it('keeps a valid persisted provider and repairs an invalid one', () => {
    for (const valid of ['google-news', 'bing-agent', 'bing-responses']) {
      const kept = migrate(
        {
          webSearchOptions: {
            resultCount: 8,
            freshness: 'auto',
            provider: valid,
          },
        },
        47,
      ) as Record<string, unknown>;
      expect((kept.webSearchOptions as Record<string, unknown>).provider).toBe(
        valid,
      );
    }

    const repaired = migrate(
      {
        webSearchOptions: {
          resultCount: 8,
          freshness: 'auto',
          provider: 'altavista',
        },
      },
      47,
    ) as Record<string, unknown>;
    expect(
      (repaired.webSearchOptions as Record<string, unknown>).provider,
    ).toBe('combined');
  });
});

/**
 * v48 → v49: the pause-capture toggle for Memories. Negative polarity is
 * deliberate — an absent or malformed key repairs to "not paused", which is
 * how the feature behaved before the toggle existed.
 */
describe('settingsStore migration (v48 → v49)', () => {
  const migrate = useSettingsStore.persist.getOptions().migrate!;

  it('backfills memoryCapturePaused=false when migrating from v48', () => {
    const result = migrate({ memoriesEnabled: true }, 48) as Record<
      string,
      unknown
    >;

    expect(result.memoryCapturePaused).toBe(false);
    // The opt-in itself must survive untouched.
    expect(result.memoriesEnabled).toBe(true);
  });

  it('preserves an explicit pause on a current-version store', () => {
    const result = migrate({ memoryCapturePaused: true }, 49) as Record<
      string,
      unknown
    >;

    expect(result.memoryCapturePaused).toBe(true);
  });

  it('repairs a non-boolean value', () => {
    const result = migrate({ memoryCapturePaused: 'yes' }, 48) as Record<
      string,
      unknown
    >;

    expect(result.memoryCapturePaused).toBe(false);
  });
});
