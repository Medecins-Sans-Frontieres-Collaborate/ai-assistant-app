'use client';

import { IconRobot } from '@tabler/icons-react';
import React from 'react';

import { useTranslations } from 'next-intl';

import { useConversations } from '@/client/hooks/conversation/useConversations';
import {
  findAttachedAgent,
  useAvailableAgents,
} from '@/client/hooks/settings/useAvailableAgents';
import { useSettings } from '@/client/hooks/settings/useSettings';

import {
  agentModelSemantics,
  detachAgentUpdates,
  isAgentShapedModelId,
} from '@/lib/utils/app/agentAttachment';

import { CapabilityBubble } from '@/components/Chat/ChatInput/CapabilityBubble';

import { useChatInputStore } from '@/client/stores/chatInputStore';

/**
 * Bubble in the composer's capability row showing the agent attached to
 * this conversation — the sibling of ConnectorActivityBadge and the skill
 * bubbles, same icon-first shape (name on hover/focus), same "renders
 * nothing when inactive" rule, so the empty conversation adds zero chrome.
 * Click opens the capabilities tray (where the model semantics are spelled
 * out); the × detaches in place, restoring the remembered model when a
 * Foundry attachment had swapped it.
 */
export const AgentChip: React.FC = () => {
  const t = useTranslations('agentAttach');
  const { selectedConversation, updateConversation } = useConversations();
  const { agents } = useAvailableAgents();
  const { models, defaultModelId } = useSettings();
  const trayOpen = useChatInputStore((s) => s.connectorPinTrayOpen);
  const setTrayOpen = useChatInputStore((s) => s.setConnectorPinTrayOpen);

  if (!selectedConversation) return null;
  const attachedAgent = findAttachedAgent(agents, selectedConversation);
  const modelIsAgentShaped = isAgentShapedModelId(
    selectedConversation.model?.id,
  );
  if (!attachedAgent && !selectedConversation.bot && !modelIsAgentShaped) {
    return null;
  }

  // Resolution can lag discovery (24h React Query cache warming up) — fall
  // back to the synthesized model's name or the bot id rather than blinking.
  const name =
    attachedAgent?.name ??
    (modelIsAgentShaped
      ? selectedConversation.model.name
      : selectedConversation.bot) ??
    '';
  const semantics = attachedAgent
    ? agentModelSemantics(attachedAgent.kind)
    : modelIsAgentShaped
      ? 'own-model'
      : 'your-model';

  const handleDetach = () => {
    const fallbackModel =
      models.find((m) => m.id === defaultModelId) ?? models[0];
    updateConversation(
      selectedConversation.id,
      detachAgentUpdates(selectedConversation, models, fallbackModel),
    );
  };

  return (
    <CapabilityBubble
      icon={<IconRobot size={14} className="text-violet-500" />}
      label={name}
      title={`${name} — ${t(`semantics.${semantics}`)}`}
      ariaExpanded={trayOpen}
      onClick={() => setTrayOpen(!trayOpen)}
      onRemove={handleDetach}
      removeLabel={t('detach')}
    />
  );
};
