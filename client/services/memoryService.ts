/**
 * Memory Service
 *
 * Client-side service for extracting long-term user memories from a
 * completed exchange. Best-effort and fire-and-forget: any failure silently
 * no-ops (extraction usually returns zero operations anyway).
 */
import { windowMessagesForAPI } from '@/lib/utils/shared/chat/messageWindowing';

import { Conversation, Message } from '@/types/chat';
import { MemoryOperation } from '@/types/memory';

import { useMemoryStore } from '@/client/stores/memoryStore';
import { useSettingsStore } from '@/client/stores/settingsStore';

/** Only the tail of the exchange is relevant for fact extraction. */
const EXTRACTION_MAX_MESSAGES = 6;

/**
 * Extracts durable user facts from the latest messages and applies the
 * returned add/update/delete operations to the memory store.
 *
 * Callers gate on `memoriesEnabled && memoriesFlagEnabled` — this service
 * assumes the feature is on when invoked, but rechecks both gates (and
 * whether clearMemories ran) once the fetch resolves, so an in-flight
 * extraction can never resurrect memories the user just cleared or write
 * new ones after they opted out.
 *
 * @param conversation - The conversation (provenance for added memories)
 * @param flatMessages - Flattened messages (flattenEntriesForAPI output)
 */
export async function extractMemories(
  conversation: Conversation,
  flatMessages: Message[],
): Promise<void> {
  try {
    const messages = windowMessagesForAPI(
      flatMessages,
      EXTRACTION_MAX_MESSAGES,
    );
    if (messages.length === 0) {
      return;
    }

    const existingMemories = useMemoryStore
      .getState()
      .memories.map((m) => ({ id: m.id, text: m.text }));
    // Snapshot before the fetch: if clearMemories bumps this while the
    // request is in flight, the result must be dropped.
    const generationBefore = useMemoryStore.getState().clearGeneration;

    const response = await fetch('/api/chat/memories', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages,
        existingMemories,
        modelId: conversation.model.id,
      }),
    });

    if (!response.ok) {
      console.error(
        '[MemoryService] Failed to extract memories:',
        response.status,
      );
      return;
    }

    const result = (await response.json()) as {
      operations?: MemoryOperation[];
    };
    if (!Array.isArray(result.operations) || result.operations.length === 0) {
      return;
    }

    // Re-check both gates: the user may have opted out (or the flag flipped)
    // while the request was in flight.
    const settings = useSettingsStore.getState();
    if (!settings.memoriesEnabled || !settings.memoriesFlagEnabled) {
      return;
    }
    // Clear-all race: drop the result if the user wiped their memories
    // while the request was in flight.
    if (useMemoryStore.getState().clearGeneration !== generationBefore) {
      return;
    }

    useMemoryStore
      .getState()
      .applyOperations(result.operations, conversation.id);
  } catch (error) {
    console.error('[MemoryService] Error extracting memories:', error);
  }
}
