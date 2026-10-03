'use client';

import { useEffect, useMemo, useState } from 'react';

import { isServedListRefined } from '@/client/hooks/conversation/useNewConversation';

import {
  ModelRetirement,
  listRetirements,
} from '@/lib/utils/shared/modelRetirement';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';

const CLOCK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * "Now" for retirement decisions: refreshed hourly and whenever the tab
 * regains focus. The windows are days wide, so this is plenty — what it
 * must not be is frozen at mount, or a tab left open across a boundary
 * would never show the notice or make the move.
 */
export function useRetirementClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const interval = setInterval(tick, CLOCK_INTERVAL_MS);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', tick);
    };
  }, []);
  return now;
}

const NONE: ReadonlyMap<string, ModelRetirement> = new Map();

/**
 * The models that are going away, by id, as the picker needs them: to mark
 * a retiring model before someone selects it and to keep family rows from
 * fronting one. Empty until /api/models has answered — the static seed
 * carries no retirement facts.
 *
 * Evaluated for the selected conversation's routing: US and EU deployments
 * retire separately, and a conversation pinned to the other region's
 * instance (`hostedRegion`) is served by that one (see retirementFacts).
 */
export function useModelRetirements(): ReadonlyMap<string, ModelRetirement> {
  const routedRegion = useConversationStore(
    (s) =>
      s.conversations.find((c) => c.id === s.selectedConversationId)
        ?.hostedRegion,
  );
  const models = useSettingsStore((s) => s.models);
  const region = useSettingsStore((s) => s.userRegion);
  const modelListSource = useSettingsStore((s) => s.modelListSource);
  const now = useRetirementClock();

  return useMemo(() => {
    if (!isServedListRefined(modelListSource)) return NONE;
    return new Map(
      listRetirements({
        models,
        region,
        now,
        routedRegion: routedRegion ?? region,
      }).map((retirement) => [retirement.model.id, retirement]),
    );
  }, [models, region, modelListSource, now, routedRegion]);
}
