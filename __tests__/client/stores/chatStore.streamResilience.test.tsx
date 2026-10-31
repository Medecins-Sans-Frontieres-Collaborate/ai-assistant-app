import { StreamParser } from '@/lib/utils/shared/chat/streamParser';
import { StreamInterruptedError } from '@/lib/utils/shared/chat/streamParser';

import { Conversation, MessageType } from '@/types/chat';
import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { ApiError } from '@/client/services';
import {
  STREAM_OFFLINE_CODE,
  STREAM_STALLED_CODE,
  isNonRetryableSendError,
  rewordOpaqueNetworkError,
  useChatStore,
} from '@/client/stores/chatStore';
import { emitAgentActivity } from '@/lib/streamMarkers';
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
 * Low-connectivity and long-turn resilience of the chat loop (adversarial
 * pass, 2026-10-30): partial answers are never silently re-run on another
 * model, Stop keeps what arrived, a dead connection is detected without
 * waiting for the browser, and the activity header keeps tracking later
 * tool rounds.
 */
describe('ChatStore - stream resilience', () => {
  const initialState = useChatStore.getState();

  const makeConversation = (): Conversation =>
    ({
      id: 'conv-1',
      name: 'Test conversation',
      messages: [{ role: 'user', content: 'hello' }],
      model: OpenAIModels[OpenAIModelID.GPT_5_2_CHAT],
      prompt: '',
      temperature: 1,
      folderId: null,
    }) as unknown as Conversation;

  const toolCall = {
    id: 'call_1',
    serverId: 'github',
    serverLabel: 'GitHub',
    toolName: 'create_issue',
    argumentsJson: '{}',
    status: 'completed',
    output: 'ok',
    durationMs: 10,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState(initialState, true);
  });

  describe('fallback decision vs partial state', () => {
    it('does NOT re-send on a fallback model when tool calls already ran (network break mid-loop)', () => {
      const retrySpy = vi.fn().mockResolvedValue(undefined);
      const finalizeSpy = vi.fn().mockResolvedValue(undefined);
      useChatStore.setState({
        retryWithFallbackModel: retrySpy,
        finalizeMessage: finalizeSpy,
        streamingToolCalls: [toolCall] as never,
        streamingContent: 'Created the issue, now',
      });

      useChatStore
        .getState()
        .handleSendError(new TypeError('Failed to fetch'), makeConversation());

      expect(retrySpy).not.toHaveBeenCalled();
      // The partial answer (with its tool record) is persisted, flagged.
      expect(finalizeSpy).toHaveBeenCalledTimes(1);
      const [message] = finalizeSpy.mock.calls[0];
      expect(message.error).toBe(true);
      expect(message.content).toBe('Created the issue, now');
      expect(message.toolCalls).toHaveLength(1);
      const state = useChatStore.getState();
      expect(state.isStreaming).toBe(false);
      expect(state.error).toMatch(/stopped responding before finishing/);
    });

    it('still re-sends when the server flagged the partial as a broken promise (retry)', () => {
      const retrySpy = vi.fn().mockResolvedValue(undefined);
      useChatStore.setState({
        retryWithFallbackModel: retrySpy,
        streamingContent: 'Here is your file: [missing]',
      });
      useChatStore
        .getState()
        .handleSendError(
          new StreamInterruptedError(
            'file missing',
            'GENERATED_FILES_UNAVAILABLE',
            true,
          ),
          makeConversation(),
        );
      expect(retrySpy).toHaveBeenCalledTimes(1);
    });

    it('never falls back when the caller forbids it (approval resend, post-stream failure)', () => {
      const retrySpy = vi.fn().mockResolvedValue(undefined);
      useChatStore.setState({ retryWithFallbackModel: retrySpy });
      useChatStore
        .getState()
        .handleSendError(
          new ApiError('boom', 500, 'Internal Server Error'),
          makeConversation(),
          undefined,
          { allowFallback: false },
        );
      expect(retrySpy).not.toHaveBeenCalled();
      expect(useChatStore.getState().error).toBeTruthy();
    });

    it('shares one classifier between the first attempt and the fallback chain', () => {
      expect(
        isNonRetryableSendError(
          new StreamInterruptedError('x', 'TOOL_LOOP_FAILED'),
        ),
      ).toBe(true);
      expect(
        isNonRetryableSendError(new StreamInterruptedError('x', 'Y', true)),
      ).toBe(false);
      expect(
        isNonRetryableSendError(new ApiError('bad', 400, 'Bad Request')),
      ).toBe(true);
      expect(
        isNonRetryableSendError(new ApiError('down', 503, 'Unavailable')),
      ).toBe(false);
      expect(isNonRetryableSendError(new TypeError('Failed to fetch'))).toBe(
        false,
      );
      expect(
        rewordOpaqueNetworkError('NS_ERROR_NET_PARTIAL_TRANSFER', false),
      ).toMatch(/connection was interrupted/);
      expect(rewordOpaqueNetworkError('Quota exceeded', false)).toBe(
        'Quota exceeded',
      );
    });
  });

  describe('Stop keeps the partial answer', () => {
    it('persists streamed text and tool records as a plain assistant message on a user Stop', () => {
      const finalizeSpy = vi.fn().mockResolvedValue(undefined);
      const controller = new AbortController();
      useChatStore.setState({
        finalizeMessage: finalizeSpy,
        abortController: controller,
        isStreaming: true,
        streamingContent: 'Two minutes of answer so far',
        streamingToolCalls: [toolCall] as never,
      });

      useChatStore.getState().requestStop();
      expect(controller.signal.aborted).toBe(true);
      const abortError = new Error('aborted');
      abortError.name = 'AbortError';
      useChatStore.getState().handleSendError(abortError, makeConversation());

      expect(finalizeSpy).toHaveBeenCalledTimes(1);
      const [message] = finalizeSpy.mock.calls[0];
      expect(message.content).toBe('Two minutes of answer so far');
      expect(message.toolCalls).toHaveLength(1);
      expect(message.error).toBeUndefined();
      const state = useChatStore.getState();
      expect(state.isStreaming).toBe(false);
      expect(state.stopRequested).toBe(false);
      expect(state.error).toBeNull();
      expect(state.streamingToolCalls).toEqual([]);
    });

    it('keeps nothing for an internal abort-and-resend (no stop requested)', () => {
      const finalizeSpy = vi.fn().mockResolvedValue(undefined);
      useChatStore.setState({
        finalizeMessage: finalizeSpy,
        isStreaming: true,
        streamingContent: 'interim',
      });
      const abortError = new Error('aborted');
      abortError.name = 'AbortError';
      useChatStore.getState().handleSendError(abortError, makeConversation());
      expect(finalizeSpy).not.toHaveBeenCalled();
    });
  });

  describe('read-inactivity watchdog', () => {
    const neverEndingStream = () =>
      new ReadableStream<Uint8Array>({
        start() {
          // never enqueues, never closes — a stalled connection
        },
      });

    it('surfaces a stalled stream as a non-retryable interruption', async () => {
      await expect(
        useChatStore
          .getState()
          .processStream(neverEndingStream(), new StreamParser(), null, {
            stallMs: 30,
          }),
      ).rejects.toMatchObject({
        name: 'StreamInterruptedError',
        code: STREAM_STALLED_CODE,
        retry: false,
      });
    });

    it('ends the wait immediately when the browser goes offline', async () => {
      const pending = useChatStore
        .getState()
        .processStream(neverEndingStream(), new StreamParser(), null, {
          stallMs: 60_000,
        });
      window.dispatchEvent(new Event('offline'));
      await expect(pending).rejects.toMatchObject({
        code: STREAM_OFFLINE_CODE,
      });
    });

    it('is disabled when stallMs is 0 (local runtimes)', async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => {
            controller.enqueue(encoder.encode('slow but fine'));
            controller.close();
          }, 40);
        },
      });
      const result = await useChatStore
        .getState()
        .processStream(stream, new StreamParser(), null, { stallMs: 0 });
      expect(result.finalContent).toBe('slow but fine');
    });
  });

  describe('activity header during multi-round turns', () => {
    it('keeps applying activity markers after text has streamed', async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('First part of the answer. '));
          controller.enqueue(
            encoder.encode(
              emitAgentActivity('chat.activity.usingNamedToolWithService', {
                tool: 'search_issues',
                service: 'GitHub',
              }),
            ),
          );
          controller.close();
        },
      });
      useChatStore.setState({ isStreaming: true, loadingMessage: null });
      await useChatStore
        .getState()
        .processStream(stream, new StreamParser(), null);
      const state = useChatStore.getState();
      expect(state.loadingMessage).toBe(
        'chat.activity.usingNamedToolWithService',
      );
      expect(state.loadingMessageParams).toEqual({
        tool: 'search_issues',
        service: 'GitHub',
      });
    });
  });

  describe('one stream at a time', () => {
    it('refuses a second send while a response is streaming', async () => {
      const sendSpy = vi.fn();
      useChatStore.setState({
        isStreaming: true,
        streamingConversationId: 'other-conv',
        sendChatRequest: sendSpy,
      });
      await useChatStore
        .getState()
        .sendMessage(
          { role: 'user', content: 'again', messageType: MessageType.TEXT },
          makeConversation(),
        );
      expect(sendSpy).not.toHaveBeenCalled();
      // The running stream's state is untouched.
      expect(useChatStore.getState().streamingConversationId).toBe(
        'other-conv',
      );
    });
  });
});
