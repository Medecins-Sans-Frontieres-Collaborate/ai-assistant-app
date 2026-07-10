'use client';

import { useEffect, useRef } from 'react';

import { useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';

import { useChat } from '@/client/hooks/chat/useChat';

import {
  Conversation,
  ConversationEntry,
  isAssistantMessageGroup,
} from '@/types/chat';

// Lazy: keeps Streamdown + Shiki + KaTeX out of the shell bundle until an
// assistant message actually renders in the rail (same approach as
// AssistantMessage in the chat surface).
const Streamdown = dynamic(
  () => import('streamdown').then((m) => m.Streamdown),
  { ssr: false },
);

/** Flattens a persisted message's content into displayable text. */
function entryText(entry: ConversationEntry): {
  role: 'user' | 'assistant' | 'system';
  text: string;
} {
  if (isAssistantMessageGroup(entry)) {
    const active = entry.versions[entry.activeIndex];
    return { role: 'assistant', text: contentToText(active?.content) };
  }
  return { role: entry.role, text: contentToText(entry.content) };
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === 'object' && 'text' in block
          ? String((block as { text: unknown }).text ?? '')
          : '',
      )
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

interface WorkflowRailMessagesProps {
  conversation: Conversation;
}

/**
 * Lightweight message list for the workflow rail. Deliberately independent
 * of ChatMessages, whose prop surface is coupled to the chat window's local
 * state (editing, versions, regenerate). The rail is a read view of the
 * conversation entries plus live streaming state.
 */
export function WorkflowRailMessages({
  conversation,
}: WorkflowRailMessagesProps) {
  const t = useTranslations('workflows');
  const { isStreaming, streamingContent, streamingConversationId } = useChat();
  const bottomRef = useRef<HTMLDivElement>(null);

  const streamingHere =
    isStreaming && streamingConversationId === conversation.id;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [conversation.messages.length, streamingHere, streamingContent]);

  const entries = conversation.messages
    .map(entryText)
    .filter((e) => e.role !== 'system' && e.text.trim().length > 0);

  if (entries.length === 0 && !streamingHere) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="max-w-[28ch] text-center text-sm text-gray-500 dark:text-gray-400">
          {t('shell.railEmpty')}
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 space-y-4 overflow-y-auto px-3 py-4">
      {entries.map((entry, index) =>
        entry.role === 'user' ? (
          <div key={index} className="flex justify-end">
            <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-800 dark:bg-surface-dark-elevated dark:text-gray-100">
              {entry.text}
            </div>
          </div>
        ) : (
          <div
            key={index}
            className="prose prose-sm max-w-none text-sm text-gray-800 dark:prose-invert dark:text-gray-100"
          >
            <Streamdown>{entry.text}</Streamdown>
          </div>
        ),
      )}
      {streamingHere && (
        <div className="prose prose-sm max-w-none text-sm text-gray-800 dark:prose-invert dark:text-gray-100">
          {streamingContent ? (
            <Streamdown>{streamingContent}</Streamdown>
          ) : (
            <p className="animate-pulse text-gray-500 dark:text-gray-400">
              {t('shell.assistantThinking')}
            </p>
          )}
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
