'use client';

import { useCallback, useMemo, useState } from 'react';

import { useSettingsStore } from '@/client/stores/settingsStore';

/**
 * Per-admin "hide from my admin lists" preference (settingsStore,
 * per browser). Purely presentational: hidden agents keep their rules,
 * delegations and visibility to users; the admin just doesn't see the row
 * until they flip "Show hidden".
 */
export function useHiddenAdminAgents() {
  const hiddenKeys = useSettingsStore((s) => s.hiddenAdminAgentKeys);
  const hideAdminAgent = useSettingsStore((s) => s.hideAdminAgent);
  const unhideAdminAgent = useSettingsStore((s) => s.unhideAdminAgent);
  const [showHidden, setShowHidden] = useState(false);

  const hiddenSet = useMemo(() => new Set(hiddenKeys), [hiddenKeys]);
  const isHidden = useCallback(
    (canonicalKey: string) => hiddenSet.has(canonicalKey),
    [hiddenSet],
  );

  /** Splits a list into what to render and how many rows were hidden. */
  const partition = useCallback(
    <T>(items: T[], keyOf: (item: T) => string) => {
      const hiddenCount = items.filter((i) => hiddenSet.has(keyOf(i))).length;
      const visible = showHidden
        ? items
        : items.filter((i) => !hiddenSet.has(keyOf(i)));
      return { visible, hiddenCount };
    },
    [hiddenSet, showHidden],
  );

  return {
    isHidden,
    hide: hideAdminAgent,
    unhide: unhideAdminAgent,
    showHidden,
    setShowHidden,
    partition,
  };
}
