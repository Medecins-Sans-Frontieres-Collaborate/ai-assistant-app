'use client';

import { IconArrowUp, IconPlayerStopFilled } from '@tabler/icons-react';
import { KeyboardEvent, useCallback, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useChat } from '@/client/hooks/chat/useChat';
import { useChatActions } from '@/client/hooks/chat/useChatActions';

import { Conversation, Message, MessageType } from '@/types/chat';

import { WorkflowRailMessages } from './WorkflowRailMessages';
import { WORKFLOW_REGISTRY } from './registry';

import { useConversationStore } from '@/client/stores/conversationStore';
import { v4 as uuidv4 } from 'uuid';

interface WorkflowRailProps {
  conversation: Conversation;
}

/**
 * The conversation rail of a workflow window: the agent thread (messages,
 * streamed progress) plus a compact composer. Sends go through the same
 * chatStore pipeline as the main chat surface, so everything persists as
 * ordinary conversation entries.
 */
export function WorkflowRail({ conversation }: WorkflowRailProps) {
  const t = useTranslations('workflows');
  const [draft, setDraft] = useState('');
  const { sendMessage, isStreaming, streamingConversationId, requestStop } =
    useChat();
  const updateConversation = useConversationStore(
    (state) => state.updateConversation,
  );
  const { handleSend } = useChatActions({ updateConversation, sendMessage });

  const streamingHere =
    isStreaming && streamingConversationId === conversation.id;

  const submit = useCallback(() => {
    const text = draft.trim();
    if (!text || streamingHere) return;
    setDraft('');

    // Workflow-specific send override (e.g. the map's grounded chat).
    const railSend = conversation.conversationType
      ? WORKFLOW_REGISTRY[conversation.conversationType]?.railSend
      : undefined;
    if (railSend) {
      void railSend()
        .then((module) => module.sendRailMessage(conversation, text))
        .catch((error) => {
          console.error('[WorkflowRail] rail send failed:', error);
        });
      return;
    }

    const message: Message = {
      id: uuidv4(),
      role: 'user',
      content: text,
      messageType: MessageType.TEXT,
    };
    handleSend(message);
  }, [draft, streamingHere, handleSend, conversation]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkflowRailMessages conversation={conversation} />

      <div className="border-t border-gray-200 p-3 dark:border-gray-700">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            placeholder={t('shell.railInputPlaceholder')}
            className="min-h-[44px] flex-1 resize-none rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder-gray-500 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100 dark:placeholder-gray-400"
          />
          {streamingHere ? (
            <button
              type="button"
              onClick={requestStop}
              aria-label={t('shell.stopGenerating')}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-300 text-gray-900 hover:bg-gray-400 dark:bg-surface-dark-base dark:text-white dark:hover:bg-surface-dark-elevated"
            >
              <IconPlayerStopFilled size={16} aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim()}
              aria-label={t('shell.sendMessage')}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-300 text-gray-900 hover:bg-gray-400 disabled:pointer-events-none disabled:opacity-30 dark:bg-surface-dark-base dark:text-white dark:hover:bg-surface-dark-elevated"
            >
              <IconArrowUp size={16} aria-hidden />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
