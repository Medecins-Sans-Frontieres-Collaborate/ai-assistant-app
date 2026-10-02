'use client';

import { useEffect } from 'react';

import { isServedListRefined } from '@/client/hooks/conversation/useNewConversation';
import { useRetirementClock } from '@/client/hooks/settings/useModelRetirements';

import {
  AppliedRetirement,
  moveConversationsToSuccessors,
  planRetirementMoves,
} from '@/lib/utils/shared/modelRetirement';

import { OpenAIModelID } from '@/types/openai';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';

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
    // US users can pin a conversation to the EU instance of a model, which
    // retires on its own schedule (EU users are always routed to the EU).
    const pinnedMoves =
      region === 'US'
        ? {
            EU: planRetirementMoves(
              { models, region, now, routedRegion: 'EU' },
              applied,
            ),
          }
        : undefined;
    const allMoves = [...moves, ...(pinnedMoves?.EU ?? [])];
    if (allMoves.length === 0) return;
    const events = allMoves.filter((move) => move.kind === 'event');

    const settings = useSettingsStore.getState();
    // The default follows home routing: new conversations are not pinned.
    const defaultMove = moves.find(
      (move) =>
        move.kind === 'event' && move.model.id === settings.defaultModelId,
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
      pinnedMoves,
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
      const record: Record<string, AppliedRetirement> = {};
      for (const move of events) {
        // Both routings can report the same model; their triggers add up.
        record[move.model.id] = {
          triggers: [
            ...new Set([
              ...(applied[move.model.id]?.triggers ?? []),
              ...(record[move.model.id]?.triggers ?? []),
              ...move.signal.triggers,
            ]),
          ],
          appliedAt,
        };
      }
      settings.markModelRetirementsApplied(record);
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
