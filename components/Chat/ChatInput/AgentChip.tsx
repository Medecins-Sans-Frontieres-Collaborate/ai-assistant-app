'use client';

import { IconRobot, IconX } from '@tabler/icons-react';
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

import { useChatInputStore } from '@/client/stores/chatInputStore';

/**
 * Compact badge in the composer showing the agent attached to this
 * conversation — the sibling of ConnectorActivityBadge, same pill language,
 * same "renders nothing when inactive" rule, so the empty conversation adds
 * zero chrome. Click opens the capabilities tray (where the model semantics
 * are spelled out); the × detaches in place, restoring the remembered model
 * when a Foundry attachment had swapped it.
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

  const handleDetach = (e: React.MouseEvent) => {
    e.stopPropagation();
    const fallbackModel =
      models.find((m) => m.id === defaultModelId) ?? models[0];
    updateConversation(
      selectedConversation.id,
      detachAgentUpdates(selectedConversation, models, fallbackModel),
    );
  };

  return (
    <button
      type="button"
      onClick={() => setTrayOpen(!trayOpen)}
      aria-expanded={trayOpen}
      title={`${name} — ${t(`semantics.${semantics}`)}`}
      className="inline-flex items-center gap-1 rounded-full border border-gray-300 bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
    >
      <IconRobot size={14} className="text-violet-500" aria-hidden="true" />
      <span className="max-w-[7rem] truncate">{name}</span>
      <span
        role="button"
        tabIndex={0}
        onClick={handleDetach}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleDetach(e as unknown as React.MouseEvent);
          }
        }}
        aria-label={t('detach')}
        title={t('detach')}
        className="-mr-0.5 rounded-full p-0.5 text-gray-500 hover:bg-gray-300 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-500 dark:hover:text-gray-100"
      >
        <IconX size={11} aria-hidden="true" />
      </span>
    </button>
  );
};
