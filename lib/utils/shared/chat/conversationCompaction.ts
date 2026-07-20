import { Message } from '@/types/chat';

/**
 * Returns the exclusive flat-message index of the "dropped middle" that
 * `windowMessagesForAPI(messages, maxMessages)` would cut: messages
 * `1..boundary-1` are dropped (message 0 is always sent verbatim). Returns
 * `0` when nothing is dropped.
 *
 * MUST mirror `windowMessagesForAPI` exactly — including the
 * orphaned-leading-assistant drop — so the send-time summary attachment and
 * the post-stream summarizer always agree on what a summary covers.
 */
export function getCompactionBoundary(
  messages: Message[],
  maxMessages: number,
): number {
  if (messages.length <= maxMessages || maxMessages <= 0) {
    return 0;
  }

  if (maxMessages === 1) {
    // Degenerate window: only the last message survives (message 0 included
    // in the drop). Never hit in practice — the setting clamps to >= 20.
    return messages.length - 1;
  }

  // The kept tail is messages.slice(-(maxMessages - 1)); the window starts
  // at this index.
  let boundary = messages.length - (maxMessages - 1);

  // Orphaned assistant at the window start is dropped too — it answers a
  // user message that was dropped.
  if (messages[boundary].role === 'assistant') {
    boundary += 1;
  }

  return boundary;
}
