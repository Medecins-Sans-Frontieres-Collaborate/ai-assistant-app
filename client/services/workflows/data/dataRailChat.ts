'use client';

import { DIGEST_SAMPLE_ROWS } from '@/lib/services/workflows/data/chatPrompts';
import { profileTable } from '@/lib/services/workflows/data/columnStats';
import { strideSample } from '@/lib/services/workflows/data/tableUtils';

import {
  Conversation,
  Message,
  MessageType,
  isAssistantMessageGroup,
} from '@/types/chat';
import { DataAnalysisWorkflowState } from '@/types/workflow';

import { useChatStore } from '@/client/stores/chatStore';
import { useConversationStore } from '@/client/stores/conversationStore';
import { scanStreamEvents } from '@/lib/streamMarkers';
import { v4 as uuidv4 } from 'uuid';

const MAX_RAIL_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 1_000;

function entryToChatMessage(
  entry: Conversation['messages'][number],
): { role: 'user' | 'assistant'; content: string } | null {
  if (isAssistantMessageGroup(entry)) {
    const active = entry.versions[entry.activeIndex];
    const content = typeof active?.content === 'string' ? active.content : '';
    return content ? { role: 'assistant', content } : null;
  }
  if (entry.role !== 'user' && entry.role !== 'assistant') return null;
  const content = typeof entry.content === 'string' ? entry.content : '';
  return content ? { role: entry.role, content } : null;
}

/**
 * Data-workflow override for the conversation rail's send path (wired
 * via the workflow registry's `railSend`). Streams a grounded answer
 * from /api/workflows/data/chat over a digest of the table — schema,
 * exact client-computed column stats, and a deterministic row sample —
 * through the chatStore's streaming state, then persists the exchange.
 * Read-only: unlike the map rail there is no mutation path; the
 * workspace transform bar is the single write path.
 */
export async function sendRailMessage(
  conversation: Conversation,
  text: string,
): Promise<void> {
  const conversationStore = useConversationStore.getState();
  const chatStore = useChatStore.getState();
  const state =
    conversation.workflowState?.kind === 'data-analysis'
      ? (conversation.workflowState as DataAnalysisWorkflowState)
      : undefined;

  const userMessage: Message = {
    id: uuidv4(),
    role: 'user',
    content: text,
    messageType: MessageType.TEXT,
  };
  const messagesWithUser = [...conversation.messages, userMessage];
  conversationStore.updateConversation(conversation.id, {
    messages: messagesWithUser,
  });
  const conversationWithUser: Conversation = {
    ...conversation,
    messages: messagesWithUser,
  };

  chatStore.initializeStreamingState(conversation.id, 'chat.loading');
  const signal = useChatStore.getState().abortController?.signal;

  const railMessages = messagesWithUser
    .map(entryToChatMessage)
    .filter((m): m is NonNullable<typeof m> => m !== null)
    .slice(-MAX_RAIL_MESSAGES)
    .map((m) => ({ ...m, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));

  const columns = state?.columns ?? [];
  const rows = state?.rows ?? [];
  const stats = [...profileTable(columns, rows).values()];
  const sampleRows = strideSample(rows, DIGEST_SAMPLE_ROWS);

  let displayText = '';
  let failed: string | null = null;

  try {
    const response = await fetch('/api/workflows/data/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: railMessages,
        columns,
        sampleRows,
        stats,
        totalRowCount: rows.length,
        modelId: conversation.model?.id,
      }),
      signal,
    });
    if (!response.ok || !response.body) {
      let message = `Request failed (${response.status})`;
      try {
        const parsed = await response.json();
        if (parsed?.error) message = String(parsed.error);
      } catch {
        // non-JSON body
      }
      throw new Error(message);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    let processedIndex = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const scan = scanStreamEvents(buffered, processedIndex);
      processedIndex = scan.nextIndex;
      for (const event of scan.events) {
        if (event.type === 'workflow_event' && event.payload.type === 'error') {
          failed =
            (event.payload.data as { message?: string })?.message ??
            'Data chat failed';
        }
      }
      if (scan.displayDelta) {
        displayText += scan.displayDelta;
        useChatStore.getState().appendStreamingContent(scan.displayDelta);
      }
    }
  } catch (error) {
    if (!signal?.aborted) {
      failed = error instanceof Error ? error.message : 'Data chat failed';
    }
  }

  // Persist whatever answer we have (partial on abort), mirroring the
  // generic pipeline's behavior.
  const finalText = failed && !displayText ? failed : displayText;
  if (finalText.trim()) {
    const assistantMessage: Message = {
      id: uuidv4(),
      role: 'assistant',
      content: finalText,
      messageType: MessageType.TEXT,
    };
    await useChatStore
      .getState()
      .finalizeMessage(assistantMessage, conversationWithUser);
  }
  useChatStore.getState().clearStreamingState();
}
