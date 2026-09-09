import { ApiError } from '@/client/services/api/errors';
import { M365_BUILTIN_SERVER_ID } from '@/lib/services/m365/tools/toolCatalog';

import { Conversation, MessageType } from '@/types/chat';
import { InterpreterMode } from '@/types/interpreterMode';
import { OpenAIModelID, OpenAIModels } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';

import { useChatInputStore } from '@/client/stores/chatInputStore';
import { useChatStore } from '@/client/stores/chatStore';
import { useConversationStore } from '@/client/stores/conversationStore';
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

const notifyLimitsChanged = vi.hoisted(() => vi.fn());
vi.mock('@/client/hooks/settings/limitsUxEvents', () => ({
  LIMITS_CHANGED_EVENT: 'limits:changed',
  notifyLimitsChanged,
}));

const CONV_ID = 'conv-quota';

function makeConversation(
  overrides: Partial<Conversation> = {},
  id = CONV_ID,
): Conversation {
  return {
    id,
    // Non-empty name so finalizeMessage skips the async title generator.
    name: 'Quota test',
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
    ...overrides,
  };
}

const QUOTA_MESSAGE = "You've reached your limit of 20 requests today.";

/** The exact body app/api/chat/route.ts renders for a PipelineError 403. */
function quotaDenial(
  // `null` = body without metadata (undefined would take the default).
  metadata: Record<string, unknown> | null = {
    limitKey: 'model.requests',
    limit: 20,
    used: 20,
    resetAt: '2026-09-09T00:00:00.000Z',
    modelId: 'o3',
    series: 'o-series',
    requestModelId: 'o3',
  },
): ApiError {
  return new ApiError(QUOTA_MESSAGE, 403, 'Forbidden', {
    error: 'Critical Error',
    code: 'RATE_LIMIT_QUOTA_EXCEEDED',
    message: QUOTA_MESSAGE,
    ...(metadata ? { metadata } : {}),
  });
}

function streakFor(id: string) {
  return useChatStore.getState().errorStreaks[id];
}

/**
 * docs/LIMITS_USER_FACING_UX.md §7.4: an admin usage-limit denial is a
 * policy outcome, not a corrupted conversation — it must never feed the
 * repeated-failure escalation, must be parsed into `lastDenial` for the
 * error card, and must tell the limits/models queries to refetch.
 */
