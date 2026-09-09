import { StreamInterruptedError } from '@/lib/utils/shared/chat/streamParser';

import { Conversation, MessageType } from '@/types/chat';

import { chatService } from '@/client/services';
import { useChatStore } from '@/client/stores/chatStore';
import { useConversationStore } from '@/client/stores/conversationStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const FILE_URL = '/api/file/abc123.pdf';

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

function makeConversation(): Conversation {
  return {
    id: 'conv-expired',
    name: '',
    messages: [
      {
        id: 'msg-user',
        role: 'user',
        content: [
          { type: 'text', text: 'summarize this report' },
          { type: 'file_url', url: FILE_URL, originalFilename: 'report.pdf' },
        ],
        messageType: MessageType.FILE,
      },
    ],
    model: {
      id: 'foundry-test-agent',
      name: 'Test Agent',
      maxLength: 4000,
      tokenLimit: 4000,
      isOrganizationAgent: true,
    } as any,
    prompt: '',
    temperature: 0.7,
    folderId: null,
    activeFiles: [
      {
        id: `${FILE_URL}-1`,
        url: FILE_URL,
        originalFilename: 'report.pdf',
        addedAt: '2026-08-01T00:00:00.000Z',
        sourceMessageId: 'msg-user',
        status: 'ready',
        pinned: true,
      },
    ],
  };
}

/**
 * Regression for the "expired attachment bricks the conversation" bug: the
 * blob behind a persisted file_url gets lifecycle-deleted, every send fails
 * with FILE_NOT_FOUND, and "Try again" used to replay the identical dead
 * payload forever.
 */
describe('chatStore expired-file (FILE_NOT_FOUND) repair', () => {
  beforeEach(() => {
    useChatStore.setState({
      isStreaming: false,
      streamingContent: '',
      streamingConversationId: null,
      error: null,
      errorCode: null,
      abortController: null,
      isRetrying: false,
      failedConversation: null,
      failedSearchMode: undefined,
      errorIsRecoverable: true,
    });
    useConversationStore.setState({
      conversations: [makeConversation()],
      selectedConversationId: 'conv-expired',
      folders: [],
      isLoaded: true,
    });
    vi.restoreAllMocks();
  });

  function failWithExpiredFile(fileUrl: string | undefined = FILE_URL) {
    useChatStore
      .getState()
      .handleSendError(
        new StreamInterruptedError(
          'An attached file is no longer available — uploaded files are stored for a limited time. Send your message without it, or upload the file again.',
          'FILE_NOT_FOUND',
          false,
          fileUrl,
        ),
        makeConversation(),
      );
  }

  it('strips the dead file_url from the persisted conversation', () => {
    failWithExpiredFile();

    const conv = useConversationStore.getState().conversations[0];
    expect(JSON.stringify(conv.messages)).not.toContain(FILE_URL);
    // The message text survives, with the removal note.
    const first = conv.messages[0] as { content: unknown };
    expect(first.content).toContain('summarize this report');
    expect(first.content).toContain('no longer available');
  });

  it('flags and unpins the matching active file', () => {
    failWithExpiredFile();

    const file =
      useConversationStore.getState().conversations[0].activeFiles?.[0];
    expect(file?.status).toBe('error');
    expect(file?.pinned).toBe(false);
    expect(file?.errorMessage).toContain('no longer available');
  });

  it('surfaces the error with its structured code', () => {
    failWithExpiredFile();

    const state = useChatStore.getState();
    expect(state.error).toContain('no longer available');
    expect(state.errorCode).toBe('FILE_NOT_FOUND');
  });

  it('refreshes the retry snapshot so "Try again" resends a clean history', async () => {
    failWithExpiredFile();

    // The snapshot must be the SANITIZED conversation, not the one captured
    // at send time — its message history no longer references the dead file.
    // (The activeFiles tray entry keeps the url on purpose: it drives the
    // error chip and retry affordance.)
    expect(
      JSON.stringify(useChatStore.getState().failedConversation?.messages),
    ).not.toContain(FILE_URL);

    const spy = vi
      .spyOn(chatService, 'chat')
      .mockResolvedValue(streamFromChunks(['ok']));

    await useChatStore.getState().retryFailedRequest();

    expect(spy).toHaveBeenCalledOnce();
    const [, messages] = spy.mock.calls[0];
    expect(JSON.stringify(messages)).not.toContain(FILE_URL);
  });

  it('falls back to the most recent attachment when the server names no file', () => {
    failWithExpiredFile(undefined);

    const conv = useConversationStore.getState().conversations[0];
    expect(JSON.stringify(conv.messages)).not.toContain(FILE_URL);
    expect(conv.activeFiles?.[0].status).toBe('error');
  });

  it('does not touch the conversation for other stream errors', () => {
    useChatStore
      .getState()
      .handleSendError(
        new StreamInterruptedError('tool loop crashed', 'INTERNAL_ERROR'),
        makeConversation(),
      );

    const conv = useConversationStore.getState().conversations[0];
    expect(JSON.stringify(conv.messages)).toContain(FILE_URL);
    expect(conv.activeFiles?.[0].status).toBe('ready');
    expect(useChatStore.getState().errorCode).toBe('INTERNAL_ERROR');
  });
});
