import { Conversation, MessageType } from '@/types/chat';

import { chatService } from '@/client/services';
import { useChatStore } from '@/client/stores/chatStore';
import { useConversationStore } from '@/client/stores/conversationStore';
import { emitConsentOutcome, emitConsentRequest } from '@/lib/streamMarkers';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Builds a conversation containing one assistant message with a pending
 * approval consent marker. Used to verify outcome persistence flows.
 */
function makeConversationWithApproval(approvalId: string): Conversation {
  return {
    id: 'conv-1',
    name: 'test',
    messages: [
      {
        role: 'user',
        content: 'do the thing',
        messageType: MessageType.TEXT,
      },
      {
        type: 'assistant_group',
        activeIndex: 0,
        versions: [
          {
            content:
              'sure thing' +
              emitConsentRequest({
                kind: 'approval',
                approval_request_id: approvalId,
                tool_name: 'do_thing',
              }),
            messageType: MessageType.TEXT,
            createdAt: new Date().toISOString(),
          },
        ],
      } as any,
    ],
    model: { id: 'foundry-test', name: 'Test Agent' } as any,
    prompt: '',
    temperature: 0.5,
    folderId: null,
  };
}

/**
 * Builds a ReadableStream that emits the given chunks as Uint8Array writes
 * and closes. Used to fake the chat response stream.
 */
function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

function resetStores() {
  useChatStore.setState({
    currentMessage: undefined,
    isStreaming: false,
    streamingContent: '',
    streamingConversationId: null,
    citations: [],
    error: null,
    stopRequested: false,
    loadingMessage: null,
    abortController: null,
    submittedApprovals: new Map(),
    submittingApprovals: new Set(),
  });
  useConversationStore.setState({
    conversations: [],
    selectedConversationId: null,
    folders: [],
    searchTerm: '',
    isLoaded: true,
  });
}

describe('chatStore.submitApproval', () => {
  beforeEach(() => {
    resetStores();
    vi.restoreAllMocks();
  });

  it('marks the approval as submitting synchronously, then clears on success', async () => {
    const approvalId = 'mcpr_happy';
    const conv = makeConversationWithApproval(approvalId);
    useConversationStore.setState({
      conversations: [conv],
      selectedConversationId: conv.id,
    });

    // Stream that just contains a small text body — no outcome marker.
    // The submit's own rollback to "submitted" should still happen.
    const fakeStream = streamFromChunks([
      'sure',
      '\n\n<<<METADATA_START>>>{"threadId":"thread-1"}<<<METADATA_END>>>',
    ]);
    vi.spyOn(chatService, 'chat').mockResolvedValue(fakeStream);

    const promise = useChatStore
      .getState()
      .submitApproval(approvalId, true, conv, 1);

    // Synchronous side effect: submittingApprovals contains the id.
    expect(useChatStore.getState().submittingApprovals.has(approvalId)).toBe(
      true,
    );

    await promise;

    const state = useChatStore.getState();
    expect(state.submittingApprovals.has(approvalId)).toBe(false);
    expect(state.submittedApprovals.get(approvalId)).toBe(true);
  });

  it('persists outcome to the source message after success', async () => {
    const approvalId = 'mcpr_persist';
    const conv = makeConversationWithApproval(approvalId);
    useConversationStore.setState({
      conversations: [conv],
      selectedConversationId: conv.id,
    });

    vi.spyOn(chatService, 'chat').mockResolvedValue(streamFromChunks(['ok']));

    await useChatStore.getState().submitApproval(approvalId, true, conv, 1);

    const stored = useConversationStore
      .getState()
      .conversations.find((c) => c.id === conv.id);
    const entry = stored!.messages[1] as any;
    const activeVersion = entry.versions[entry.activeIndex];
    expect(activeVersion.approvalOutcomes?.[approvalId]).toBe(true);
  });

  it('rolls back submittingApprovals when the stream throws and does NOT mark submitted', async () => {
    const approvalId = 'mcpr_fail';
    const conv = makeConversationWithApproval(approvalId);
    useConversationStore.setState({
      conversations: [conv],
      selectedConversationId: conv.id,
    });

    vi.spyOn(chatService, 'chat').mockRejectedValue(new Error('network down'));

    await useChatStore.getState().submitApproval(approvalId, true, conv, 1);

    const state = useChatStore.getState();
    expect(state.submittingApprovals.has(approvalId)).toBe(false);
    expect(state.submittedApprovals.has(approvalId)).toBe(false);
  });

  it('applies a server-emitted CONSENT_OUTCOME marker to in-memory state', async () => {
    const approvalId = 'mcpr_outcome';
    const otherApprovalId = 'mcpr_other';
    const conv = makeConversationWithApproval(otherApprovalId);
    useConversationStore.setState({
      conversations: [conv],
      selectedConversationId: conv.id,
    });

    // The server auto-denies a different pending approval and emits a
    // CONSENT_OUTCOME marker mid-stream. The submit itself is for a
    // different id (mcpr_outcome) — but the outcome should also land.
    vi.spyOn(chatService, 'chat').mockResolvedValue(
      streamFromChunks([
        emitConsentOutcome({
          approval_request_id: otherApprovalId,
          approve: false,
        }),
        'continuing',
      ]),
    );

    await useChatStore
      .getState()
      .submitApproval(approvalId, true, conv, undefined);

    const state = useChatStore.getState();
    // The auto-denied approval is now recorded as denied in-memory.
    expect(state.submittedApprovals.get(otherApprovalId)).toBe(false);
  });
});
