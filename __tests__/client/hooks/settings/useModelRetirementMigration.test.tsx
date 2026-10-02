import { renderHook } from '@testing-library/react';

import { useModelRetirementMigration } from '@/client/hooks/settings/useModelRetirementMigration';

import { Conversation } from '@/types/chat';
import { OpenAIModel, OpenAIModelID, OpenAIModels } from '@/types/openai';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it } from 'vitest';

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days: number) =>
  new Date(Date.now() + days * DAY).toISOString();

const served = (id: string, facts: Partial<OpenAIModel> = {}): OpenAIModel => ({
  ...OpenAIModels[id as OpenAIModelID],
  ...facts,
});
const models = [
  served('gpt-5.2-chat'),
  served('gpt-5.2'),
  served('gpt-chat-latest'),
  served('gpt-5.4'),
  served('claude-sonnet-5'),
];

function conversation(
  id: string,
  modelId: string,
  messages: unknown[] = [],
): Conversation {
  return {
    id,
    name: '',
    messages: messages as Conversation['messages'],
    model: served(modelId),
    prompt: '',
    temperature: 0.7,
    folderId: null,
    updatedAt: '2026-09-01T10:00:00.000Z',
  };
}

const modelIds = () =>
  useConversationStore.getState().conversations.map((c) => c.model.id);
const applied = () => useSettingsStore.getState().modelRetirementsApplied;

describe('useModelRetirementMigration', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      userRegion: 'EU',
      modelRetirementsApplied: {},
      defaultModelId: OpenAIModelID.GPT_5_2_CHAT,
      models,
      modelListSource: 'discovery',
    });
    useConversationStore.setState({
      conversations: [conversation('c1', 'gpt-5.2-chat')],
      selectedConversationId: 'c1',
      isLoaded: true,
    });
  });

  it('moves a saved default off a forced model and records every applied event', () => {
    renderHook(() => useModelRetirementMigration());
    expect(useSettingsStore.getState().defaultModelId).toBe('gpt-5.4');
    expect(applied()).toEqual({
      'gpt-5.2': 'forced',
      'gpt-5.2-chat': 'forced',
      'gpt-chat-latest': 'forced',
    });
  });

  it('moves every conversation on a leaving model, with or without messages, selected or not', () => {
    useConversationStore.setState({
      conversations: [
        conversation('c1', 'gpt-5.2-chat'),
        conversation('c2', 'gpt-5.2', [{ role: 'user', content: 'x' }]),
        conversation('c3', 'gpt-chat-latest', [{ role: 'user', content: 'y' }]),
        conversation('c4', 'claude-sonnet-5'),
      ],
      selectedConversationId: 'c1',
    });
    renderHook(() => useModelRetirementMigration());
    expect(modelIds()).toEqual([
      'gpt-5.4',
      'gpt-5.4',
      'gpt-5.4',
      'claude-sonnet-5',
    ]);
  });

  it('applies to US users too', () => {
    useSettingsStore.setState({
      userRegion: 'US',
      defaultModelId: OpenAIModelID.GPT_5_2,
    });
    renderHook(() => useModelRetirementMigration());
    expect(useSettingsStore.getState().defaultModelId).toBe('gpt-5.4');
    expect(modelIds()).toEqual(['gpt-5.4']);
  });

  it('never repeats: a user who switches back afterwards is left alone', () => {
    renderHook(() => useModelRetirementMigration());
    useSettingsStore.getState().setDefaultModelId(OpenAIModelID.GPT_5_2_CHAT);
    useConversationStore
      .getState()
      .updateConversation('c1', { model: served('gpt-5.2-chat') });
    renderHook(() => useModelRetirementMigration());
    expect(useSettingsStore.getState().defaultModelId).toBe('gpt-5.2-chat');
    expect(modelIds()).toEqual(['gpt-5.2-chat']);
  });

  it('keeps a default that is staying but still moves conversations', () => {
    useSettingsStore.setState({
      defaultModelId: OpenAIModelID.CLAUDE_SONNET_5,
    });
    renderHook(() => useModelRetirementMigration());
    expect(useSettingsStore.getState().defaultModelId).toBe('claude-sonnet-5');
    expect(modelIds()).toEqual(['gpt-5.4']);
  });

  it('moves a model 7 days before Azure retires it, and only warns before that', () => {
    const forcedDone = {
      'gpt-5.2': 'forced',
      'gpt-5.2-chat': 'forced',
      'gpt-chat-latest': 'forced',
    };
    const withSonnetRetiring = (retiresAt: string) => [
      served('gpt-5.4'),
      served('claude-sonnet-4-6'),
      served('claude-sonnet-5', { retiresAt }),
    ];
    useConversationStore.setState({
      conversations: [conversation('c1', 'claude-sonnet-5')],
    });

    const noticeOnly = inDays(20);
    useSettingsStore.setState({
      modelRetirementsApplied: forcedDone,
      models: withSonnetRetiring(noticeOnly),
    });
    renderHook(() => useModelRetirementMigration());
    expect(modelIds()).toEqual(['claude-sonnet-5']);
    expect(applied()).toEqual(forcedDone);

    const due = inDays(5);
    useSettingsStore.setState({ models: withSonnetRetiring(due) });
    renderHook(() => useModelRetirementMigration());
    expect(modelIds()).toEqual(['claude-sonnet-4-6']);
    expect(applied()['claude-sonnet-5']).toBe(due);
  });

  it('waits, recording nothing, until conversations are loaded and the served list has arrived', () => {
    useConversationStore.setState({ isLoaded: false });
    renderHook(() => useModelRetirementMigration());
    expect(applied()).toEqual({});
    expect(useSettingsStore.getState().defaultModelId).toBe('gpt-5.2-chat');

    useConversationStore.setState({ isLoaded: true });
    useSettingsStore.setState({ modelListSource: 'static' });
    renderHook(() => useModelRetirementMigration());
    expect(applied()).toEqual({});
    expect(modelIds()).toEqual(['gpt-5.2-chat']);

    useSettingsStore.setState({
      modelListSource: 'discovery',
      userRegion: null,
    });
    renderHook(() => useModelRetirementMigration());
    expect(applied()).toEqual({});
  });

  it('waits, recording nothing, while there is nowhere to move to', () => {
    useSettingsStore.setState({ models: [served('gpt-5.2-chat')] });
    renderHook(() => useModelRetirementMigration());
    expect(applied()).toEqual({});
    expect(modelIds()).toEqual(['gpt-5.2-chat']);
  });
});
