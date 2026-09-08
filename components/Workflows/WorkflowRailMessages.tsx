'use client';

import { useEffect, useMemo, useRef } from 'react';

import { useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';

import { useChat } from '@/client/hooks/chat/useChat';

import { normalizeMathDelimiters } from '@/lib/utils/shared/markdown/normalizeMath';

import {
  Conversation,
  ConversationEntry,
  isAssistantMessageGroup,
} from '@/types/chat';

// Lazy: keeps Streamdown + Shiki + KaTeX out of the shell bundle until an
// assistant message actually renders in the rail (same approach as
// AssistantMessage in the chat surface). MathStreamdown is imported rather
// than Streamdown itself so the KaTeX-aware sanitize schema travels in the
// same async chunk — importing the plugin list separately would pull
// Streamdown back into the shell bundle.
const Streamdown = dynamic(
  () => import('@/components/Markdown/MathStreamdown'),
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

  // Normalized once per message list rather than on every render: the rail
  // re-renders on each streamed chunk, and re-walking every finished message
  // for math delimiters each time is pure waste.
  const entries = useMemo(
    () =>
      conversation.messages
        .map(entryText)
        .filter((e) => e.role !== 'system' && e.text.trim().length > 0)
        .map((e) =>
          e.role === 'assistant'
            ? { ...e, text: normalizeMathDelimiters(e.text) }
            : e,
        ),
    [conversation.messages],
  );

  const streamingMarkdown = useMemo(
    () => (streamingContent ? normalizeMathDelimiters(streamingContent) : ''),
    [streamingContent],
  );

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
            {/* Persisted entries are finished text: "static" skips block
                splitting and incomplete-markdown completion, which is also
                what keeps a multi-line `$$ … $$` in one piece. */}
            <Streamdown mode="static">{entry.text}</Streamdown>
          </div>
        ),
      )}
      {streamingHere && (
        <div className="prose prose-sm max-w-none text-sm text-gray-800 dark:prose-invert dark:text-gray-100">
          {streamingContent ? (
            <Streamdown mode="streaming">{streamingMarkdown}</Streamdown>
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
