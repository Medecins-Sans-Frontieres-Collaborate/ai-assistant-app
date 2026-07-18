import { useCallback, useMemo, useRef } from 'react';

import { probeLocalRuntime } from '@/client/services/models/localRuntimeProbe';
import { buildLocalModel } from '@/lib/services/models/localModels';

import {
  LOCAL_RUNTIMES,
  LocalRuntime,
  LocalRuntimeStatus,
} from '@/types/localRuntime';
import { OpenAIModel } from '@/types/openai';

import { useSettingsStore } from '@/client/stores/settingsStore';

export interface LocalRuntimeModels {
  /** Detection status per runtime, straight from the store. */
  statusByRuntime: Partial<Record<LocalRuntime, LocalRuntimeStatus>>;
  /** Picker-ready models per runtime; only 'ready' runtimes contribute. */
  modelsByRuntime: Partial<Record<LocalRuntime, OpenAIModel[]>>;
  /** Flat list for selection/lookup, mirroring the byom picker's shape. */
  allModels: OpenAIModel[];
  /** True while any probe is in flight. */
  detecting: boolean;
  /** Probes every runtime. Safe to call repeatedly; overlapping runs are ignored. */
  detect: () => Promise<void>;
}

/**
 * Exposes locally-detected runtimes and the models they serve.
 *
 * Detection is EXPLICIT — this hook never probes on mount. Probing reaches
 * loopback, which on Chrome 142+ triggers a Local Network Access permission
 * prompt; firing that unprompted invites a reflexive "Block", and a denial is
 * sticky and awkward to undo. The settings pane calls `detect()` in response
 * to a user action, and the picker just reads the cached result.
 *
 * Status lives in the settings store rather than here because the picker
 * unmounts on close and both surfaces need the same view.
 */
export function useLocalRuntimeModels(): LocalRuntimeModels {
  const enabled = useSettingsStore((s) => s.localModelsFlagEnabled);
  const ports = useSettingsStore((s) => s.localRuntimePorts);
  const statusByRuntime = useSettingsStore((s) => s.localRuntimeStatus);
  const setLocalRuntimeStatus = useSettingsStore(
    (s) => s.setLocalRuntimeStatus,
  );

  // Guards against overlapping detect() runs (double-click, StrictMode
  // double-invoke) writing interleaved results.
  const inFlightRef = useRef(false);

  const detect = useCallback(async () => {
    if (!enabled || inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      for (const runtime of LOCAL_RUNTIMES) {
        setLocalRuntimeStatus(runtime, { state: 'checking' });
      }
      // Concurrent, but each result commits as it lands so the pane fills in
      // progressively rather than waiting on the slowest probe.
      await Promise.all(
        LOCAL_RUNTIMES.map(async (runtime) => {
          const status = await probeLocalRuntime(runtime, ports[runtime]);
          setLocalRuntimeStatus(runtime, status);
        }),
      );
    } finally {
      inFlightRef.current = false;
    }
  }, [enabled, ports, setLocalRuntimeStatus]);

  const modelsByRuntime = useMemo(() => {
    const out: Partial<Record<LocalRuntime, OpenAIModel[]>> = {};
    if (!enabled) return out;
    for (const runtime of LOCAL_RUNTIMES) {
      const status = statusByRuntime[runtime];
      if (status?.state !== 'ready') continue;
      out[runtime] = status.models.map((m) => buildLocalModel(runtime, m.id));
    }
    return out;
  }, [enabled, statusByRuntime]);

  const allModels = useMemo(
    () => Object.values(modelsByRuntime).flat(),
    [modelsByRuntime],
  );

  const detecting = useMemo(
    () =>
      LOCAL_RUNTIMES.some(
        (runtime) => statusByRuntime[runtime]?.state === 'checking',
      ),
    [statusByRuntime],
  );

  return {
    statusByRuntime: enabled ? statusByRuntime : {},
    modelsByRuntime,
    allModels,
    detecting,
    detect,
  };
}
