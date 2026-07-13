import { ModelSource, useSettingsStore } from '@/client/stores/settingsStore';
import { beforeEach, describe, expect, it } from 'vitest';

const makeSource = (overrides: Partial<ModelSource> = {}): ModelSource => ({
  id: 'ms-1',
  name: 'My Foundry Account',
  resourcePath:
    '/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.CognitiveServices/accounts/acct-1',
  createdAt: '2026-07-10T00:00:00.000Z',
  autoAddNewModels: true,
  excludedModelNames: [],
  selectedModelNames: [],
  ...overrides,
});

describe('settingsStore custom model sources (BYO Foundry accounts)', () => {
  beforeEach(() => {
    useSettingsStore.setState({ customModelSources: [] });
  });

  describe('Initial State', () => {
    it('starts with no custom model sources', () => {
      expect(useSettingsStore.getState().customModelSources).toEqual([]);
    });
  });

  describe('addCustomModelSource', () => {
    it('adds a source', () => {
      const source = makeSource();

      useSettingsStore.getState().addCustomModelSource(source);

      expect(useSettingsStore.getState().customModelSources).toEqual([source]);
    });

    it('appends after existing sources', () => {
      const first = makeSource();
      const second = makeSource({ id: 'ms-2', name: 'Second Account' });

      useSettingsStore.getState().addCustomModelSource(first);
      useSettingsStore.getState().addCustomModelSource(second);

      expect(useSettingsStore.getState().customModelSources).toEqual([
        first,
        second,
      ]);
    });
  });

  describe('updateCustomModelSource', () => {
    it('replaces the source with a matching id', () => {
      const source = makeSource();
      useSettingsStore.getState().addCustomModelSource(source);

      const updated = makeSource({
        name: 'Renamed',
        autoAddNewModels: false,
        selectedModelNames: ['gpt-5.2'],
      });
      useSettingsStore.getState().updateCustomModelSource(updated);

      expect(useSettingsStore.getState().customModelSources).toEqual([updated]);
    });

    it('leaves other sources untouched', () => {
      const first = makeSource();
      const second = makeSource({ id: 'ms-2', name: 'Second Account' });
      useSettingsStore.getState().addCustomModelSource(first);
      useSettingsStore.getState().addCustomModelSource(second);

      useSettingsStore
        .getState()
        .updateCustomModelSource(
          makeSource({ id: 'ms-2', name: 'Second Renamed' }),
        );

      const sources = useSettingsStore.getState().customModelSources;
      expect(sources[0]).toEqual(first);
      expect(sources[1].name).toBe('Second Renamed');
    });

    it('is a no-op for an unknown id', () => {
      const source = makeSource();
      useSettingsStore.getState().addCustomModelSource(source);

      useSettingsStore
        .getState()
        .updateCustomModelSource(makeSource({ id: 'ms-missing' }));

      expect(useSettingsStore.getState().customModelSources).toEqual([source]);
    });
  });

  describe('deleteCustomModelSource', () => {
    it('removes the source with a matching id', () => {
      const first = makeSource();
      const second = makeSource({ id: 'ms-2' });
      useSettingsStore.getState().addCustomModelSource(first);
      useSettingsStore.getState().addCustomModelSource(second);

      useSettingsStore.getState().deleteCustomModelSource('ms-1');

      expect(useSettingsStore.getState().customModelSources).toEqual([second]);
    });

    it('is a no-op for an unknown id', () => {
      const source = makeSource();
      useSettingsStore.getState().addCustomModelSource(source);

      useSettingsStore.getState().deleteCustomModelSource('ms-missing');

      expect(useSettingsStore.getState().customModelSources).toEqual([source]);
    });
  });
});

/**
 * v30 adds customModelSources (BYO Foundry accounts for model discovery).
 * Pre-v30 stores rehydrate the field as undefined; the migration backfills
 * it to an empty array so downstream `.map`/`.find` never throw.
 */
describe('settingsStore migration (v29 → v30)', () => {
  const migrate = useSettingsStore.persist.getOptions().migrate!;

  it('initializes customModelSources to [] when migrating from v29', () => {
    const persisted = {
      customAgentSources: [],
      // customModelSources intentionally absent (pre-v30 shape)
    } as Record<string, unknown>;

    const result = migrate(persisted, 29) as Record<string, unknown>;

    expect(Array.isArray(result.customModelSources)).toBe(true);
    expect(result.customModelSources).toEqual([]);
  });

  it('preserves existing customModelSources on a current-version store', () => {
    const sources = [makeSource({ autoAddNewModels: false })];
    const result = migrate(
      { customModelSources: sources } as Record<string, unknown>,
      30,
    ) as Record<string, unknown>;

    expect(result.customModelSources).toEqual(sources);
  });

  it('backfills customModelSources from a very old store alongside earlier migrations', () => {
    const result = migrate(
      { customAgents: [] } as Record<string, unknown>,
      17,
    ) as Record<string, unknown>;

    expect(result.customAgentSources).toEqual([]);
    expect(result.customModelSources).toEqual([]);
  });
});
