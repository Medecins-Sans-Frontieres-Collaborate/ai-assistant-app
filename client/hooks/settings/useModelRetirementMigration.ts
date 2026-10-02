'use client';

import { useEffect } from 'react';

import { isServedListRefined } from '@/client/hooks/conversation/useNewConversation';

import {
  moveConversationsToSuccessors,
  planRetirementMoves,
} from '@/lib/utils/shared/modelRetirement';

import { OpenAIModel, OpenAIModelID } from '@/types/openai';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';

/**
 * Moves the saved default model and every existing conversation off models
 * that are going away, onto their successor — see
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
 * limit-blind — and the record covers conversations, so it must not be
 * written before they have been read from storage.
 *
 * Conversations move in one pass rather than as each is opened: once-ness
 * is per browser, so a per-conversation pass would need its own marker to
 * tell "not moved yet" from "moved, then put back by the user".
 */
export function useModelRetirementMigration(): void {
  const region = useSettingsStore((s) => s.userRegion);
  const applied = useSettingsStore((s) => s.modelRetirementsApplied);
  const models = useSettingsStore((s) => s.models);
  const modelListSource = useSettingsStore((s) => s.modelListSource);
  const conversationsLoaded = useConversationStore((s) => s.isLoaded);

  useEffect(() => {
    if (!region || !conversationsLoaded) return;
    if (!isServedListRefined(modelListSource)) return;

    const moves = planRetirementMoves(
      { models, region, now: Date.now() },
      applied,
    );
    if (moves.length === 0) return;

    const successors = new Map<string, OpenAIModel>(
      moves.map((move) => [move.model.id, move.successor]),
    );

    const settings = useSettingsStore.getState();
    const defaultSuccessor = settings.defaultModelId
      ? successors.get(settings.defaultModelId)
      : undefined;
    if (defaultSuccessor) {
      settings.setDefaultModelId(defaultSuccessor.id as OpenAIModelID);
    }

    const store = useConversationStore.getState();
    const moved = moveConversationsToSuccessors(
      store.conversations,
      successors,
    );
    if (moved !== store.conversations) {
      // setConversations, not updateConversation: the latter stamps "now"
      // on updatedAt (see nudgeUpdatedAt for why that matters here).
      store.setConversations(moved);
    }

    settings.markModelRetirementsApplied(
      Object.fromEntries(
        moves.map((move) => [move.model.id, move.signal.trigger]),
      ),
    );
  }, [region, applied, models, modelListSource, conversationsLoaded]);
}
