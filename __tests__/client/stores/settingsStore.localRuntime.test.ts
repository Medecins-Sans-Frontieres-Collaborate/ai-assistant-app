import { useSettingsStore } from '@/client/stores/settingsStore';
import { beforeEach, describe, expect, it } from 'vitest';

describe('settingsStore migration (v34 → v35)', () => {
  const migrate = useSettingsStore.persist.getOptions().migrate!;

  it('backfills localRuntimePorts to {} when migrating from v34', () => {
    const result = migrate({} as Record<string, unknown>, 34) as Record<
      string,
      unknown
    >;
    expect(result.localRuntimePorts).toEqual({});
  });

  it('preserves existing overrides on a v35 store', () => {
    const result = migrate(
      { localRuntimePorts: { ollama: 12345 } } as Record<string, unknown>,
      35,
    ) as Record<string, unknown>;
    expect(result.localRuntimePorts).toEqual({ ollama: 12345 });
  });

  it('replaces a non-object persisted value rather than passing it through', () => {
    for (const bad of [null, 'nope', 42]) {
      const result = migrate(
        { localRuntimePorts: bad } as Record<string, unknown>,
        34,
      ) as Record<string, unknown>;
      expect(result.localRuntimePorts).toEqual({});
    }
  });
});

describe('persistence boundaries', () => {
  const partialize = useSettingsStore.persist.getOptions().partialize!;

  it('persists port overrides but never detection status or the flag mirror', () => {
    const persisted = partialize(useSettingsStore.getState()) as Record<
      string,
      unknown
    >;

    expect(persisted).toHaveProperty('localRuntimePorts');
    // A persisted "ready" would offer models that may not be running now, and
    // a persisted flag mirror would survive the LD flag being turned off.
    expect(persisted).not.toHaveProperty('localRuntimeStatus');
    expect(persisted).not.toHaveProperty('localModelsFlagEnabled');
  });
});

describe('setLocalRuntimePort', () => {
  beforeEach(() => {
    useSettingsStore.setState({ localRuntimePorts: {} });
  });

  it('stores a valid port', () => {
    useSettingsStore.getState().setLocalRuntimePort('ollama', 12345);
    expect(useSettingsStore.getState().localRuntimePorts.ollama).toBe(12345);
  });

  it('clears the override when given undefined', () => {
    useSettingsStore.getState().setLocalRuntimePort('ollama', 12345);
    useSettingsStore.getState().setLocalRuntimePort('ollama', undefined);
    expect(
      useSettingsStore.getState().localRuntimePorts.ollama,
    ).toBeUndefined();
  });

  it('refuses undialable values at the write boundary', () => {
    // This value decides where a request is sent, so it is validated on the
    // way in as well as on rehydrate.
    for (const bad of [0, -1, 70000, 1.5, NaN]) {
      useSettingsStore.getState().setLocalRuntimePort('ollama', bad);
      expect(
        useSettingsStore.getState().localRuntimePorts.ollama,
      ).toBeUndefined();
    }
  });
});
