import { renderHook, waitFor } from '@testing-library/react';

import { useTranscriptionPolling } from '@/client/hooks/transcription/useTranscriptionPolling';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stores = vi.hoisted(() => ({
  chat: {} as Record<string, any>,
  conversations: {} as Record<string, any>,
  input: {} as Record<string, any>,
  updateMessage: vi.fn(),
  activateFile: vi.fn(),
}));
vi.mock('@/client/stores/chatStore', () => ({
  useChatStore: (selector: (state: any) => any) => selector(stores.chat),
}));
vi.mock('@/client/stores/chatInputStore', () => ({
  useChatInputStore: (selector: (state: any) => any) => selector(stores.input),
}));
vi.mock('@/client/stores/conversationStore', () => ({
  useConversationStore: Object.assign(
    (selector: (state: any) => any) => selector(stores.conversations),
    { getState: () => stores.conversations },
  ),
}));

describe('polling preserves transcript language caution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stores.chat = {
      pendingConversationTranscription: {
        conversationId: 'conv',
        jobId: 'job-1',
        filename: 'audio.wav',
        messageIndex: 0,
        startedAt: Date.now(),
        totalChunks: 1,
        languageMetadata: { language: 'ht', officiallySupported: false },
      },
      setConversationTranscriptionPending: vi.fn(),
      updateTranscriptionProgress: vi.fn(),
      setTranscriptionReconnecting: vi.fn(),
    };
    stores.conversations = {
      conversations: [],
      updateMessageWithTranscript: stores.updateMessage,
      updateConversation: vi.fn(),
      activateFile: stores.activateFile,
    };
    stores.input = {
      pendingTranscriptions: new Map(),
      updateTranscriptionStatus: vi.fn(),
      removePendingTranscription: vi.fn(),
      setTextFieldValue: vi.fn(),
      setFilePreviews: vi.fn(),
    };
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(['inline', 'blob', 'old endpoint'])(
    'retains metadata for %s completion without adding warning text to speech',
    async (mode) => {
      const transcript =
        mode === 'blob' ? 'spoken content '.repeat(1000) : 'spoken content';
      const serverMetadata =
        mode === 'old endpoint'
          ? undefined
          : { language: 'so', officiallySupported: false };
      const expectedMetadata =
        serverMetadata ??
        stores.chat.pendingConversationTranscription.languageMetadata;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          const data = url.includes('/status/')
            ? {
                status: 'Succeeded',
                transcript,
                jobType: 'chunked',
                languageMetadata: serverMetadata,
              }
            : url.endsWith('/store')
              ? {
                  filename: 'audio.wav',
                  jobId: 'job-1',
                  blobPath: 'stored-transcript',
                  expiresAt: '2030-01-01T00:00:00.000Z',
                }
              : {};
          return new Response(JSON.stringify({ data }), { status: 200 });
        }),
      );
      const { unmount } = renderHook(() => useTranscriptionPolling());
      await waitFor(() => expect(stores.activateFile).toHaveBeenCalled());
      expect(stores.updateMessage).toHaveBeenCalledWith(
        'conv',
        0,
        expect.any(String),
        'audio.wav',
        'job-1',
        expectedMetadata,
      );
      expect(
        stores.activateFile.mock.calls[0][1].processedContent,
      ).toMatchObject({
        type: 'transcript',
        content: transcript,
        languageMetadata: expectedMetadata,
      });
      expect(stores.updateMessage.mock.calls[0][2]).not.toContain(
        'officiallySupported',
      );
      unmount();
    },
  );
});
