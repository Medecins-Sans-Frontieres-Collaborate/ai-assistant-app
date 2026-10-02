'use client';

import { useEffect } from 'react';

import { isServedListRefined } from '@/client/hooks/conversation/useNewConversation';

import {
  moveConversationsOffSwitchedModels,
  planEuDefaultModelSwitch,
} from '@/lib/utils/shared/euDefaultModelSwitch';

import { OpenAIModelID } from '@/types/openai';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';

/**
 * Temporary one-time move off the gpt-5.2 models (gpt-5.2, gpt-5.2-chat)
 * onto gpt-5.4, for every region: the persisted default model and every
 * existing conversation still on one of them. Once-ness comes from the
 * persisted `euDefaultModelSwitchApplied` marker, not from a feature flag:
 * each browser is evaluated exactly once and never touched again, so a
 * user who picks 5.2 again afterwards keeps it. The `Eu` in the names is
 * historical — see lib/utils/shared/euDefaultModelSwitch.ts.
 * Mounted once in AppInitializer; delete this hook (keep the store field
 * and its v64 migration) one release after it ships.
 *
 * Conversations move in one pass rather than as each is opened: the marker
 * is per browser, so a per-conversation pass would need its own marker to
 * tell "not moved yet" from "moved, then put back on 5.2 by the user".
 */
export function useEuDefaultModelSwitch(): void {
  const region = useSettingsStore((s) => s.userRegion);
  const applied = useSettingsStore((s) => s.euDefaultModelSwitchApplied);
  const defaultModelId = useSettingsStore((s) => s.defaultModelId);
  const models = useSettingsStore((s) => s.models);
  const modelListSource = useSettingsStore((s) => s.modelListSource);
  const conversationsLoaded = useConversationStore((s) => s.isLoaded);

  useEffect(() => {
    // The marker covers conversations too, so it must not be set before
    // they have been read from storage.
    if (!conversationsLoaded) return;
    const plan = planEuDefaultModelSwitch({
      region,
      applied,
      defaultModelId,
      models,
      listRefined: isServedListRefined(modelListSource),
    });
    if (plan.action === 'none') return;
    const settings = useSettingsStore.getState();
    if (plan.switchDefault) {
      settings.setDefaultModelId(plan.model.id as OpenAIModelID);
    }
    const store = useConversationStore.getState();
    const moved = moveConversationsOffSwitchedModels(
      store.conversations,
      plan.model,
    );
    if (moved !== store.conversations) {
      // setConversations, not updateConversation: the latter stamps "now"
      // on updatedAt (see nudgeUpdatedAt for why that matters here).
      store.setConversations(moved);
    }
    settings.markEuDefaultModelSwitchApplied();
  }, [
    region,
    applied,
    defaultModelId,
    models,
    modelListSource,
    conversationsLoaded,
  ]);
}
