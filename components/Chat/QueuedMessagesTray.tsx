'use client';

import { IconClockHour4, IconX } from '@tabler/icons-react';
import { useShallow } from 'zustand/react/shallow';

import { useTranslations } from 'next-intl';

import { useChatInputStore } from '@/client/stores/chatInputStore';
import { QueuedSend, useChatStore } from '@/client/stores/chatStore';

/** Text of a queued message for the chip (first line, trimmed). */
function previewText(entry: QueuedSend): string {
  const content = entry.message.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((part) =>
              part && typeof part === 'object' && 'text' in part
                ? String((part as { text?: string }).text ?? '')
                : '',
            )
            .filter(Boolean)
            .join(' ')
        : '';
  const firstLine = text.split('\n')[0]?.trim() ?? '';
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
}

/**
 * Messages typed while a response was streaming, waiting to be sent when it
 * finishes (useChatActions drains them in order). Cancel returns the text
 * to the composer.
 */
export function QueuedMessagesTray({
  conversationId,
}: {
  conversationId: string;
}) {
  const t = useTranslations();
  const entries = useChatStore(
    useShallow((state) =>
      state.queuedSends.filter(
        (entry) => entry.conversationId === conversationId,
      ),
    ),
  );
  const removeQueuedSend = useChatStore((state) => state.removeQueuedSend);
  const setTextFieldValue = useChatInputStore(
    (state) => state.setTextFieldValue,
  );

  if (entries.length === 0) return null;

  const cancel = (entry: QueuedSend) => {
    const removed = removeQueuedSend(entry);
    if (!removed) return;
    const text =
      typeof removed.message.content === 'string'
        ? removed.message.content
        : previewText(removed);
    if (text) {
      setTextFieldValue((prev) => (prev ? `${prev}\n${text}` : text));
    }
  };

  return (
    <div
      className="mx-4 mb-2 flex flex-col gap-1"
      role="status"
      aria-live="polite"
      data-testid="queued-messages-tray"
    >
      {entries.map((entry, index) => (
        <div
          key={entry.message.id ?? index}
          className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-200"
        >
          <IconClockHour4 size={14} className="shrink-0 opacity-70" />
          <span className="shrink-0 font-medium">
            {t('chat.queuedMessage.label')}
          </span>
          <span className="min-w-0 flex-1 truncate opacity-80">
            {previewText(entry) || t('chat.queuedMessage.attachmentOnly')}
          </span>
          <button
            type="button"
            onClick={() => cancel(entry)}
            className="shrink-0 rounded p-0.5 hover:bg-neutral-200 dark:hover:bg-neutral-700"
            aria-label={t('chat.queuedMessage.cancel')}
            title={t('chat.queuedMessage.cancel')}
          >
            <IconX size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
