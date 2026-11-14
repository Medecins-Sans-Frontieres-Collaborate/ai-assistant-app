import {
  WORKSPACE_PICKUP_TIMEOUT_MS,
  WORKSPACE_UNAVAILABLE_REPLY,
  sendRailMessage,
} from '@/client/services/workflows/translationRailChat';

import { Conversation } from '@/types/chat';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useWorkflowRailStore } from '@/client/stores/workflowRailStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const chat = vi.hoisted(() => ({
  initializeStreamingState: vi.fn(),
  finalizeMessage: vi.fn(async () => undefined),
  clearStreamingState: vi.fn(),
  abortController: new AbortController(),
}));
vi.mock('@/client/stores/chatStore', () => ({
  useChatStore: { getState: () => chat },
}));

const ID = 'rail-conversation';
const conversation = { id: ID, messages: [] } as unknown as Conversation;
const parked = () => useWorkflowRailStore.getState().workspaceRequests[ID];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  useWorkflowRailStore.setState({ workspaceRequests: {}, workspaceRequest: 0 });
  useConversationStore.setState({ conversations: [conversation] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('translation rail send', () => {
  it('parks the instruction for the workspace and posts its reply', async () => {
    const sending = sendRailMessage(conversation, 'Say tableta');
    expect(parked()).toMatchObject({
      text: 'Say tableta',
      signal: chat.abortController.signal,
    });
    expect(useWorkflowRailStore.getState().workspaceRequest).toBe(1);
    expect(chat.initializeStreamingState).toHaveBeenCalledWith(
      ID,
      'chat.loading',
    );
    expect(
      useConversationStore
        .getState()
        .conversations[0].messages.map((m) => m.content),
    ).toEqual(['Say tableta']);

    // The workspace takes the request, works, and settles it.
    const taken = useWorkflowRailStore.getState().takeWorkspaceRequest(ID)!;
    taken.settle('One edit suggested.');
    await sending;

    expect(chat.finalizeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'assistant',
        content: 'One edit suggested.',
      }),
      expect.objectContaining({ id: ID }),
    );
    expect(chat.clearStreamingState).toHaveBeenCalledTimes(1);
  });

  it('does not give up on a request the workspace has taken, however long it runs', async () => {
    const sending = sendRailMessage(conversation, 'Be formal');
    const taken = useWorkflowRailStore.getState().takeWorkspaceRequest(ID)!;
    await vi.advanceTimersByTimeAsync(WORKSPACE_PICKUP_TIMEOUT_MS * 3);
    expect(chat.finalizeMessage).not.toHaveBeenCalled();
    taken.settle('Done.');
    await sending;
    expect(chat.finalizeMessage).toHaveBeenCalledTimes(1);
  });

  it('answers for itself when no workspace picks the request up', async () => {
    const sending = sendRailMessage(conversation, 'Be formal');
    await vi.advanceTimersByTimeAsync(WORKSPACE_PICKUP_TIMEOUT_MS - 1);
    expect(parked()).toBeDefined();
    await vi.advanceTimersByTimeAsync(1);
    await sending;
    expect(parked()).toBeUndefined();
    expect(chat.finalizeMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: WORKSPACE_UNAVAILABLE_REPLY }),
      expect.anything(),
    );
    expect(chat.clearStreamingState).toHaveBeenCalledTimes(1);
  });
});

describe('workspace request slot', () => {
  const request = (id: string) => ({ id, text: 't', settle: vi.fn() });

  it('hands a request to exactly one taker', () => {
    const store = useWorkflowRailStore.getState();
    store.submitWorkspaceRequest(ID, request('a'));
    expect(store.takeWorkspaceRequest(ID)?.id).toBe('a');
    expect(store.takeWorkspaceRequest(ID)).toBeUndefined();
  });

  it('leaves a newer request alone when asked for an older one', () => {
    const store = useWorkflowRailStore.getState();
    store.submitWorkspaceRequest(ID, request('b'));
    expect(store.takeWorkspaceRequest(ID, 'a')).toBeUndefined();
    expect(parked()?.id).toBe('b');
  });
});
