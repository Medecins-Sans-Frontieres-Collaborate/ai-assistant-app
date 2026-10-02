import { fireEvent, render, screen } from '@testing-library/react';

import { Conversation } from '@/types/chat';
import { OpenAIModel, OpenAIModelID, OpenAIModels } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';

import { ModelRetirementNotice } from '@/components/Chat/ModelRetirementNotice';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
}));

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-02T12:00:00Z');

const served = (id: string, facts: Partial<OpenAIModel> = {}): OpenAIModel => ({
  ...OpenAIModels[id as OpenAIModelID],
  ...facts,
});

function conversation(modelId: string): Conversation {
  return {
    id: 'c1',
    name: '',
    messages: [],
    model: served(modelId),
    prompt: '',
    temperature: 0.7,
    folderId: null,
    defaultSearchMode: SearchMode.INTELLIGENT,
  };
}

describe('ModelRetirementNotice', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    useSettingsStore.setState({
      userRegion: 'US',
      defaultModelId: OpenAIModelID.CLAUDE_SONNET_4_6,
      modelListSource: 'discovery',
      models: [
        served('gpt-5.4'),
        served('claude-sonnet-5'),
        // Retires in 20 days: inside the notice window, before the move.
        served('claude-sonnet-4-6', { retiresAt: '2026-10-22T00:00:00Z' }),
      ],
    });
    useConversationStore.setState({
      conversations: [conversation('claude-sonnet-4-6')],
      selectedConversationId: 'c1',
      isLoaded: true,
    });
    return () => vi.useRealTimers();
  });

  it('says when the model retires, when the conversation moves, and where to', () => {
    render(
      <ModelRetirementNotice
        conversation={conversation('claude-sonnet-4-6')}
      />,
    );
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('"retiresOn":"October 22, 2026"');
    expect(status).toHaveTextContent('"movesOn":"October 15, 2026"');
    expect(status).toHaveTextContent(
      `"successor":"${OpenAIModels[OpenAIModelID.CLAUDE_SONNET_5].name}"`,
    );
  });

  it('switches the conversation — and a saved default on that model — on request', () => {
    render(
      <ModelRetirementNotice
        conversation={conversation('claude-sonnet-4-6')}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'switchNow' }));
    expect(useConversationStore.getState().conversations[0].model.id).toBe(
      'claude-sonnet-5',
    );
    expect(useSettingsStore.getState().defaultModelId).toBe('claude-sonnet-5');
  });

  it('keeps warning inside the move window, without promising a move that has already been made', () => {
    useSettingsStore.setState({
      models: [
        served('claude-sonnet-5'),
        served('claude-sonnet-4-6', {
          retiresAt: new Date(NOW + 3 * DAY).toISOString(),
        }),
      ],
    });
    render(
      <ModelRetirementNotice
        conversation={conversation('claude-sonnet-4-6')}
      />,
    );
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('noticeRetiring');
    expect(status).toHaveTextContent('"retiresOn":"October 5, 2026"');
    expect(status).not.toHaveTextContent('movesOn');
    expect(screen.getByRole('button', { name: 'switchNow' })).toBeEnabled();
  });

  it('renders nothing for a model that is staying, or before the list arrives', () => {
    const { container, rerender } = render(
      <ModelRetirementNotice conversation={conversation('gpt-5.4')} />,
    );
    expect(container).toBeEmptyDOMElement();

    useSettingsStore.setState({ modelListSource: 'static' });
    rerender(
      <ModelRetirementNotice
        conversation={conversation('claude-sonnet-4-6')}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
