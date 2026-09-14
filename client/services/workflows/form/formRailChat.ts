'use client';

import { recordWorkflowUsage } from '@/client/services/workflows/workflowUsageRecorder';

import {
  Conversation,
  Message,
  MessageType,
  isAssistantMessageGroup,
} from '@/types/chat';
import { FormFillWorkflowState } from '@/types/formFill';

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
 * Form-workflow override for the conversation rail's send path (wired via
 * the registry's `railSend`). Streams an answer grounded in the active
 * document's ledger from /api/workflows/form/chat. Read-only: the Fill run
 * and the review queue are the single write path into the ledger.
 */
export async function sendRailMessage(
  conversation: Conversation,
  text: string,
): Promise<void> {
  const conversationStore = useConversationStore.getState();
  const chatStore = useChatStore.getState();
  const state =
    conversation.workflowState?.kind === 'form-fill'
      ? (conversation.workflowState as FormFillWorkflowState)
      : undefined;
  const document = state?.documents.find(
    (d) => d.id === state.activeDocumentId,
  );

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

  let displayText = '';
  let failed: string | null = null;
  if (!document) {
    // Nothing to ground in yet; a canned nudge beats a model call.
    displayText = 'Attach a template first, then I can help with the fields.';
  } else {
    try {
      const response = await fetch('/api/workflows/form/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: railMessages,
          template: document.template,
          language: document.language,
          fields: document.fields,
          questions: document.questions,
          sources: state?.sources ?? [],
          modelId: conversation.model?.id,
          conversationId: conversation.id,
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
          if (
            event.type === 'workflow_event' &&
            event.payload.type === 'usage'
          ) {
            recordWorkflowUsage(conversation.id, event.payload.data);
          } else if (
            event.type === 'workflow_event' &&
            event.payload.type === 'error'
          ) {
            failed =
              (event.payload.data as { message?: string })?.message ??
              'Form chat failed';
          }
        }
        if (scan.displayDelta) {
          displayText += scan.displayDelta;
          useChatStore.getState().appendStreamingContent(scan.displayDelta);
        }
      }
    } catch (error) {
      if (!signal?.aborted) {
        failed = error instanceof Error ? error.message : 'Form chat failed';
      }
    }
  }

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
