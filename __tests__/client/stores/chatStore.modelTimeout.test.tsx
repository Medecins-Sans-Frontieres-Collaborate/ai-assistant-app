import { StreamInterruptedError } from '@/lib/utils/shared/chat/streamParser';

import { Conversation, MessageType } from '@/types/chat';
import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { ApiError, chatService } from '@/client/services';
import { useChatStore } from '@/client/stores/chatStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-hot-toast', () => ({
  default: {
    loading: vi.fn(() => 'toast-id'),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  },
}));

/**
 * User-controlled model timeout (issue #130): the Settings default and the
 * one-shot "wait longer" override travel as `timeoutMs`; a model-start
 * timeout is never silently retried on another model; and "prefer my
 * selected model" switches the automatic fallback off entirely.
 */
describe('chatStore - model timeout (issue #130)', () => {
  const initialChatState = useChatStore.getState();
  const initialSettingsState = useSettingsStore.getState();
  let chatSpy: ReturnType<typeof vi.spyOn>;

  const makeConversation = (): Conversation =>
    ({
      id: 'conv-1',
      name: 'test',
      messages: [
        { role: 'user', content: 'hello', messageType: MessageType.TEXT },
      ],
      model: OpenAIModels[OpenAIModelID.GPT_5_2_CHAT],
      prompt: '',
      temperature: 0.5,
      folderId: null,
    }) as unknown as Conversation;

  const sentOptions = (call = 0) =>
    chatSpy.mock.calls[call][2] as Record<string, unknown>;

  beforeEach(() => {
    vi.restoreAllMocks();
    useChatStore.setState(initialChatState, true);
    useSettingsStore.setState(initialSettingsState, true);
    chatSpy = vi
      .spyOn(chatService, 'chat')
      .mockResolvedValue(new ReadableStream());
  });

  describe('sendChatRequest', () => {
    it('sends the Settings default as timeoutMs and records it', async () => {
      useSettingsStore.setState({ modelTimeoutSeconds: 180 });

      await useChatStore.getState().sendChatRequest(makeConversation());

      expect(sentOptions().timeoutMs).toBe(180_000);
      expect(useChatStore.getState().lastRequestTimeoutSeconds).toBe(180);
    });

    it('clamps a hand-edited Settings value before sending', async () => {
      useSettingsStore.setState({ modelTimeoutSeconds: 999_999 });

      await useChatStore.getState().sendChatRequest(makeConversation());

      expect(sentOptions().timeoutMs).toBe(600_000);
    });

    it('consumes the one-shot override for exactly one send', async () => {
      useSettingsStore.setState({ modelTimeoutSeconds: 90 });
      useChatStore.setState({ pendingTimeoutSeconds: 360 });

      await useChatStore.getState().sendChatRequest(makeConversation());
      expect(sentOptions(0).timeoutMs).toBe(360_000);
      expect(useChatStore.getState().pendingTimeoutSeconds).toBeNull();
      expect(useChatStore.getState().lastRequestTimeoutSeconds).toBe(360);

      await useChatStore.getState().sendChatRequest(makeConversation());
      expect(sentOptions(1).timeoutMs).toBe(90_000);
    });
  });

  describe('retryFailedWithLongerTimeout', () => {
    it('re-sends the failed turn with the escalated timeout', async () => {
      const retrySpy = vi.fn(async () => {
        // The real retryFailedRequest → sendMessage → sendChatRequest
        // consumes the override; emulate the consumption here.
        useChatStore.setState({ pendingTimeoutSeconds: null });
      });
      useChatStore.setState({
        failedConversation: makeConversation(),
        retryFailedRequest: retrySpy,
      });

      await useChatStore.getState().retryFailedWithLongerTimeout(180);

      expect(retrySpy).toHaveBeenCalledTimes(1);
    });

    it('does nothing without a failed conversation', async () => {
      const retrySpy = vi.fn().mockResolvedValue(undefined);
      useChatStore.setState({
        failedConversation: null,
        retryFailedRequest: retrySpy,
      });

      await useChatStore.getState().retryFailedWithLongerTimeout(180);

      expect(retrySpy).not.toHaveBeenCalled();
      expect(useChatStore.getState().pendingTimeoutSeconds).toBeNull();
    });

    it('drops the override if the retry returned without sending', async () => {
      useChatStore.setState({
        failedConversation: makeConversation(),
        retryFailedRequest: vi.fn().mockResolvedValue(undefined),
      });

      await useChatStore.getState().retryFailedWithLongerTimeout(180);

      expect(useChatStore.getState().pendingTimeoutSeconds).toBeNull();
    });
  });

  describe('handleSendError', () => {
    it('never auto-falls back on a model-start timeout (the user decides)', () => {
      const retrySpy = vi.fn().mockResolvedValue(undefined);
      useChatStore.setState({ retryWithFallbackModel: retrySpy });

      useChatStore
        .getState()
        .handleSendError(
          new StreamInterruptedError(
            'The model did not start responding within 90 seconds.',
            'MODEL_TIMEOUT',
          ),
          makeConversation(),
        );

      expect(retrySpy).not.toHaveBeenCalled();
      expect(useChatStore.getState().errorCode).toBe('MODEL_TIMEOUT');
      expect(useChatStore.getState().failedConversation).not.toBeNull();
      expect(useChatStore.getState().errorIsRecoverable).toBe(true);
    });

    it('treats a non-streaming 408 the same way', () => {
      const retrySpy = vi.fn().mockResolvedValue(undefined);
      useChatStore.setState({ retryWithFallbackModel: retrySpy });

      useChatStore.getState().handleSendError(
        new ApiError('timed out', 408, 'Request Timeout', {
          code: 'REQUEST_TIMEOUT',
        }),
        makeConversation(),
      );

      expect(retrySpy).not.toHaveBeenCalled();
      expect(useChatStore.getState().errorCode).toBe('REQUEST_TIMEOUT');
    });

    it('auto-falls back on a 5xx by default…', () => {
      const retrySpy = vi.fn().mockResolvedValue(undefined);
      useChatStore.setState({ retryWithFallbackModel: retrySpy });

      useChatStore
        .getState()
        .handleSendError(
          new ApiError('boom', 500, 'Internal Server Error'),
          makeConversation(),
        );

      expect(retrySpy).toHaveBeenCalledTimes(1);
    });

    it('…but not when the user prefers their selected model', () => {
      const retrySpy = vi.fn().mockResolvedValue(undefined);
      useChatStore.setState({ retryWithFallbackModel: retrySpy });
      useSettingsStore.setState({ preferSelectedModel: true });

      useChatStore
        .getState()
        .handleSendError(
          new ApiError('boom', 500, 'Internal Server Error'),
          makeConversation(),
        );

      expect(retrySpy).not.toHaveBeenCalled();
      expect(useChatStore.getState().error).toBeTruthy();
      // The manual "Try with <model>" path stays available.
      expect(useChatStore.getState().failedConversation).not.toBeNull();
    });
  });
});
