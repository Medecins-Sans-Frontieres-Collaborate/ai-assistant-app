import { renderHook } from '@testing-library/react';

import { useEuDefaultModelSwitch } from '@/client/hooks/settings/useEuDefaultModelSwitch';

import { Conversation } from '@/types/chat';
import { OpenAIModel, OpenAIModelID } from '@/types/openai';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const flags = vi.hoisted(() => ({ current: { euDefaultModelSwitch: true } }));
vi.mock('launchdarkly-react-client-sdk', () => ({
  useFlags: () => flags.current,
}));
const toastSuccess = vi.hoisted(() => vi.fn());
vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), { success: toastSuccess, error: vi.fn() }),
}));

const model = (id: string): OpenAIModel =>
  ({ id, name: id, maxLength: 1, tokenLimit: 1 }) as OpenAIModel;
const models = [model('gpt-5.2-chat'), model('gpt-5.4')];

function conversation(modelId: string, messages: unknown[] = []): Conversation {
  return {
    id: 'c1',
    name: '',
    messages: messages as Conversation['messages'],
    model: model(modelId),
    prompt: '',
    temperature: 0.7,
    folderId: null,
  };
}

describe('useEuDefaultModelSwitch', () => {
  beforeEach(() => {
    flags.current = { euDefaultModelSwitch: true };
    toastSuccess.mockClear();
    useSettingsStore.setState({
      userRegion: 'EU',
      euDefaultModelSwitchApplied: false,
      defaultModelId: OpenAIModelID.GPT_5_2_CHAT,
      models,
    });
    useConversationStore.setState({
      conversations: [conversation('gpt-5.2-chat')],
      selectedConversationId: 'c1',
    });
  });

  it('switches the persisted default, the empty selected conversation, and marks once', () => {
    renderHook(() => useEuDefaultModelSwitch());
    const s = useSettingsStore.getState();
    expect(s.defaultModelId).toBe('gpt-5.4');
    expect(s.euDefaultModelSwitchApplied).toBe(true);
    expect(useConversationStore.getState().conversations[0].model.id).toBe(
      'gpt-5.4',
    );
    expect(toastSuccess).toHaveBeenCalledTimes(1);
  });

  it('leaves a conversation with messages on its model', () => {
    useConversationStore.setState({
      conversations: [
        conversation('gpt-5.2-chat', [{ role: 'user', content: 'x' }]),
      ],
      selectedConversationId: 'c1',
    });
    renderHook(() => useEuDefaultModelSwitch());
    expect(useSettingsStore.getState().defaultModelId).toBe('gpt-5.4');
    expect(useConversationStore.getState().conversations[0].model.id).toBe(
      'gpt-5.2-chat',
    );
  });

  it('never repeats: a user who switches back afterwards is left alone', () => {
    renderHook(() => useEuDefaultModelSwitch());
    useSettingsStore.getState().setDefaultModelId(OpenAIModelID.GPT_5_2_CHAT);
    renderHook(() => useEuDefaultModelSwitch());
    expect(useSettingsStore.getState().defaultModelId).toBe('gpt-5.2-chat');
    expect(toastSuccess).toHaveBeenCalledTimes(1);
  });

  it('does nothing for US users or with the flag off, and marks a non-old default without a toast', () => {
    useSettingsStore.setState({ userRegion: 'US' });
    renderHook(() => useEuDefaultModelSwitch());
    expect(useSettingsStore.getState().defaultModelId).toBe('gpt-5.2-chat');
    expect(useSettingsStore.getState().euDefaultModelSwitchApplied).toBe(false);

    useSettingsStore.setState({ userRegion: 'EU' });
    flags.current = { euDefaultModelSwitch: false };
    renderHook(() => useEuDefaultModelSwitch());
    expect(useSettingsStore.getState().euDefaultModelSwitchApplied).toBe(false);

    flags.current = { euDefaultModelSwitch: true };
    useSettingsStore.setState({ defaultModelId: OpenAIModelID.GPT_5_4_NANO });
    renderHook(() => useEuDefaultModelSwitch());
    expect(useSettingsStore.getState().defaultModelId).toBe('gpt-5.4-nano');
    expect(useSettingsStore.getState().euDefaultModelSwitchApplied).toBe(true);
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
