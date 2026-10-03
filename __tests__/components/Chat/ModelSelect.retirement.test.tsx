import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

import { FORCED_MODEL_RETIREMENTS } from '@/lib/utils/shared/modelRetirement';

import { Conversation } from '@/types/chat';
import { OpenAIModel, OpenAIModelID, OpenAIModels } from '@/types/openai';

import { ModelSelect } from '@/components/Chat/ModelSelect';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Retiring models in the picker (docs/MODEL_DISCOVERY_DESIGN.md §3.6): they
 * are marked before anyone selects them, and a family row never fronts one
 * by default.
 *
 * Copy assertions anchor on the echoed message KEYS (the global next-intl
 * mock returns the key when its fixture lacks it).
 */

const catalog = Object.values(OpenAIModels).filter((m) => !m.isDisabled);

const mockUseConversations = {
  selectedConversation: null as Conversation | null,
  updateConversation: vi.fn(),
  conversations: [] as Conversation[],
};
const mockUseSettings = {
  models: catalog as OpenAIModel[],
  defaultModelId: OpenAIModelID.GPT_5_4,
  setDefaultModelId: vi.fn(),
};

vi.mock('launchdarkly-react-client-sdk', () => ({ useFlags: () => ({}) }));
vi.mock('@/client/hooks/conversation/useConversations', () => ({
  useConversations: () => mockUseConversations,
}));
vi.mock('@/client/hooks/settings/useSettings', () => ({
  useSettings: () => mockUseSettings,
}));
vi.mock('@/client/hooks/settings/useFoundryAgents', () => ({
  useFoundryAgents: () => ({
    foundryAgents: [],
    suppressedOrgAgentIds: [],
    regionalPath: null,
    officePaths: [],
    isLoadingFoundryAgents: false,
    foundryAgentsError: null,
    refetchFoundryAgents: vi.fn(),
    retryFoundryAgents: vi.fn(),
  }),
}));

// No usage limits in play (and no React Query): everything is available.
vi.mock('@/client/hooks/settings/useMyLimits', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/client/hooks/settings/useMyLimits')
    >();
  return {
    ...actual,
    useLimitsEnabled: () => false,
    useMyLimits: () => ({
      limits: [],
      mode: 'observe' as const,
      enforce: false,
      isLimited: false,
      models: {},
      usageUnavailable: false,
      policyUnavailable: false,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }),
  };
});

const conversationOn = (id: OpenAIModelID): Conversation => ({
  id: 'conv-1',
  name: 'Test',
  messages: [],
  model: OpenAIModels[id],
  prompt: '',
  temperature: 0.7,
  folderId: null,
});

/** The list row (ModelCard) whose visible name is `label`. */
const rowNamed = (label: string) =>
  screen.getByText(label).closest('button') as HTMLButtonElement;

function open(modelId: OpenAIModelID, models: OpenAIModel[] = catalog) {
  const conversation = conversationOn(modelId);
  mockUseConversations.selectedConversation = conversation;
  mockUseSettings.models = models;
  useSettingsStore.setState({ models });
  useConversationStore.setState({
    conversations: [conversation],
    selectedConversationId: conversation.id,
  });
  return render(<ModelSelect />);
}

describe('ModelSelect — retiring models', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({
      customAgentSources: [],
      customModelSources: [],
      starredModelIds: [],
      hiddenModelIds: [],
      modelUsageStats: {},
      userRegion: 'US',
      modelListSource: 'discovery',
    });
  });

  it('never lets a family row front a retiring model: one click must not put a conversation on it', () => {
    open(OpenAIModelID.CLAUDE_SONNET_5);
    const row = rowNamed('GPT');
    // The fronted model is staying, so the row carries no retirement mark.
    expect(within(row).queryByTitle('replaced')).toBeNull();

    fireEvent.click(row);
    const [, updates] = mockUseConversations.updateConversation.mock.calls[0];
    expect(Object.keys(FORCED_MODEL_RETIREMENTS)).not.toContain(
      updates.model.id,
    );
  });

  it('marks the row and the details header when the conversation is on a retiring model', () => {
    open(OpenAIModelID.GPT_5_2);
    // Selection wins the row, so the mark is on the visible row.
    expect(within(rowNamed('GPT')).getByTitle('replaced')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('replaced');
  });

  it('marks a retiring version chip with the date, and leaves it selectable', () => {
    const retiresAt = new Date(Date.now() + 20 * 24 * 3600_000).toISOString();
    open(
      OpenAIModelID.CLAUDE_SONNET_5,
      catalog.map((m) =>
        m.id === OpenAIModelID.CLAUDE_SONNET_4_6 ? { ...m, retiresAt } : m,
      ),
    );
    const chip = screen
      .getAllByRole('button')
      .find((b) => b.getAttribute('title')?.includes('datedMoving'));
    expect(chip).toBeDefined();
    expect(chip).not.toHaveAttribute('aria-disabled');
    fireEvent.click(chip!);
    expect(
      mockUseConversations.updateConversation.mock.calls[0][1].model.id,
    ).toBe('claude-sonnet-4-6');
  });

  it('marks nothing before /api/models has answered', () => {
    useSettingsStore.setState({ modelListSource: 'static' });
    open(OpenAIModelID.GPT_5_2);
    expect(screen.queryByTitle('replaced')).toBeNull();
    expect(screen.queryByRole('note')).toBeNull();
  });
});
