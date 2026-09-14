'use client';

import { useFlags } from 'launchdarkly-react-client-sdk';
import { useEffect } from 'react';

import {
  EU_DEFAULT_MODEL_SWITCH_FROM,
  planEuDefaultModelSwitch,
} from '@/lib/utils/shared/euDefaultModelSwitch';

import { OpenAIModelID } from '@/types/openai';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';

/**
 * Temporary, flag-gated one-time switch of the persisted default model for
 * EU users from gpt-5.2-chat to gpt-5.4 (pricing, 2026-09-14). Fail-closed
 * on the `euDefaultModelSwitch` flag: nothing happens unless it is served
 * `true`. Mounted once in AppInitializer; safe to remove together with the
 * flag once the fleet has been through it.
 *
 * Also moves the currently selected conversation when it is still empty
 * and pinned to the old default — that is the one the user is looking at,
 * and an empty conversation has nothing to lose.
 */
export function useEuDefaultModelSwitch(): void {
  const { euDefaultModelSwitch } = useFlags();
  const flagOn = euDefaultModelSwitch === true;
  const region = useSettingsStore((s) => s.userRegion);
  const applied = useSettingsStore((s) => s.euDefaultModelSwitchApplied);
  const defaultModelId = useSettingsStore((s) => s.defaultModelId);
  const models = useSettingsStore((s) => s.models);

  useEffect(() => {
    const plan = planEuDefaultModelSwitch({
      flagOn,
      region,
      applied,
      defaultModelId,
      models,
    });
    if (plan.action === 'none') return;
    const settings = useSettingsStore.getState();
    if (plan.action === 'switch') {
      settings.setDefaultModelId(plan.model.id as OpenAIModelID);
      const conversations = useConversationStore.getState();
      const selected = conversations.conversations.find(
        (c) => c.id === conversations.selectedConversationId,
      );
      if (
        selected &&
        selected.messages.length === 0 &&
        selected.model?.id === EU_DEFAULT_MODEL_SWITCH_FROM
      ) {
        conversations.updateConversation(selected.id, { model: plan.model });
      }
    }
    settings.markEuDefaultModelSwitchApplied();
  }, [flagOn, region, applied, defaultModelId, models]);
}
