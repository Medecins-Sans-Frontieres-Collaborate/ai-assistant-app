import { act, renderHook } from '@testing-library/react';

import { useModelRetirementMigration } from '@/client/hooks/settings/useModelRetirementMigration';

import { Conversation } from '@/types/chat';
import { OpenAIModel, OpenAIModelID, OpenAIModels } from '@/types/openai';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
const appliedTriggers = () =>
  Object.fromEntries(
    Object.entries(applied()).map(([id, entry]) => [id, entry.triggers]),
  );
const forcedDone = (appliedAt: string) =>
  Object.fromEntries(
    ['gpt-5.2', 'gpt-5.2-chat', 'gpt-chat-latest'].map((id) => [
      id,
      { triggers: ['forced'], appliedAt },
    ]),
  );

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
    expect(appliedTriggers()).toEqual({
      'gpt-5.2': ['forced'],
      'gpt-5.2-chat': ['forced'],
      'gpt-chat-latest': ['forced'],
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
    const done = forcedDone(inDays(-1));
    const withSonnetRetiring = (retiresAt: string) => [
      served('gpt-5.4'),
      served('claude-sonnet-4-6'),
      served('claude-sonnet-5', { retiresAt }),
    ];
    useConversationStore.setState({
      conversations: [conversation('c1', 'claude-sonnet-5')],
    });

    useSettingsStore.setState({
      modelRetirementsApplied: done,
      models: withSonnetRetiring(inDays(20)),
    });
    renderHook(() => useModelRetirementMigration());
    expect(modelIds()).toEqual(['claude-sonnet-5']);
    expect(applied()).toEqual(done);

    const due = inDays(5);
    useSettingsStore.setState({ models: withSonnetRetiring(due) });
    renderHook(() => useModelRetirementMigration());
    // The only other Sonnet on offer (an older one — nothing newer exists).
    expect(modelIds()).toEqual(['claude-sonnet-4-6']);
    expect(appliedTriggers()['claude-sonnet-5']).toEqual([due]);
  });

  it('moves an alias to the model its deployment runs', () => {
    useSettingsStore.setState({
      modelRetirementsApplied: forcedDone(inDays(-1)),
      models: [
        served('gpt-5.4'),
        served('gpt-5-mini', { deploymentModelName: 'gpt-5.4-mini' }),
        served('gpt-5.4-mini'),
      ],
    });
    useConversationStore.setState({
      conversations: [conversation('c1', 'gpt-5-mini')],
    });
    renderHook(() => useModelRetirementMigration());
    expect(modelIds()).toEqual(['gpt-5.4-mini']);
    expect(appliedTriggers()['gpt-5-mini']).toEqual(['alias:gpt-5.4-mini']);
  });

  it('waits, recording nothing, while gpt-5.4 is not served — it never lands somewhere else', () => {
    useSettingsStore.setState({
      models: [
        served('gpt-5.2-chat'),
        served('gpt-5.2'),
        served('gpt-6-astra'),
        served('claude-sonnet-5'),
      ],
    });
    renderHook(() => useModelRetirementMigration());
    expect(applied()).toEqual({});
    expect(modelIds()).toEqual(['gpt-5.2-chat']);
    expect(useSettingsStore.getState().defaultModelId).toBe('gpt-5.2-chat');

    // gpt-5.4 comes back: the move happens then.
    useSettingsStore.setState({ models });
    renderHook(() => useModelRetirementMigration());
    expect(modelIds()).toEqual(['gpt-5.4']);
  });

  describe('conversations that arrive after the move was applied', () => {
    it('catches up a restored / imported / synced conversation, even when the first pass saw none', () => {
      useConversationStore.setState({ conversations: [] });
      const { rerender } = renderHook(() => useModelRetirementMigration());
      expect(appliedTriggers()['gpt-5.2']).toEqual(['forced']);

      // A backup restore lands: old conversations, still on the old model.
      act(() => {
        useConversationStore.setState({
          conversations: [
            conversation('old-1', 'gpt-5.2', [{ role: 'user', content: 'x' }]),
            conversation('old-2', 'claude-sonnet-5'),
          ],
        });
      });
      rerender();
      expect(modelIds()).toEqual(['gpt-5.4', 'claude-sonnet-5']);
    });

    it('does not catch up a conversation the user put back on the model after the move', () => {
      const { rerender } = renderHook(() => useModelRetirementMigration());
      expect(modelIds()).toEqual(['gpt-5.4']);

      act(() => {
        // updateConversation stamps "now" — after the applied move.
        useConversationStore
          .getState()
          .updateConversation('c1', { model: served('gpt-5.2-chat') });
        useConversationStore.getState().addConversation({
          ...conversation('c2', 'claude-sonnet-5'),
        });
      });
      rerender();
      expect(modelIds()).toEqual(['claude-sonnet-5', 'gpt-5.2-chat']);
    });

    it('never rewrites the applied record on a catch-up', () => {
      renderHook(() => useModelRetirementMigration());
      const before = applied();
      useConversationStore.setState({
        conversations: [conversation('late', 'gpt-5.2')],
      });
      renderHook(() => useModelRetirementMigration());
      expect(modelIds()).toEqual(['gpt-5.4']);
      expect(applied()).toBe(before);
    });
  });

  it('leaves a conversation pinned to the EU instance alone when only the US deployment retires', () => {
    const due = inDays(3);
    useSettingsStore.setState({
      userRegion: 'US',
      modelRetirementsApplied: forcedDone(inDays(-1)),
      models: [
        served('gpt-5.4', { hostedIn: ['US', 'EU'] }),
        served('claude-sonnet-4-6', { hostedIn: ['US', 'EU'] }),
        served('claude-sonnet-5', {
          hostedIn: ['US', 'EU'],
          retiresAt: due,
          retirementByRegion: { US: { retiresAt: due }, EU: {} },
        }),
      ],
    });
    useConversationStore.setState({
      conversations: [
        conversation('home', 'claude-sonnet-5'),
        { ...conversation('pinned', 'claude-sonnet-5'), hostedRegion: 'EU' },
      ],
    });
    renderHook(() => useModelRetirementMigration());
    expect(modelIds()).toEqual(['claude-sonnet-4-6', 'claude-sonnet-5']);
  });

  describe('a tab left open across the move date', () => {
    afterEach(() => vi.useRealTimers());

    it('makes the move when the window regains focus', () => {
      const start = Date.parse('2026-10-02T12:00:00Z');
      vi.useFakeTimers({ now: start, toFake: ['Date'] });
      // Retires in 9 days: notice only, today.
      const retiresAt = new Date(start + 9 * DAY).toISOString();
      useSettingsStore.setState({
        modelRetirementsApplied: forcedDone(
          new Date(start - DAY).toISOString(),
        ),
        models: [
          served('gpt-5.4'),
          served('claude-sonnet-4-6'),
          served('claude-sonnet-5', { retiresAt }),
        ],
      });
      useConversationStore.setState({
        conversations: [conversation('c1', 'claude-sonnet-5')],
      });
      renderHook(() => useModelRetirementMigration());
      expect(modelIds()).toEqual(['claude-sonnet-5']);

      // Three days later, same tab, same (unchanged) model list.
      vi.setSystemTime(start + 3 * DAY);
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      expect(modelIds()).toEqual(['claude-sonnet-4-6']);
    });
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
