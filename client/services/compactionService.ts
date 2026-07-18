/**
 * Compaction Service
 *
 * Client-side service that maintains a rolling LLM summary of the
 * conversation history dropped by context windowing. Best-effort and
 * fire-and-forget: every failure silently returns — a missing summary only
 * means the server sees the windowed messages alone, exactly like before
 * compaction existed.
 */
import { getCompactionBoundary } from '@/lib/utils/shared/chat/conversationCompaction';

import { Conversation, Message } from '@/types/chat';

import { useConversationStore } from '@/client/stores/conversationStore';

/** Cap on newly-uncovered messages sent per summarize call (route caps at 40 too). */
const MAX_SUMMARIZE_MESSAGES = 40;

/**
 * Refreshes the conversation's compaction summary when windowing has dropped
 * messages beyond what the stored summary covers.
 *
 * @param conversation - The conversation (post-exchange snapshot from the store)
 * @param flatMessages - Flattened messages (flattenEntriesForAPI output)
 * @param maxMessages - The clamped user-adjustable window size
 */
export async function updateConversationCompaction(
  conversation: Conversation,
  flatMessages: Message[],
  maxMessages: number,
): Promise<void> {
  try {
    const boundary = getCompactionBoundary(flatMessages, maxMessages);
    const covered = conversation.compaction?.upToEntryIndex ?? 0;
    if (boundary <= covered) {
      return;
    }

    // Newly-uncovered dropped middle: message 0 is always sent verbatim, so
    // the first summary starts at 1; refreshes start at the covered boundary.
    // Take the OLDEST uncovered messages up to the per-call cap — the
    // watermark below only advances over what was actually summarized, so
    // when the gap exceeds the cap (summarize outages, window-size drops)
    // successive exchanges catch up incrementally instead of silently
    // skipping the excess forever.
    const start = Math.max(1, covered);
    const newlyUncovered = flatMessages
      .slice(start, boundary)
      .slice(0, MAX_SUMMARIZE_MESSAGES);
    if (newlyUncovered.length === 0) {
      return;
    }

    const response = await fetch('/api/chat/summarize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: newlyUncovered,
        previousSummary: conversation.compaction?.summary,
        modelId: conversation.model.id,
      }),
    });

    if (!response.ok) {
      console.error(
        '[CompactionService] Failed to summarize:',
        response.status,
      );
      return;
    }

    const result = (await response.json()) as { summary?: string | null };
    if (!result.summary) {
      // Soft-fail from the route ({ summary: null }) — keep the old summary
      // and watermark; a later exchange will retry.
      return;
    }

    useConversationStore.getState().updateConversation(conversation.id, {
      compaction: {
        summary: result.summary,
        // Advance only over what was summarized (equals `boundary` whenever
        // the uncovered gap fits within the cap) so the stored contract
        // ("summary covers entries 1..upToEntryIndex-1") stays truthful.
        upToEntryIndex: start + newlyUncovered.length,
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('[CompactionService] Error updating compaction:', error);
  }
}
