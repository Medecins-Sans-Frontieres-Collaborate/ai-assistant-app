import { act, renderHook } from '@testing-library/react';
import toast from 'react-hot-toast';

import { useNewConversation } from '@/client/hooks/conversation/useNewConversation';

import { SearchMode } from '@/types/searchMode';

import { useConversationStore } from '@/client/stores/conversationStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/client/hooks/settings/useSettings', () => ({
  useSettings: () => ({
    defaultModelId: 'model-a',
    models: [
      { id: 'model-a', name: 'Model A' },
      { id: 'model-b', name: 'Model B' },
    ],
    temperature: 0.3,
    systemPrompt: 'be brief',
    defaultSearchMode: SearchMode.INTELLIGENT,
    defaultInterpreterMode: undefined,
  }),
}));

const emptyConv = (id: string, folderId: string | null = null) =>
  ({
    id,
    name: '',
    messages: [],
    model: { id: 'model-b', name: 'Model B' },
    prompt: '',
    temperature: 0.5,
    folderId,
  }) as any;

describe('useNewConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConversationStore.setState({
      conversations: [],
      selectedConversationId: null,
      folders: [{ id: 'f1', name: 'Work', type: 'chat' }],
      searchTerm: '',
      isLoaded: true,
    });
  });

  it('creates a conversation in the requested folder with the default model and selects it', () => {
    const { result } = renderHook(() => useNewConversation());
    act(() => result.current('f1'));

    const { conversations, selectedConversationId } =
      useConversationStore.getState();
    expect(conversations).toHaveLength(1);
    const created = conversations[0];
    expect(created.folderId).toBe('f1');
    expect(created.model.id).toBe('model-a');
    expect(created.prompt).toBe('be brief');
    expect(created.temperature).toBe(0.3);
    expect(selectedConversationId).toBe(created.id);
  });

  it('defaults to the top level', () => {
    const { result } = renderHook(() => useNewConversation());
    act(() => result.current());
    expect(
      useConversationStore.getState().conversations[0].folderId,
    ).toBeNull();
  });

  it('reuses the latest empty chat by moving it into the folder instead of creating another', () => {
    useConversationStore.setState({
      conversations: [emptyConv('empty-1'), emptyConv('old', 'f1')],
      selectedConversationId: 'old',
    });
    const { result } = renderHook(() => useNewConversation());
    act(() => result.current('f1'));

    const { conversations, selectedConversationId } =
      useConversationStore.getState();
    expect(conversations).toHaveLength(2);
    expect(conversations.find((c) => c.id === 'empty-1')?.folderId).toBe('f1');
    expect(selectedConversationId).toBe('empty-1');
  });

  it('only toasts when the empty chat is already selected and already where asked', () => {
    useConversationStore.setState({
      conversations: [emptyConv('empty-1', 'f1')],
      selectedConversationId: 'empty-1',
    });
    const { result } = renderHook(() => useNewConversation());
    act(() => result.current('f1'));

    expect(toast).toHaveBeenCalledWith('This conversation is already empty');
    expect(useConversationStore.getState().conversations).toHaveLength(1);
  });

  it('carries the current conversation model over to the new chat', () => {
    useConversationStore.setState({
      conversations: [
        { ...emptyConv('busy'), messages: [{ role: 'user', content: 'hi' }] },
      ],
      selectedConversationId: 'busy',
    });
    const { result } = renderHook(() => useNewConversation());
    act(() => result.current());
    expect(useConversationStore.getState().conversations[0].model.id).toBe(
      'model-b',
    );
  });
});
