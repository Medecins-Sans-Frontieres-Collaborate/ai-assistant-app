import { ApiError } from '@/client/services/api/errors';

import { Conversation, MessageType } from '@/types/chat';

import {
  REPEATED_FAILURE_THRESHOLD,
  useChatStore,
} from '@/client/stores/chatStore';
import { useConversationStore } from '@/client/stores/conversationStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The session-expired path must not run the real signOut in tests.
const forceSessionExpiredSignOut = vi.hoisted(() => vi.fn());
vi.mock('@/client/services/auth/sessionExpiry', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/client/services/auth/sessionExpiry')
    >();
  return { ...actual, forceSessionExpiredSignOut };
});

function makeConversation(id = 'conv-streak'): Conversation {
  return {
    id,
    // Non-empty name so finalizeMessage skips the async title generator.
    name: 'Streak test',
    messages: [
      {
        id: 'msg-user',
        role: 'user',
        content: 'hello',
        messageType: MessageType.TEXT,
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
  };
}

function streakFor(id: string) {
  return useChatStore.getState().errorStreaks[id];
}

function failWith(message: string, conversation = makeConversation()) {
  useChatStore.getState().handleSendError(new Error(message), conversation);
}

/**
 * Repeated-failure catch-all: identical consecutive failures accumulate a
 * per-conversation streak; at REPEATED_FAILURE_THRESHOLD the banner
 * escalates ("conversation may be corrupted" + start-new + debug download).
 */
describe('chatStore failure streaks', () => {
  beforeEach(() => {
    useChatStore.setState({
      isStreaming: false,
      streamingContent: '',
      streamingConversationId: null,
      error: null,
      errorCode: null,
      errorStreaks: {},
      abortController: null,
      isRetrying: false,
      regeneratingIndex: null,
      failedConversation: null,
      failedSearchMode: undefined,
      errorIsRecoverable: true,
    });
    useConversationStore.setState({
      conversations: [makeConversation()],
      selectedConversationId: 'conv-streak',
      folders: [],
      isLoaded: true,
    });
    forceSessionExpiredSignOut.mockClear();
  });

  it('exports a threshold of 3', () => {
    expect(REPEATED_FAILURE_THRESHOLD).toBe(3);
  });

  it('increments on identical consecutive failures', () => {
    failWith('boom');
    failWith('boom');
    failWith('boom');

    expect(streakFor('conv-streak')).toEqual({
      message: 'boom',
      errorCode: null,
      count: 3,
    });
  });

  it('restarts at 1 when the message changes', () => {
    failWith('boom');
    failWith('boom');
    failWith('different failure');

    expect(streakFor('conv-streak')).toEqual({
      message: 'different failure',
      errorCode: null,
      count: 1,
    });
  });

  it('keeps the latest structured error code on the streak', () => {
    useChatStore.getState().handleSendError(
      new ApiError('bad request', 400, 'Bad Request', {
        code: 'VALIDATION_FAILED',
      }),
      makeConversation(),
    );

    expect(streakFor('conv-streak')?.errorCode).toBe('VALIDATION_FAILED');
  });

  it('tracks conversations independently', () => {
    failWith('boom', makeConversation('conv-a'));
    failWith('boom', makeConversation('conv-a'));
    failWith('boom', makeConversation('conv-b'));

    expect(streakFor('conv-a')?.count).toBe(2);
    expect(streakFor('conv-b')?.count).toBe(1);
  });

  it('is cleared by a successful turn (finalizeMessage)', async () => {
    failWith('boom');
    failWith('boom');

    await useChatStore.getState().finalizeMessage(
      {
        role: 'assistant',
        content: 'all good now',
        messageType: MessageType.TEXT,
      },
      makeConversation(),
    );

    expect(streakFor('conv-streak')).toBeUndefined();
  });

  it('is NOT cleared by finalizing a failed partial message', async () => {
    failWith('boom');

    await useChatStore.getState().finalizeMessage(
      {
        role: 'assistant',
        content: 'partial…',
        messageType: MessageType.TEXT,
        error: true,
      },
      makeConversation(),
    );

    expect(streakFor('conv-streak')?.count).toBe(1);
  });

  it('is NOT incremented by a user abort', () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';

    useChatStore.getState().handleSendError(abortError, makeConversation());

    expect(streakFor('conv-streak')).toBeUndefined();
  });

  it('is NOT incremented by the session-expired sign-out path', () => {
    useChatStore.getState().handleSendError(
      new ApiError('Session expired', 401, 'Unauthorized', {
        code: 'AUTH_SESSION_EXPIRED',
      }),
      makeConversation(),
    );

    expect(forceSessionExpiredSignOut).toHaveBeenCalledOnce();
    expect(streakFor('conv-streak')).toBeUndefined();
  });

  it('is NOT recorded without a conversation to key on', () => {
    useChatStore.getState().handleSendError(new Error('boom'));

    expect(useChatStore.getState().errorStreaks).toEqual({});
  });

  it('survives a banner dismiss — dismissing fixes nothing', () => {
    failWith('boom');
    failWith('boom');

    useChatStore.getState().clearError();

    expect(useChatStore.getState().error).toBeNull();
    expect(streakFor('conv-streak')?.count).toBe(2);
  });
});
