'use client';

import { useEffect, useState } from 'react';

import { isServedListRefined } from '@/client/hooks/conversation/useNewConversation';

import {
  AppliedRetirement,
  moveConversationsToSuccessors,
  planRetirementMoves,
} from '@/lib/utils/shared/modelRetirement';

import { OpenAIModelID } from '@/types/openai';

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

/**
 * Moves the saved default model and existing conversations off models that
 * are going away, onto their successor — see
 * lib/utils/shared/modelRetirement.ts for which models leave, when, and
 * where to. Mounted once in AppInitializer.
 *
 * Silent by design: for a dated retirement ModelRetirementNotice has been
 * announcing the move for weeks. Each retirement event is applied once per
 * browser (`modelRetirementsApplied`), so a user who picks the model again
 * afterwards keeps it.
 *
 * Waits (nothing recorded) until the region is known, /api/models has
 * answered and conversations are loaded: the successor must come from the
 * list this user is actually served — the static seed is region- and
 * limit-blind — and the first pass covers conversations, so it must not run
 * before they have been read from storage.
 *
 * Re-evaluated on the retirement clock and whenever the number of
 * conversations changes, so conversations that arrive after an event was
 * applied (a restored backup, an import, a sync pull) are caught up — see
 * RetirementMove.kind for how those are told apart from a user's own choice.
 */
export function useModelRetirementMigration(): void {
  const region = useSettingsStore((s) => s.userRegion);
  const applied = useSettingsStore((s) => s.modelRetirementsApplied);
  const models = useSettingsStore((s) => s.models);
  const modelListSource = useSettingsStore((s) => s.modelListSource);
  const conversationsLoaded = useConversationStore((s) => s.isLoaded);
  const conversationCount = useConversationStore((s) => s.conversations.length);
  const now = useRetirementClock();

  useEffect(() => {
    if (!region || !conversationsLoaded) return;
    if (!isServedListRefined(modelListSource)) return;

    const moves = planRetirementMoves({ models, region, now }, applied);
    if (moves.length === 0) return;
    const events = moves.filter((move) => move.kind === 'event');

    const settings = useSettingsStore.getState();
    const defaultMove = events.find(
      (move) => move.model.id === settings.defaultModelId,
    );
    if (defaultMove) {
      settings.setDefaultModelId(defaultMove.successor.id as OpenAIModelID);
    }

    const store = useConversationStore.getState();
    const moved = moveConversationsToSuccessors(
      store.conversations,
      moves,
      // Read after the default move above: a catch-up must judge untouched
      // conversations against the default as it now stands.
      useSettingsStore.getState().defaultModelId,
    );
    if (moved !== store.conversations) {
      // setConversations, not updateConversation: the latter stamps "now"
      // on updatedAt (see nudgedUpdatedAt for why that matters here).
      store.setConversations(moved);
    }

    if (events.length > 0) {
      // The wall clock, not the (up to an hour old) retirement clock: later
      // catch-ups compare conversation timestamps against this instant.
      const appliedAt = new Date().toISOString();
      settings.markModelRetirementsApplied(
        Object.fromEntries(
          events.map((move): [string, AppliedRetirement] => [
            move.model.id,
            {
              triggers: [
                ...new Set([
                  ...(applied[move.model.id]?.triggers ?? []),
                  ...move.signal.triggers,
                ]),
              ],
              appliedAt,
            },
          ]),
        ),
      );
    }
  }, [
    region,
    applied,
    models,
    modelListSource,
    conversationsLoaded,
    conversationCount,
    now,
  ]);
}
