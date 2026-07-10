'use client';

import { useFlags } from 'launchdarkly-react-client-sdk';

import { useTranslations } from 'next-intl';

import { useConversations } from '@/client/hooks/conversation/useConversations';

import { CONVERSATION_WORKFLOW_TYPES } from '@/types/workflow';

import { createInitialWorkflowState } from '@/components/Workflows/initialState';
import { WORKFLOW_META } from '@/components/Workflows/registryMeta';

/**
 * Quiet row of workflow entry points under the empty-state suggested
 * prompts. Selecting one converts the current (still empty) conversation
 * into that workflow type; the page-level branch then swaps the window to
 * the WorkflowShell. Typing in the chat input instead keeps a normal chat —
 * this row never intercepts the input.
 */
export function WorkflowChooser() {
  const t = useTranslations('workflows');
  // Fail-closed: brand-new surface; an LD outage must degrade to hidden,
  // not launch the feature. See docs/LAUNCHDARKLY_FLAGS.md.
  const { conversationWorkflows } = useFlags();
  const { selectedConversation, updateConversation } = useConversations();

  if (conversationWorkflows !== true) return null;
  if (!selectedConversation || selectedConversation.messages.length > 0) {
    return null;
  }
  if (selectedConversation.conversationType) return null;

  return (
    <div className="flex max-w-full flex-wrap items-center justify-center gap-x-1 gap-y-2 px-4">
      <span className="me-1 text-xs text-gray-500 dark:text-gray-400">
        {t('chooser.prompt')}
      </span>
      {CONVERSATION_WORKFLOW_TYPES.map((type) => {
        const meta = WORKFLOW_META[type];
        const Icon = meta.icon;
        return (
          <button
            key={type}
            type="button"
            onClick={() =>
              updateConversation(selectedConversation.id, {
                conversationType: type,
                workflowState: createInitialWorkflowState(type),
              })
            }
            title={t(`types.${meta.i18nKey}.description`)}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-surface-dark-elevated dark:hover:text-gray-100"
          >
            <Icon size={15} aria-hidden />
            {t(`types.${meta.i18nKey}.label`)}
          </button>
        );
      })}
    </div>
  );
}
