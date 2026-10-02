import { isModelSelectableInRegion } from '@/lib/utils/shared/modelRegion';
import { UserRegion } from '@/lib/utils/shared/region';

import { Conversation } from '@/types/chat';
import { OpenAIModel, OpenAIModelID } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';

/**
 * One-time move off the gpt-5.2 models onto the current default (gpt-5.4).
 *
 * Began (2026-09-14, pricing) as an EU-only switch of a persisted
 * gpt-5.2-chat default — hence the `eu` in this module, its hook and the
 * persisted marker, all kept so the marker needs no second store migration.
 * Widened 2026-10-02 to every region, to both 5.2 models, and to EXISTING
 * conversations: gpt-5.4 is the default everywhere now, and the 5.2 models
 * are the only current GPTs with Foundry agent routing, whose server-side
 * thread drifts from the conversation the user sees.
 *
 * The catalog default already moved, but `defaultModelId` is persisted per
 * browser and the models query only re-selects a default when the persisted
 * one is no longer selectable, and a conversation keeps the model it was
 * created with — so nothing leaves 5.2 on its own. This planner decides,
 * once per browser (the persisted `applied` marker), whether to move them.
 * Temporary: remove with the hook one release after it ships.
 *
 * Once-ness is the point: a user who goes back to a 5.2 model afterwards —
 * as their default or on any conversation — is never moved again. The
 * switch waits (no marker) until the server has answered with the list this
 * user is actually served and the target is selectable in it, so it can't
 * land on a missing deployment or on a model an admin limit hides from them.
 */
export const EU_DEFAULT_MODEL_SWITCH_FROM: readonly string[] = [
  OpenAIModelID.GPT_5_2_CHAT,
  OpenAIModelID.GPT_5_2,
];
export const EU_DEFAULT_MODEL_SWITCH_TO: string = OpenAIModelID.GPT_5_4;

const isSwitchedFrom = (modelId: string | undefined): boolean =>
  modelId !== undefined && EU_DEFAULT_MODEL_SWITCH_FROM.includes(modelId);

export interface EuDefaultModelSwitchInput {
  region: UserRegion | null | undefined;
  applied: boolean;
  defaultModelId: string | undefined;
  models: OpenAIModel[];
  /**
   * `/api/models` has answered (see `isServedListRefined`). Before that
   * `models` is only the static seed, which is region- and limit-blind.
   */
  listRefined: boolean;
}

export type EuDefaultModelSwitchPlan =
  | { action: 'none' }
  | {
      action: 'switch';
      model: OpenAIModel;
      /**
       * False when the persisted default is not a 5.2 model — never set
       * (the dynamic default already resolves to the new model) or a
       * deliberate choice of something else. Conversations still move.
       */
      switchDefault: boolean;
    };

export function planEuDefaultModelSwitch(
  input: EuDefaultModelSwitchInput,
): EuDefaultModelSwitchPlan {
  if (input.applied || !input.region || !input.listRefined) {
    return { action: 'none' };
  }
  const target = input.models.find(
    (m) =>
      m.id === EU_DEFAULT_MODEL_SWITCH_TO &&
      !m.isDisabled &&
      isModelSelectableInRegion(m, input.region),
  );
  if (!target) return { action: 'none' };
  return {
    action: 'switch',
    model: target,
    switchDefault: isSwitchedFrom(input.defaultModelId),
  };
}

/**
 * Advances `updatedAt` by the smallest step that still differs. The
 * per-conversation storage only writes a conversation whose `updatedAt`
 * changed, so the move has to touch it — but stamping "now" on every moved
 * conversation would reorder the folder view and show them all as edited
 * this minute.
 */
function nudgeUpdatedAt(updatedAt: string | undefined): string {
  const previous = updatedAt ? Date.parse(updatedAt) : NaN;
  return new Date(
    Number.isNaN(previous) ? Date.now() : previous + 1,
  ).toISOString();
}

/**
 * Moves every conversation on a 5.2 model onto `target`. Returns the SAME
 * array when nothing moved, so the caller can skip the store write.
 *
 * Mirrors what picking the model in ModelSelect does: an AGENT search mode
 * falls back to INTELLIGENT when the target has no Foundry agent, and a
 * remembered pre-agent model (`agentPrevModelId`) is moved too, so detaching
 * a Foundry agent later doesn't restore 5.2. `threadId` is left alone — it is
 * the handle the conversation's Foundry thread is deleted by.
 */
export function moveConversationsOffSwitchedModels(
  conversations: Conversation[],
  target: OpenAIModel,
): Conversation[] {
  let moved = false;
  const next = conversations.map((conversation) => {
    const onSwitchedModel = isSwitchedFrom(conversation.model?.id);
    const restoresSwitchedModel = isSwitchedFrom(conversation.agentPrevModelId);
    if (!onSwitchedModel && !restoresSwitchedModel) return conversation;
    moved = true;
    return {
      ...conversation,
      ...(onSwitchedModel ? { model: target } : {}),
      ...(restoresSwitchedModel ? { agentPrevModelId: target.id } : {}),
      ...(onSwitchedModel &&
      conversation.defaultSearchMode === SearchMode.AGENT &&
      !target.agentId
        ? { defaultSearchMode: SearchMode.INTELLIGENT }
        : {}),
      updatedAt: nudgeUpdatedAt(conversation.updatedAt),
    };
  });
  return moved ? next : conversations;
}
