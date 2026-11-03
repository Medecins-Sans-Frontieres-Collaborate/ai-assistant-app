import { useConversations } from '@/client/hooks/conversation/useConversations';

import { SKILL_LIMITS } from '@/lib/services/skills/types';

import { isAgentShapedModelId } from '@/lib/utils/app/agentAttachment';
import {
  normalizeSkillIds,
  skillSelectionForRequest,
} from '@/lib/utils/shared/chat/skillSelection';

import { useUserSkills } from './useUserSkills';

import { useChatInputStore } from '@/client/stores/chatInputStore';

/** Conversation pins and ephemeral selections share one capped, accessible UI. */
export function useSkillSelection() {
  const query = useUserSkills();
  const { selectedConversation: conversation, updateConversation } =
    useConversations();
  const requested = useChatInputStore((state) => state.forcedSkillIds);
  const toggleRequested = useChatInputStore(
    (state) => state.toggleForcedSkillId,
  );
  const pinned = normalizeSkillIds(conversation?.pinnedSkillIds);
  const explicit =
    skillSelectionForRequest(pinned, requested).forcedSkillIds ?? [];
  const agentAttached =
    !!conversation?.bot ||
    !!conversation?.model?.agentId ||
    isAgentShapedModelId(conversation?.model?.id);
  const agentEligible =
    query.data?.filter((skill) => !skill.personal && skill.applyToAgents) ?? [];
  const disabled =
    !conversation ||
    (agentAttached &&
      (!agentEligible.length || conversation.model?.supportsTools === false));
  const visibleQuery = agentAttached
    ? { ...query, data: agentEligible }
    : query;

  const togglePin = (id: string) => {
    if (!conversation) return;
    const removing = pinned.includes(id);
    if (
      !removing &&
      (disabled ||
        (!explicit.includes(id) &&
          explicit.length >= SKILL_LIMITS.maxForcedPerTurn))
    )
      return;
    updateConversation(conversation.id, {
      pinnedSkillIds: removing
        ? pinned.filter((pin) => pin !== id)
        : normalizeSkillIds([...pinned, id]),
    });
    // Moving a one-shot selection to a pin should not consume two slots,
    // and unpinning must actually stop forced use on the next turn.
    if (requested.includes(id)) toggleRequested(id);
  };
  const toggleOnce = (id: string) => {
    if (requested.includes(id)) {
      toggleRequested(id);
      return;
    }
    if (
      disabled ||
      pinned.includes(id) ||
      explicit.length >= SKILL_LIMITS.maxForcedPerTurn
    )
      return;
    toggleRequested(id);
  };
  return {
    query: visibleQuery,
    pinned,
    requested,
    explicit,
    disabled,
    agentAttached,
    togglePin,
    toggleOnce,
  };
}