describe('chatStore usage-limit denials', () => {
  const initialState = useChatStore.getState();

  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState(initialState, true);
    useConversationStore.setState({
      conversations: [makeConversation()],
      selectedConversationId: CONV_ID,
      folders: [],
      isLoaded: true,
    });
    useChatInputStore.setState({
      searchMode: SearchMode.ALWAYS,
      interpreterMode: InterpreterMode.ALWAYS,
    });
  });

  describe('handleSendError (first attempt)', () => {
    it('parses the 403 metadata into lastDenial and keeps the server sentence', () => {
      useChatStore
        .getState()
        .handleSendError(quotaDenial(), makeConversation());

      const state = useChatStore.getState();
      expect(state.error).toBe(QUOTA_MESSAGE);
      expect(state.errorCode).toBe('RATE_LIMIT_QUOTA_EXCEEDED');
      expect(state.lastDenial).toEqual({
        limitKey: 'model.requests',
        limit: 20,
        used: 20,
        resetAt: '2026-09-09T00:00:00.000Z',
        modelId: 'o3',
        series: 'o-series',
        requestModelId: 'o3',
      });
      expect(state.isStreaming).toBe(false);
      expect(state.failedConversation?.id).toBe(CONV_ID);
    });

    it('does not count towards the failure streak', () => {
      useChatStore
        .getState()
        .handleSendError(quotaDenial(), makeConversation());
      useChatStore
        .getState()
        .handleSendError(quotaDenial(), makeConversation());
      useChatStore
        .getState()
        .handleSendError(quotaDenial(), makeConversation());

      expect(streakFor(CONV_ID)).toBeUndefined();
    });

    it('clears a streak built up by earlier, unrelated failures', () => {
      useChatStore
        .getState()
        .handleSendError(new Error('boom'), makeConversation());
      useChatStore
        .getState()
        .handleSendError(new Error('boom'), makeConversation());
      expect(streakFor(CONV_ID)?.count).toBe(2);

      useChatStore
        .getState()
        .handleSendError(quotaDenial(), makeConversation());

      expect(streakFor(CONV_ID)).toBeUndefined();
    });

    it('asks the limits and models queries to refetch, once per denial', () => {
      useChatStore
        .getState()
        .handleSendError(quotaDenial(), makeConversation());

      expect(notifyLimitsChanged).toHaveBeenCalledTimes(1);
    });

    it('keeps a boolean-gate denial (limit: false) with no counters', () => {
      useChatStore.getState().handleSendError(
        quotaDenial({
          limitKey: 'feature.webSearch.enabled',
          limit: false,
          requestModelId: 'gpt-5.2-chat',
        }),
        makeConversation(),
      );

      expect(useChatStore.getState().lastDenial).toEqual({
        limitKey: 'feature.webSearch.enabled',
        limit: false,
        requestModelId: 'gpt-5.2-chat',
      });
    });

    it('still treats a quota 403 with missing/malformed metadata as a denial (lastDenial null)', () => {
      useChatStore
        .getState()
        .handleSendError(quotaDenial(null), makeConversation());

      const state = useChatStore.getState();
      expect(state.errorCode).toBe('RATE_LIMIT_QUOTA_EXCEEDED');
      expect(state.lastDenial).toBeNull();
      expect(streakFor(CONV_ID)).toBeUndefined();
      expect(notifyLimitsChanged).toHaveBeenCalledTimes(1);

      useChatStore
        .getState()
        .handleSendError(
          quotaDenial({ limitKey: 42, limit: 'lots' }),
          makeConversation(),
        );
      expect(useChatStore.getState().lastDenial).toBeNull();
    });

    it('leaves every other failure on the existing path (streak recorded, no denial, no refetch)', () => {
      useChatStore
        .getState()
        .handleSendError(
          new ApiError('forbidden', 403, 'Forbidden', { code: 'FORBIDDEN' }),
          makeConversation(),
        );
      // (The message is ApiError.getUserMessage()'s generic 403 copy.)
      expect(streakFor(CONV_ID)).toMatchObject({
        errorCode: 'FORBIDDEN',
        count: 1,
      });
      expect(useChatStore.getState().lastDenial).toBeNull();

      // The burst limiter shares isRateLimitError() but is not a quota.
      useChatStore.getState().handleSendError(
        new ApiError('slow down', 429, 'Too Many Requests', {
          code: 'RATE_LIMIT_EXCEEDED',
        }),
        makeConversation(),
      );
      expect(streakFor(CONV_ID)?.errorCode).toBe('RATE_LIMIT_EXCEEDED');
      expect(useChatStore.getState().lastDenial).toBeNull();
      expect(notifyLimitsChanged).not.toHaveBeenCalled();
    });

    it('never walks the fallback chain for a quota denial on a catalog model', () => {
      const retrySpy = vi.fn().mockResolvedValue(undefined);
      useChatStore.setState({ retryWithFallbackModel: retrySpy });

      useChatStore.getState().handleSendError(
        quotaDenial(),
        makeConversation({
          model: OpenAIModels[OpenAIModelID.GPT_5_2_CHAT],
        }),
      );

      expect(retrySpy).not.toHaveBeenCalled();
      expect(useChatStore.getState().lastDenial?.limitKey).toBe(
        'model.requests',
      );
    });
  });

  describe('retryWithFallbackModel (fallback retry path)', () => {
    it('records the denial, skips the streak and refetches when the fallback model is denied', async () => {
      const sendSpy = vi.fn().mockRejectedValue(quotaDenial());
      useChatStore.setState({ sendChatRequest: sendSpy });
      const conversation = makeConversation({
        model: OpenAIModels[OpenAIModelID.GPT_5_2_CHAT],
      });

      await useChatStore.getState().retryWithFallbackModel(conversation);

      // A per-user limit hits every model identically: exactly one attempt.
      expect(sendSpy).toHaveBeenCalledTimes(1);
      const state = useChatStore.getState();
      expect(state.error).toBe(QUOTA_MESSAGE);
      expect(state.errorCode).toBe('RATE_LIMIT_QUOTA_EXCEEDED');
      expect(state.lastDenial?.limitKey).toBe('model.requests');
      expect(state.isRetrying).toBe(false);
      expect(streakFor(CONV_ID)).toBeUndefined();
      expect(notifyLimitsChanged).toHaveBeenCalledTimes(1);
    });
  });

  describe('lifecycle', () => {
    it('is cleared by the next send and by every error clear', () => {
      useChatStore
        .getState()
        .handleSendError(quotaDenial(), makeConversation());
      expect(useChatStore.getState().lastDenial).not.toBeNull();

      useChatStore.getState().initializeStreamingState(CONV_ID, 'chat.loading');
      expect(useChatStore.getState().lastDenial).toBeNull();

      useChatStore
        .getState()
        .handleSendError(quotaDenial(), makeConversation());
      useChatStore.getState().clearError();
      expect(useChatStore.getState().lastDenial).toBeNull();

      useChatStore
        .getState()
        .handleSendError(quotaDenial(), makeConversation());
      useChatStore.getState().setError('something else');
      expect(useChatStore.getState().lastDenial).toBeNull();

      useChatStore
        .getState()
        .handleSendError(quotaDenial(), makeConversation());
      useChatStore.getState().resetChat();
      expect(useChatStore.getState().lastDenial).toBeNull();
    });
  });

  describe('resendWithoutFeature', () => {
    it('turns web search off for the composer only and resends with search OFF', async () => {
      const sendSpy = vi.fn().mockResolvedValue(undefined);
      const failed = makeConversation({ defaultSearchMode: SearchMode.ALWAYS });
      useConversationStore.setState({ conversations: [failed] });
      useChatStore.setState({
        sendMessage: sendSpy,
        error: QUOTA_MESSAGE,
        errorCode: 'RATE_LIMIT_QUOTA_EXCEEDED',
        lastDenial: { limitKey: 'feature.webSearch.enabled', limit: false },
        failedConversation: failed,
        failedSearchMode: SearchMode.ALWAYS,
      });

      await useChatStore.getState().resendWithoutFeature('webSearch');

      expect(sendSpy).toHaveBeenCalledTimes(1);
      const [message, conversation, searchMode] = sendSpy.mock.calls[0];
      expect(message.content).toBe('hello');
      // The turn's mode travels as the explicit argument — this is what
      // actually changes the request.
      expect(searchMode).toBe(SearchMode.OFF);
      expect(useChatInputStore.getState().searchMode).toBe(SearchMode.OFF);
      // Interpreter untouched — only the gated feature changes.
      expect(useChatInputStore.getState().interpreterMode).toBe(
        InterpreterMode.ALWAYS,
      );
      // Regression guard: `conversation.defaultSearchMode` /
      // `defaultInterpreterMode` are exactly the two ChatInput.tsx keys its
      // "new conversation" effect resets on — draft, attachments and any
      // in-flight upload — so a one-click resend must never persist through
      // `updateConversation` with either field, and the object handed to
      // sendMessage must not carry an override either.
      expect(conversation.defaultSearchMode).toBe(SearchMode.ALWAYS);
      expect(
        useConversationStore
          .getState()
          .conversations.find((c) => c.id === CONV_ID)?.defaultSearchMode,
      ).toBe(SearchMode.ALWAYS);
      const state = useChatStore.getState();
      expect(state.error).toBeNull();
      expect(state.lastDenial).toBeNull();
      expect(state.failedConversation).toBeNull();
    });

    it('turns code interpreter off for the composer only, resends with the original search mode', async () => {
      const sendSpy = vi.fn().mockResolvedValue(undefined);
      const failed = makeConversation({
        defaultInterpreterMode: InterpreterMode.ALWAYS,
      });
      useConversationStore.setState({ conversations: [failed] });
      useChatStore.setState({
        sendMessage: sendSpy,
        failedConversation: failed,
        failedSearchMode: SearchMode.INTELLIGENT,
      });

      await useChatStore.getState().resendWithoutFeature('codeInterpreter');

      const [, conversation, searchMode] = sendSpy.mock.calls[0];
      expect(searchMode).toBe(SearchMode.INTELLIGENT);
      expect(useChatInputStore.getState().interpreterMode).toBe(
        InterpreterMode.OFF,
      );
      expect(useChatInputStore.getState().searchMode).toBe(SearchMode.ALWAYS);
      // Same regression guard as the web-search case, for the interpreter
      // conversation field.
      expect(conversation.defaultInterpreterMode).toBe(InterpreterMode.ALWAYS);
      expect(
        useConversationStore
          .getState()
          .conversations.find((c) => c.id === CONV_ID)?.defaultInterpreterMode,
      ).toBe(InterpreterMode.ALWAYS);
    });

    it("turns connectors off ('mcp'): disables every enabled server plus the M365 builtin and clears the pin", async () => {
      const sendSpy = vi.fn().mockResolvedValue(undefined);
      const failed = makeConversation({
        pinnedMcpServerId: 'srv-1',
        disabledMcpServerIds: ['srv-already-off'],
      });
      useConversationStore.setState({ conversations: [failed] });
      useSettingsStore.setState({
        mcpServers: [
          { id: 'srv-1', enabled: true } as any,
          { id: 'srv-2', enabled: true } as any,
          { id: 'srv-disabled', enabled: false } as any,
        ],
      });
      useChatStore.setState({
        sendMessage: sendSpy,
        errorCode: 'RATE_LIMIT_QUOTA_EXCEEDED',
        lastDenial: { limitKey: 'feature.mcp.enabled', limit: false },
        failedConversation: failed,
      });

      await useChatStore.getState().resendWithoutFeature('mcp');

      expect(sendSpy).toHaveBeenCalledTimes(1);
      const [, conversation] = sendSpy.mock.calls[0];
      // srv-disabled was never enabled — it should not need listing, but
      // being harmlessly present would also be fine; what matters is that
      // every ENABLED server plus the M365 builtin id is included.
      expect(conversation.disabledMcpServerIds).toEqual(
        expect.arrayContaining([
          'srv-already-off',
          'srv-1',
          'srv-2',
          M365_BUILTIN_SERVER_ID,
        ]),
      );
      expect(conversation.pinnedMcpServerId).toBeUndefined();
      const persisted = useConversationStore
        .getState()
        .conversations.find((c) => c.id === CONV_ID);
      expect(persisted?.disabledMcpServerIds).toEqual(
        expect.arrayContaining(['srv-1', 'srv-2', M365_BUILTIN_SERVER_ID]),
      );
      expect(persisted?.pinnedMcpServerId).toBeUndefined();
    });

    it('is a no-op without a failed conversation', async () => {
      const sendSpy = vi.fn();
      useChatStore.setState({ sendMessage: sendSpy, failedConversation: null });

      await useChatStore.getState().resendWithoutFeature('webSearch');

      expect(sendSpy).not.toHaveBeenCalled();
    });
  });
});
