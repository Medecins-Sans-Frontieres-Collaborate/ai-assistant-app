import { ApiError } from '@/client/services/api/errors';

import { useChatStore } from '@/client/stores/chatStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Keep the real classifier (isSessionExpiredApiError) but capture the
// sign-out side effect — its module-level once-guard and next-auth signOut
// must not run in tests.
const forceSessionExpiredSignOut = vi.hoisted(() => vi.fn());
vi.mock('@/client/services/auth/sessionExpiry', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/client/services/auth/sessionExpiry')
    >();
  return { ...actual, forceSessionExpiredSignOut };
});

/**
 * A dead session (token refresh failing after a client-secret rotation) must
 * force a sign-out instead of the dead-end "Authentication required" banner
 * — every retry would fail identically until the user signs in again. The
 * submitted question is safe: it is persisted to the conversation store
 * before the request fires.
 */
describe('chatStore session-expiry sign-out', () => {
  beforeEach(() => {
    forceSessionExpiredSignOut.mockClear();
    useChatStore.setState({
      isStreaming: true,
      streamingContent: 'partial',
      streamingConversationId: 'conv-1',
      streamingToolCalls: [],
      streamingConsentRequests: [],
      error: null,
      errorCode: null,
      abortController: null,
      isRetrying: false,
      failedConversation: null,
      failedSearchMode: undefined,
      errorIsRecoverable: true,
    });
  });

  it.each(['AUTH_SESSION_EXPIRED', 'AUTH_FAILED'])(
    'forces sign-out (no banner) on a 401 with code %s',
    (code) => {
      useChatStore
        .getState()
        .handleSendError(
          new ApiError('Session expired', 401, 'Unauthorized', { code }),
        );

      expect(forceSessionExpiredSignOut).toHaveBeenCalledOnce();
      const state = useChatStore.getState();
      expect(state.error).toBeNull();
      expect(state.errorCode).toBeNull();
      expect(state.isStreaming).toBe(false);
      expect(state.failedConversation).toBeNull();
    },
  );

  it('keeps the informative banner for a 403 usage-limit denial', () => {
    useChatStore.getState().handleSendError(
      new ApiError('Monthly budget exhausted', 403, 'Forbidden', {
        code: 'RATE_LIMIT_QUOTA_EXCEEDED',
      }),
    );

    expect(forceSessionExpiredSignOut).not.toHaveBeenCalled();
    // The server's message (the only place the limit is stated) survives.
    expect(useChatStore.getState().error).toBe('Monthly budget exhausted');
  });

  it('does not sign out on a plain 401 without a session-death code', () => {
    useChatStore.getState().handleSendError(
      new ApiError('Unauthorized', 401, 'Unauthorized', {
        code: 'UNAUTHORIZED',
      }),
    );

    expect(forceSessionExpiredSignOut).not.toHaveBeenCalled();
    expect(useChatStore.getState().error).toBe(
      'Authentication required. Please sign in.',
    );
  });

  it('does not sign out on a server error', () => {
    useChatStore
      .getState()
      .handleSendError(new ApiError('boom', 500, 'Internal Server Error'));

    expect(forceSessionExpiredSignOut).not.toHaveBeenCalled();
    expect(useChatStore.getState().error).toBe(
      'Server error. Please try again later.',
    );
  });
});
