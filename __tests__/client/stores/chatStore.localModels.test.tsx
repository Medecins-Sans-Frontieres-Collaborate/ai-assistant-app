import { LocalRuntimeError } from '@/client/services/chat/LocalChatService';
import { buildLocalModel } from '@/lib/services/models/localModels';

import { Conversation } from '@/types/chat';
import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { ApiError } from '@/client/services';
import { useChatStore } from '@/client/stores/chatStore';
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
 * The load-bearing guarantee for local models: a conversation the user chose
 * to keep on their own machine must never be silently shipped to a cloud
 * model. The auto-retry fallback in handleSendError is the one code path that
 * could do that, so it gets pinned here from several angles.
 */
describe('ChatStore - local models', () => {
  const initialState = useChatStore.getState();

  const localConversation = (): Conversation =>
    ({
      id: 'conv-local',
      name: 'Local chat',
      messages: [{ role: 'user', content: 'hello' }],
      model: buildLocalModel('ollama', 'llama3.1:8b'),
      prompt: '',
      temperature: 1,
      folderId: null,
    }) as unknown as Conversation;

  const cloudConversation = (): Conversation =>
    ({
      id: 'conv-cloud',
      name: 'Cloud chat',
      messages: [{ role: 'user', content: 'hello' }],
      model: OpenAIModels[OpenAIModelID.GPT_5_2_CHAT],
      prompt: '',
      temperature: 1,
      folderId: null,
    }) as unknown as Conversation;

  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState(initialState, true);
  });

  it('never falls back to a cloud model when a local runtime fails', () => {
    const retrySpy = vi.fn().mockResolvedValue(undefined);
    useChatStore.setState({ retryWithFallbackModel: retrySpy });

    useChatStore
      .getState()
      .handleSendError(
        new LocalRuntimeError('not_running', 'Could not reach loopback'),
        localConversation(),
      );

    expect(retrySpy).not.toHaveBeenCalled();
  });

  it('does not fall back even for error classes that WOULD retry on a cloud model', () => {
    // A 500 auto-retries for a normal model — proving the exclusion is keyed
    // on the model being local, not on the error type.
    const retrySpy = vi.fn().mockResolvedValue(undefined);
    useChatStore.setState({ retryWithFallbackModel: retrySpy });

    useChatStore
      .getState()
      .handleSendError(
        new ApiError('boom', 500, 'Internal Server Error'),
        localConversation(),
      );

    expect(retrySpy).not.toHaveBeenCalled();

    // Same error, cloud model: retry still fires, so the guard is scoped.
    useChatStore
      .getState()
      .handleSendError(
        new ApiError('boom', 500, 'Internal Server Error'),
        cloudConversation(),
      );

    expect(retrySpy).toHaveBeenCalledTimes(1);
  });

  it('treats a user stop as a clean abort, not an error', () => {
    const retrySpy = vi.fn().mockResolvedValue(undefined);
    useChatStore.setState({ retryWithFallbackModel: retrySpy });

    // The exact shape LocalChatService produces: a plain Error named
    // AbortError, so chatStore's `instanceof Error && name` guard matches in
    // every environment (DOMException is off the Error chain in some).
    const abort = new Error('Aborted');
    abort.name = 'AbortError';

    useChatStore.getState().handleSendError(abort, localConversation());

    expect(retrySpy).not.toHaveBeenCalled();
    expect(useChatStore.getState().error).toBeNull();
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it('surfaces a distinct, actionable message per failure reason', () => {
    const messages = new Map<string, string>();

    for (const reason of [
      'not_running',
      'cors_blocked',
      'model_missing',
      'http_error',
    ] as const) {
      useChatStore.setState(initialState, true);
      useChatStore
        .getState()
        .handleSendError(new LocalRuntimeError(reason), localConversation());
      messages.set(reason, useChatStore.getState().error ?? '');
    }

    // All four distinct and non-generic — each has a different user fix.
    expect(new Set(messages.values()).size).toBe(4);
    for (const message of messages.values()) {
      expect(message).not.toBe('Failed to send message');
      expect(message).toContain('Ollama');
    }

    // The permission cause must be named: a denied Local Network Access
    // prompt is indistinguishable from a refused connection.
    expect(messages.get('not_running')).toMatch(/local network access/i);
  });
});
