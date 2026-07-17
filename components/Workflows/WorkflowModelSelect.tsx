'use client';

import { useMemo } from 'react';

import { useTranslations } from 'next-intl';

import { isWorkflowEligibleModel } from '@/lib/services/workflows/shared/workflowModels';

import { Conversation } from '@/types/chat';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';

interface WorkflowModelSelectProps {
  conversation: Conversation;
}

/**
 * Compact model picker for workflow windows. Offers only models the
 * workflow routes can actually run (Azure-OpenAI base models — same
 * predicate the server enforces), and switches the conversation's model,
 * which the workspaces send as `modelId` and the rail chat uses natively.
 */
export function WorkflowModelSelect({
  conversation,
}: WorkflowModelSelectProps) {
  const t = useTranslations('workflows');
  const models = useSettingsStore((s) => s.models);
  const updateConversation = useConversationStore((s) => s.updateConversation);

  const eligible = useMemo(
    () => models.filter(isWorkflowEligibleModel),
    [models],
  );

  if (eligible.length < 2) return null;

  const currentId = conversation.model?.id;
  const currentIsEligible = eligible.some((m) => m.id === currentId);

  return (
    <select
      value={currentIsEligible ? currentId : ''}
      onChange={(e) => {
        const model = eligible.find((m) => m.id === e.target.value);
        if (model) updateConversation(conversation.id, { model });
      }}
      aria-label={t('shell.model')}
      title={t('shell.model')}
      className="max-w-[160px] truncate rounded-lg border border-gray-300 bg-transparent px-2 py-1 text-xs text-gray-700 dark:border-gray-700 dark:bg-surface-dark dark:text-gray-300"
    >
      {!currentIsEligible && (
        <option value="" disabled>
          {conversation.model?.name ?? ''}
        </option>
      )}
      {eligible.map((model) => (
        <option key={model.id} value={model.id}>
          {model.name}
        </option>
      ))}
    </select>
  );
}
