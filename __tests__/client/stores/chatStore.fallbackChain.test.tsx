import { Conversation } from '@/types/chat';
import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { ApiError } from '@/client/services';
import { useChatStore } from '@/client/stores/chatStore';
import { getFallbackChain } from '@/config/models';
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
 * Tests for the error-fallback chain.
 *
 * The historical bug: the single fallback model was identical to the default
 * model, so users on the default model never got an auto-retry at all, and a
 * default-model outage had no alternative to fall back to. These tests pin
 * the fixed behavior: retry fires for default-model users, walks the chain
 * past failing models, and stops on errors that would fail on every model.
 */
describe('ChatStore - fallback chain', () => {
  const initialState = useChatStore.getState();

  const makeConversation = (modelId: OpenAIModelID): Conversation =>
    ({
      id: 'conv-1',
      name: 'Test conversation',
      messages: [{ role: 'user', content: 'hello' }],
      model: OpenAIModels[modelId],
      prompt: '',
      temperature: 1,
      folderId: null,
    }) as unknown as Conversation;

  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState(initialState, true);
  });

  describe('handleSendError', () => {
    it('auto-retries when the conversation uses the default model (regression)', () => {
      const retrySpy = vi.fn().mockResolvedValue(undefined);
      useChatStore.setState({ retryWithFallbackModel: retrySpy });
      const conversation = makeConversation(OpenAIModelID.GPT_5_2_CHAT);

      useChatStore
        .getState()
        .handleSendError(
          new ApiError('boom', 500, 'Internal Server Error'),
          conversation,
        );

      expect(retrySpy).toHaveBeenCalledTimes(1);
      expect(retrySpy).toHaveBeenCalledWith(conversation, undefined);
    });

    it('auto-retries on rate limiting (429)', () => {
      const retrySpy = vi.fn().mockResolvedValue(undefined);
      useChatStore.setState({ retryWithFallbackModel: retrySpy });

      useChatStore
        .getState()
        .handleSendError(
          new ApiError('slow down', 429, 'Too Many Requests'),
          makeConversation(OpenAIModelID.GPT_5_2_CHAT),
        );

      expect(retrySpy).toHaveBeenCalledTimes(1);
    });

    it('does not retry on non-429 client errors — they fail on every model', () => {
      const retrySpy = vi.fn().mockResolvedValue(undefined);
      useChatStore.setState({ retryWithFallbackModel: retrySpy });

      useChatStore
        .getState()
        .handleSendError(
          new ApiError('bad payload', 400, 'Bad Request'),
          makeConversation(OpenAIModelID.GPT_5_2_CHAT),
        );

      expect(retrySpy).not.toHaveBeenCalled();
      expect(useChatStore.getState().error).toBeTruthy();
    });

    it('does not retry on auth errors', () => {
      const retrySpy = vi.fn().mockResolvedValue(undefined);
      useChatStore.setState({ retryWithFallbackModel: retrySpy });

      useChatStore
        .getState()
        .handleSendError(
          new ApiError('unauthorized', 401, 'Unauthorized'),
          makeConversation(OpenAIModelID.GPT_5_2_CHAT),
        );

      expect(retrySpy).not.toHaveBeenCalled();
    });

    it('does not retry custom agents', () => {
      const retrySpy = vi.fn().mockResolvedValue(undefined);
      useChatStore.setState({ retryWithFallbackModel: retrySpy });
      const conversation = {
        ...makeConversation(OpenAIModelID.GPT_5_2_CHAT),
        model: { id: 'custom-abc', name: 'My Agent' },
      } as unknown as Conversation;

      useChatStore
        .getState()
        .handleSendError(new ApiError('boom', 500, 'ISE'), conversation);

      expect(retrySpy).not.toHaveBeenCalled();
    });

    it('does not start a second retry while one is in flight', () => {
      const retrySpy = vi.fn().mockResolvedValue(undefined);
      useChatStore.setState({
        retryWithFallbackModel: retrySpy,
        isRetrying: true,
      });

      useChatStore
        .getState()
        .handleSendError(
          new ApiError('boom', 500, 'ISE'),
          makeConversation(OpenAIModelID.GPT_5_2_CHAT),
        );

      expect(retrySpy).not.toHaveBeenCalled();
    });
  });

  describe('retryWithFallbackModel chain walking', () => {
    it('tries every remaining chain model in order when all of them fail', async () => {
      const sendSpy = vi
        .fn()
        .mockRejectedValue(new ApiError('boom', 500, 'Internal Server Error'));
      useChatStore.setState({ sendChatRequest: sendSpy });
      const conversation = makeConversation(OpenAIModelID.GPT_5_2_CHAT);

      await useChatStore.getState().retryWithFallbackModel(conversation);

      const expectedOrder = getFallbackChain().filter(
        (id) => id !== OpenAIModelID.GPT_5_2_CHAT,
      );
      const attemptedOrder = sendSpy.mock.calls.map(
        (call) => (call[0] as Conversation).model.id,
      );
      expect(attemptedOrder).toEqual(expectedOrder);

      const state = useChatStore.getState();
      expect(state.isRetrying).toBe(false);
      expect(state.error).toBeTruthy();
      expect(state.showModelSwitchPrompt).toBe(false);
    });

    it('stops and records the successful model when a later chain entry works', async () => {
      const stream = () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('Hello there'));
            controller.close();
          },
        });
      const sendSpy = vi
        .fn()
        .mockRejectedValueOnce(new ApiError('boom', 500, 'ISE'))
        .mockResolvedValueOnce(stream());
      useChatStore.setState({ sendChatRequest: sendSpy });
      const conversation = makeConversation(OpenAIModelID.GPT_5_2_CHAT);

      await useChatStore.getState().retryWithFallbackModel(conversation);

      const chainAfterDefault = getFallbackChain().filter(
        (id) => id !== OpenAIModelID.GPT_5_2_CHAT,
      );
      expect(sendSpy).toHaveBeenCalledTimes(2);

      const state = useChatStore.getState();
      expect(state.successfulFallbackModelId).toBe(chainAfterDefault[1]);
      expect(state.showModelSwitchPrompt).toBe(true);
      expect(state.originalModelId).toBe(OpenAIModelID.GPT_5_2_CHAT);
      expect(state.isRetrying).toBe(false);
      expect(state.error).toBeNull();
    });

    it('stops the chain when the user aborts mid-retry', async () => {
      const abortError = new Error('aborted');
      abortError.name = 'AbortError';
      const sendSpy = vi.fn().mockRejectedValue(abortError);
      useChatStore.setState({ sendChatRequest: sendSpy });

      await useChatStore
        .getState()
        .retryWithFallbackModel(makeConversation(OpenAIModelID.GPT_5_2_CHAT));

      expect(sendSpy).toHaveBeenCalledTimes(1);
      const state = useChatStore.getState();
      expect(state.error).toBeNull();
      expect(state.isRetrying).toBe(false);
    });

    it('stops the chain on a non-retryable client error', async () => {
      const sendSpy = vi
        .fn()
        .mockRejectedValue(new ApiError('bad payload', 400, 'Bad Request'));
      useChatStore.setState({ sendChatRequest: sendSpy });

      await useChatStore
        .getState()
        .retryWithFallbackModel(makeConversation(OpenAIModelID.GPT_5_2_CHAT));

      expect(sendSpy).toHaveBeenCalledTimes(1);
      const state = useChatStore.getState();
      expect(state.error).toBeTruthy();
      expect(state.isRetrying).toBe(false);
    });

    it('gives up immediately when every chain model has been attempted', async () => {
      const sendSpy = vi.fn();
      useChatStore.setState({ sendChatRequest: sendSpy });

      await useChatStore
        .getState()
        .retryWithFallbackModel(
          makeConversation(OpenAIModelID.GPT_5_2_CHAT),
          undefined,
          getFallbackChain(),
        );

      expect(sendSpy).not.toHaveBeenCalled();
      const state = useChatStore.getState();
      expect(state.error).toBeTruthy();
      expect(state.isRetrying).toBe(false);
    });
  });
});
