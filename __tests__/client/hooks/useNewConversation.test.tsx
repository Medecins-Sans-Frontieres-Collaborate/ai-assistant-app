import { act, renderHook } from '@testing-library/react';
import toast from 'react-hot-toast';

import { useNewConversation } from '@/client/hooks/conversation/useNewConversation';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

// Mutable so individual tests can move the default or shrink the list.
const settingsState = vi.hoisted(() => ({
  defaultModelId: 'model-a' as string | undefined,
  models: [
    { id: 'model-a', name: 'Model A' },
    { id: 'model-b', name: 'Model B' },
  ] as { id: string; name: string }[],
  temperature: 0.3,
  systemPrompt: 'be brief',
  defaultSearchMode: 'intelligent',
  defaultInterpreterMode: undefined,
}));

vi.mock('@/client/hooks/settings/useSettings', () => ({
  useSettings: () => settingsState,
}));

// The real hook needs a QueryClientProvider (React Query) and the LD flag;
// what matters here is only the per-id answer it gives.
const availabilityById = vi.hoisted(
  () => new Map<string, { state: string; reason?: string }>(),
);
vi.mock('@/client/hooks/settings/useMyLimits', () => ({
  useModelAvailability: (id?: string) =>
    (id && availabilityById.get(id)) ?? { state: 'available' },
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
    availabilityById.clear();
    settingsState.defaultModelId = 'model-a';
    settingsState.models = [
      { id: 'model-a', name: 'Model A' },
      { id: 'model-b', name: 'Model B' },
    ];
    useConversationStore.setState({
      conversations: [],
      selectedConversationId: null,
      folders: [{ id: 'f1', name: 'Work', type: 'chat' }],
      searchTerm: '',
      isLoaded: true,
    });
    // Discovery has settled by default — the realistic post-load state.
    // The "discovered-only" guard test below overrides this.
    useSettingsStore.setState({ modelListSource: 'discovery' });
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

  // docs/LIMITS_USER_FACING_UX.md §7.4: a model the server hid or that the
  // user has used up must not follow the user from chat to chat.
  describe('model carry-over guard', () => {
    const busyWith = (model: Record<string, unknown>) => {
      useConversationStore.setState({
        conversations: [
          {
            ...emptyConv('busy'),
            model,
            messages: [{ role: 'user', content: 'hi' }],
          },
        ],
        selectedConversationId: 'busy',
      });
    };
    const createdModelId = () => {
      const { result } = renderHook(() => useNewConversation());
      act(() => result.current());
      return useConversationStore.getState().conversations[0].model.id;
    };

    it('falls back to the default model when the current one is no longer served', () => {
      busyWith({ id: 'model-gone', name: 'Gone' });
      expect(createdModelId()).toBe('model-a');
    });

    it('falls back to the default model when the current one is exhausted', () => {
      availabilityById.set('model-b', {
        state: 'exhausted',
        reason: 'exhausted',
      });
      busyWith({ id: 'model-b', name: 'Model B' });
      expect(createdModelId()).toBe('model-a');
    });

    it('falls back to the default model when the current one is blocked', () => {
      availabilityById.set('model-b', { state: 'blocked', reason: 'blocked' });
      busyWith({ id: 'model-b', name: 'Model B' });
      expect(createdModelId()).toBe('model-a');
    });

    it('falls back to the first served model when the default is absent too', () => {
      settingsState.defaultModelId = 'model-retired';
      busyWith({ id: 'model-gone', name: 'Gone' });
      expect(createdModelId()).toBe('model-a');
    });

    // docs/LIMITS_USER_FACING_UX.md §7.4 follow-up: an absence from `models`
    // is only decisive once it MEANS something — mirrors
    // ModelUnavailableNotice's isServedListRefined guard.
    it('carries over a discovered-only model during the static-seed window (modelListSource not yet refined)', () => {
      useSettingsStore.setState({ modelListSource: 'static' });
      // Not a key of OpenAIModels and not in `models` — indistinguishable
      // from "hidden" without the modelListSource guard.
      busyWith({ id: 'discovered-elsewhere', name: 'Discovered' });
      expect(createdModelId()).toBe('discovered-elsewhere');
    });

    it('falls back during a discovery outage too — "fallback" is a settled source, not a static-seed window', () => {
      useSettingsStore.setState({ modelListSource: 'fallback' });
      busyWith({ id: 'discovered-elsewhere', name: 'Discovered' });
      expect(createdModelId()).toBe('model-a');
    });

    it('still falls back once discovery has answered and the id is genuinely absent', () => {
      useSettingsStore.setState({ modelListSource: 'discovery' });
      busyWith({ id: 'discovered-elsewhere', name: 'Discovered' });
      expect(createdModelId()).toBe('model-a');
    });

    it('still carries over agents, byom and local models (never in the served list)', () => {
      busyWith({ id: 'custom-agent-1', name: 'My Agent', isCustomAgent: true });
      expect(createdModelId()).toBe('custom-agent-1');

      busyWith({
        id: 'byom-acct-gpt',
        name: 'Own GPT',
        isCustomSourceModel: true,
      });
      expect(createdModelId()).toBe('byom-acct-gpt');

      busyWith({
        id: 'local-ollama-llama3',
        name: 'llama3',
        isLocalModel: true,
      });
      expect(createdModelId()).toBe('local-ollama-llama3');
    });
  });
});
