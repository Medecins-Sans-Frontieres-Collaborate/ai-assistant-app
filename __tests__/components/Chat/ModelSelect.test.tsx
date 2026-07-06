import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import React from 'react';

import { Conversation } from '@/types/chat';
import { OpenAIModelID, OpenAIModels } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';

import { ModelSelect } from '@/components/Chat/ModelSelect';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the hooks
const mockUseConversations = {
  selectedConversation: null as Conversation | null,
  updateConversation: vi.fn(),
  conversations: [],
};

const mockUseSettings = {
  models: Object.values(OpenAIModels).filter((m) => !m.isDisabled),
  defaultModelId: OpenAIModelID.GPT_5_2,
  setDefaultModelId: vi.fn(),
};

const mockUseCustomAgents = {
  customAgents: [] as Array<{
    id: string;
    name: string;
    agentId: string;
    baseModelId: string;
    description?: string;
    createdAt: string;
  }>,
  addCustomAgent: vi.fn(),
  updateCustomAgent: vi.fn(),
  deleteCustomAgent: vi.fn(),
};

// Mutable LaunchDarkly flags — empty by default (so `exploreBots` is undefined
// and treated as enabled). Individual tests can flip `exploreBots` to false.
const mockFlags: Record<string, unknown> = {};

// Mutable Foundry discovery result so tests can inject discovered agents.
const mockFoundryAgents = {
  foundryAgents: [] as Array<Record<string, unknown>>,
  regionalPath: null as string | null,
  officePaths: [] as string[],
  isLoadingFoundryAgents: false,
  foundryAgentsError: null,
  refetchFoundryAgents: vi.fn(),
};

vi.mock('launchdarkly-react-client-sdk', () => ({
  useFlags: () => mockFlags,
}));

vi.mock('@/client/hooks/conversation/useConversations', () => ({
  useConversations: () => mockUseConversations,
}));

vi.mock('@/client/hooks/settings/useSettings', () => ({
  useSettings: () => mockUseSettings,
}));

vi.mock('@/client/hooks/settings/useCustomAgents', () => ({
  useCustomAgents: () => mockUseCustomAgents,
}));

vi.mock('@/client/hooks/settings/useFoundryAgents', () => ({
  useFoundryAgents: () => mockFoundryAgents,
}));

// Note: next-intl is mocked globally in vitest.setup.dom.ts

describe('ModelSelect', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset mutable mocks back to defaults (flag on, no discovered agents).
    for (const key of Object.keys(mockFlags)) delete mockFlags[key];
    mockFoundryAgents.foundryAgents = [];
    mockFoundryAgents.regionalPath = null;
    mockFoundryAgents.officePaths = [];
    useSettingsStore.setState({
      customAgentSources: [],
      starredModelIds: [],
      modelUsageStats: {},
      userRegion: null,
    });

    // Reset mock data
    mockUseConversations.selectedConversation = {
      id: 'conv-1',
      name: 'Test Conversation',
      messages: [],
      model: OpenAIModels[OpenAIModelID.GPT_5_2],
      prompt: '',
      temperature: 0.7,
      folderId: null,
    };
  });

  describe('Model Display', () => {
    it('renders the full hierarchy at a glance (no collapsed catalog)', () => {
      render(<ModelSelect />);

      // Check that model buttons exist (using getAllByRole since there might be multiple GPT-5 variants)
      const gpt5Buttons = screen
        .getAllByRole('button')
        .filter((btn) => btn.textContent?.includes('GPT-5'));
      expect(gpt5Buttons.length).toBeGreaterThan(0);

      // Series rows visible without any clicks (^ anchors exclude the
      // "Star …" toggles, whose accessible names contain the model name)
      expect(
        screen.getByRole('button', { name: /^DeepSeek V3/i }),
      ).toBeInTheDocument();

      // Check for Llama (plain single row)
      expect(
        screen.getByRole('button', { name: /^Llama 4 Maverick/i }),
      ).toBeInTheDocument();
    });

    it('displays search mode toggle for all models', () => {
      render(<ModelSelect />);

      // All models should have Search Mode toggle
      expect(screen.getByText('Search Mode')).toBeInTheDocument();
    });

    it('displays provider icons for each model', () => {
      const { container } = render(<ModelSelect />);

      // Provider icons should be rendered (SVG elements)
      const svgs = container.querySelectorAll('svg');
      expect(svgs.length).toBeGreaterThan(0);
    });

    it('highlights currently selected model', () => {
      mockUseConversations.selectedConversation = {
        id: 'conv-1',
        name: 'Test',
        messages: [],
        model: OpenAIModels[OpenAIModelID.DEEPSEEK_V3_1],
        prompt: '',
        temperature: 0.7,
        folderId: null,
      };

      const { container } = render(<ModelSelect />);

      // Should have blue background for selected model
      const selectedElements = container.querySelectorAll(
        '.bg-blue-50, .dark\\:bg-blue-900\\/20',
      );
      expect(selectedElements.length).toBeGreaterThan(0);
    });
  });

  describe('Model Selection', () => {
    it('calls updateConversation when model is selected', async () => {
      render(<ModelSelect />);

      const deepseekButton = screen.getByText('DeepSeek V3').closest('button');
      expect(deepseekButton).not.toBeNull();

      fireEvent.click(deepseekButton!);

      await waitFor(() => {
        expect(mockUseConversations.updateConversation).toHaveBeenCalled();
      });
    });

    it('sets default model when a version is picked in the details panel', async () => {
      render(<ModelSelect />);

      // Selected model is GPT-5.2; the details panel's Version section lists
      // the whole GPT series. Chips carry the full model name as tooltip.
      fireEvent.click(screen.getByTitle('GPT-5'));

      await waitFor(() => {
        expect(mockUseSettings.setDefaultModelId).toHaveBeenCalledWith(
          OpenAIModelID.GPT_5,
        );
      });
    });

    it('sets model with agent capabilities', async () => {
      render(<ModelSelect />);

      // GPT-4.1 is an older GPT version: pick it from the details panel's
      // Version section (exact title, so GPT-4.1 Mini doesn't match).
      fireEvent.click(screen.getByTitle('GPT-4.1'));

      await waitFor(() => {
        expect(mockUseConversations.updateConversation).toHaveBeenCalledWith(
          'conv-1',
          expect.objectContaining({
            model: expect.objectContaining({
              id: OpenAIModelID.GPT_4_1,
              isAgent: true,
            }),
          }),
        );
      });
    });
  });

  describe('Search Mode Toggle', () => {
    it('displays Search Mode toggle for models with agent capabilities', () => {
      mockUseConversations.selectedConversation = {
        id: 'conv-1',
        name: 'Test',
        messages: [],
        model: {
          ...OpenAIModels[OpenAIModelID.GPT_4_1],
        },
        prompt: '',
        temperature: 0.7,
        folderId: null,
        defaultSearchMode: SearchMode.INTELLIGENT, // INTELLIGENT mode
      };

      render(<ModelSelect />);

      // Should show Search Mode by default
      expect(screen.getByText('Search Mode')).toBeInTheDocument();
      // Azure AI Agent Mode toggle should be nested inside Search Mode
      expect(screen.getByText(/Azure AI Agent Mode/)).toBeInTheDocument();
    });

    it('displays Search Mode toggle for all models', () => {
      mockUseConversations.selectedConversation = {
        id: 'conv-1',
        name: 'Test',
        messages: [],
        model: OpenAIModels[OpenAIModelID.DEEPSEEK_V3_1],
        prompt: '',
        temperature: 0.7,
        folderId: null,
      };

      render(<ModelSelect />);

      // All models should have Search Mode toggle
      expect(screen.getByText('Search Mode')).toBeInTheDocument();
    });

    it('displays search mode descriptions correctly', () => {
      mockUseConversations.selectedConversation = {
        id: 'conv-1',
        name: 'Test',
        messages: [],
        model: OpenAIModels[OpenAIModelID.LLAMA_4_MAVERICK],
        prompt: '',
        temperature: 0.7,
        folderId: null,
      };

      render(<ModelSelect />);

      // Should show Search Mode with description
      expect(screen.getByText('Search Mode')).toBeInTheDocument();
      expect(
        screen.getByText(/Will use web search when needed/),
      ).toBeInTheDocument();
    });
  });

  describe('Temperature Control', () => {
    it('displays temperature slider for models that support temperature', () => {
      mockUseConversations.selectedConversation = {
        id: 'conv-1',
        name: 'Test',
        messages: [],
        model: OpenAIModels[OpenAIModelID.DEEPSEEK_V3_1],
        prompt: '',
        temperature: 0.7,
        folderId: null,
      };

      render(<ModelSelect />);

      // Expand advanced options
      const advancedButton = screen.getByText('Advanced Options');
      fireEvent.click(advancedButton);

      expect(screen.getByText('Temperature')).toBeInTheDocument();
    });

    it('does not display temperature slider for models that do not support temperature', () => {
      mockUseConversations.selectedConversation = {
        id: 'conv-1',
        name: 'Test',
        messages: [],
        model: OpenAIModels[OpenAIModelID.GPT_5_2],
        prompt: '',
        temperature: 0.7,
        folderId: null,
      };

      render(<ModelSelect />);

      // Expand advanced options
      const advancedButton = screen.getByText('Advanced Options');
      fireEvent.click(advancedButton);

      expect(screen.queryByText('Temperature')).not.toBeInTheDocument();
    });

    it('displays notice for models that do not support temperature', () => {
      mockUseConversations.selectedConversation = {
        id: 'conv-1',
        name: 'Test',
        messages: [],
        model: OpenAIModels[OpenAIModelID.GPT_5_2],
        prompt: '',
        temperature: 0.7,
        folderId: null,
      };

      render(<ModelSelect />);

      // Expand advanced options
      const advancedButton = screen.getByText('Advanced Options');
      fireEvent.click(advancedButton);

      expect(
        screen.getByText(/fixed temperature values for consistent performance/),
      ).toBeInTheDocument();
    });

    it('hides temperature slider when using agent model', () => {
      mockUseConversations.selectedConversation = {
        id: 'conv-1',
        name: 'Test',
        messages: [],
        model: {
          ...OpenAIModels[OpenAIModelID.GPT_5_2],
          isAgent: true,
        },
        prompt: '',
        temperature: 0.7,
        folderId: null,
      };

      render(<ModelSelect />);

      // Temperature control should not be visible when using agent model
      expect(screen.queryByText('Temperature Control')).not.toBeInTheDocument();
    });
  });

  describe('Model Details Panel', () => {
    it('displays the model name and tagline (no jargon type badge)', () => {
      mockUseConversations.selectedConversation = {
        id: 'conv-1',
        name: 'Test',
        messages: [],
        model: OpenAIModels[OpenAIModelID.GPT_5_2],
        prompt: '',
        temperature: 0.7,
        folderId: null,
      };

      render(<ModelSelect />);

      // The "omni" type badge was intentionally removed — it was jargon.
      expect(screen.queryByText('omni')).not.toBeInTheDocument();
      // Name + tagline carry the meaning now.
      expect(screen.getAllByText('GPT-5.2').length).toBeGreaterThan(0);
    });

    it('displays knowledge cutoff date', () => {
      mockUseConversations.selectedConversation = {
        id: 'conv-1',
        name: 'Test',
        messages: [],
        model: OpenAIModels[OpenAIModelID.GPT_5_2],
        prompt: '',
        temperature: 0.7,
        folderId: null,
      };

      render(<ModelSelect />);

      // Knowledge cutoff is displayed as a formatted date
      // GPT-5.2 has knowledgeCutoffDate: '2025-12' which formats to a date string
      // The date should be displayed near the model type badge
      const modelDetailElements = document.querySelectorAll(
        '.text-xs.text-gray-600',
      );
      // Should have at least one date/info element in the model details
      expect(modelDetailElements.length).toBeGreaterThan(0);
    });

    it('displays model description', () => {
      mockUseConversations.selectedConversation = {
        id: 'conv-1',
        name: 'Test',
        messages: [],
        model: OpenAIModels[OpenAIModelID.GPT_5_2],
        prompt: '',
        temperature: 0.7,
        folderId: null,
      };

      render(<ModelSelect />);

      expect(screen.getByText(/capable everyday model/)).toBeInTheDocument();
    });
  });

  describe('Advanced Section', () => {
    it('collapses advanced section by default', () => {
      render(<ModelSelect />);

      // Advanced section should be collapsed
      expect(screen.queryByText('Add Custom Agent')).not.toBeInTheDocument();
    });

    it('expands advanced section when clicked', async () => {
      // Select a conversation with a model that supports advanced options
      mockUseConversations.selectedConversation = {
        id: 'conv-1',
        name: 'Test',
        messages: [],
        model: OpenAIModels[OpenAIModelID.GPT_5_2],
        prompt: '',
        temperature: 0.7,
        folderId: null,
      };

      render(<ModelSelect />);

      const advancedButton = screen
        .getByText('Advanced Options')
        .closest('button');
      expect(advancedButton).not.toBeNull();

      fireEvent.click(advancedButton!);

      // Check if advanced content is shown (GPT-5 shows temp notice, not slider)
      await waitFor(() => {
        expect(
          screen.getByText(/This model uses fixed temperature values/),
        ).toBeInTheDocument();
      });
    });

    it('displays custom agents in agents tab when present', () => {
      mockUseCustomAgents.customAgents = [
        {
          id: 'agent-1',
          name: 'My Custom Agent',
          agentId: 'asst_custom123',
          baseModelId: OpenAIModelID.GPT_5_2,
          description: 'Custom agent for testing',
          createdAt: new Date().toISOString(),
        },
      ];

      render(<ModelSelect />);

      // Click on Agents tab
      const agentsTab = screen.getByText('Agents').closest('button');
      fireEvent.click(agentsTab!);

      // Custom agent should be visible in the agents tab
      waitFor(() => {
        expect(screen.getByText('My Custom Agent')).toBeInTheDocument();
      });
    });
  });

  describe('Model Organization', () => {
    it('groups models by provider', () => {
      const { container } = render(<ModelSelect />);

      // Should have Models section
      expect(screen.getByText('Models')).toBeInTheDocument();
    });

    it('orders provider family groups canonically (OpenAI → DeepSeek → Meta)', () => {
      const { container } = render(<ModelSelect />);

      const headers = Array.from(container.querySelectorAll('h5')).map(
        (h) => h.textContent || '',
      );
      const openAIIndex = headers.findIndex((h) => h.startsWith('OpenAI'));
      const deepseekIndex = headers.findIndex((h) => h.startsWith('DeepSeek'));
      const metaIndex = headers.findIndex((h) => h.startsWith('Meta'));

      expect(openAIIndex).toBeGreaterThanOrEqual(0);
      expect(openAIIndex).toBeLessThan(deepseekIndex);
      expect(deepseekIndex).toBeLessThan(metaIndex);
    });

    it('splits a family into Reasoning and General type groups', () => {
      render(<ModelSelect />);

      // OpenAI has o3 (reasoning) and the GPT lineups (general).
      expect(screen.getAllByText('Reasoning').length).toBeGreaterThan(0);
      expect(screen.getAllByText('General').length).toBeGreaterThan(0);
    });
  });

  describe('Favorites, hierarchy, and region', () => {
    it('has NO Favorites section until the user stars something; Recommended is an inline pill', () => {
      render(<ModelSelect />);

      expect(screen.queryByText('Favorites')).not.toBeInTheDocument();
      // Featured models carry the Recommended pill inline in the tree.
      expect(screen.getAllByText('Recommended').length).toBeGreaterThanOrEqual(
        1,
      );
      // The family tree is fully visible — nothing is collapsed away.
      expect(screen.getByText(/OpenAI \(\d+\)/)).toBeInTheDocument();
      expect(screen.getByText(/Anthropic \(\d+\)/)).toBeInTheDocument();
    });

    it('shows the Favorites section once the user stars a model', () => {
      useSettingsStore.setState({ starredModelIds: ['DeepSeek-R1'] });

      render(<ModelSelect />);

      const section = screen.getByText('Favorites').parentElement!;
      const names = Array.from(section.querySelectorAll('.font-medium')).map(
        (el) => el.textContent,
      );
      expect(names[0]).toBe('DeepSeek-R1');
    });

    it('consolidates a series into ONE row with an inline version tag', () => {
      render(<ModelSelect />);

      // The GPT series fronts its recommended version as a tag…
      expect(screen.getByText('GPT')).toBeInTheDocument();
      // …and no other GPT version appears as its own row in the list.
      expect(screen.queryByText('GPT-5.4')).not.toBeInTheDocument();
      expect(screen.queryByText('GPT-5')).not.toBeInTheDocument();
    });

    it('lists all series versions in the details panel Version section', () => {
      render(<ModelSelect />);

      // Selected model is GPT-5.2 → Version section covers the GPT series,
      // legacy versions included.
      expect(screen.getByText('Version')).toBeInTheDocument();
      expect(screen.getByTitle('GPT-5.4')).toBeInTheDocument();
      expect(screen.getByTitle('GPT-4o')).toBeInTheDocument();
    });

    it('star toggle on a tree card stars the model in the store', () => {
      render(<ModelSelect />);

      fireEvent.click(screen.getByRole('button', { name: 'Star DeepSeek-R1' }));

      expect(useSettingsStore.getState().starredModelIds).toContain(
        'DeepSeek-R1',
      );
    });

    it('badges EU-hosted models for US users but keeps them SELECTABLE', async () => {
      const savedModels = mockUseSettings.models;
      try {
        mockUseSettings.models = savedModels.map((m) =>
          m.id === 'Mistral-Large-3' ? { ...m, hostedIn: ['EU' as const] } : m,
        );
        useSettingsStore.setState({ userRegion: 'US' });

        render(<ModelSelect />);

        // Informational region badge on the card…
        expect(screen.getByText('EU')).toBeInTheDocument();

        // …but selection works (chat routes to the hosting region).
        fireEvent.click(
          screen.getByRole('button', { name: /^Mistral Large 3/i }),
        );
        await waitFor(() =>
          expect(mockUseConversations.updateConversation).toHaveBeenCalled(),
        );
      } finally {
        mockUseSettings.models = savedModels;
      }
    });

    it('shows the residency note for EU users', () => {
      useSettingsStore.setState({ userRegion: 'EU' });

      render(<ModelSelect />);

      expect(
        screen.getByText('All models run in the EU Azure region.'),
      ).toBeInTheDocument();
    });

    it('search filters across models', () => {
      render(<ModelSelect />);

      fireEvent.change(screen.getByPlaceholderText('Search models'), {
        target: { value: 'Llama' },
      });

      expect(screen.getByText('Llama 4 Maverick')).toBeInTheDocument();
      expect(screen.queryByText(/OpenAI \(\d+\)/)).not.toBeInTheDocument();
    });

    it('shows an empty state for a search with no matches', () => {
      render(<ModelSelect />);

      fireEvent.change(screen.getByPlaceholderText('Search models'), {
        target: { value: 'zzz-nope' },
      });

      expect(
        screen.getByText('No models match your search.'),
      ).toBeInTheDocument();
    });
  });

  describe('Close Button', () => {
    it('calls onClose when close button is clicked', () => {
      const onClose = vi.fn();
      const { container } = render(<ModelSelect onClose={onClose} />);

      // Find the close button (it's in the header next to the tabs)
      // It should have the IconX component
      const closeButton = container.querySelector(
        'button.text-gray-500.hover\\:text-gray-700',
      );

      expect(closeButton).not.toBeNull();
      fireEvent.click(closeButton!);
      expect(onClose).toHaveBeenCalled();
    });

    it('does not render close button when onClose is not provided', () => {
      const { container } = render(<ModelSelect />);

      // Should not have close button
      const xButtons = container.querySelectorAll('[aria-label="Close"]');
      expect(xButtons.length).toBe(0);
    });
  });

  describe('BYO Foundry sources when discovery is disabled', () => {
    it('keeps custom-source agents selectable but hides region agents when exploreBots is false', async () => {
      mockFlags.exploreBots = false;

      useSettingsStore.setState({
        customAgentSources: [
          {
            id: 'src-1',
            name: 'My Foundry Project',
            resourcePath: '/subscriptions/x/custom-project',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      });

      mockFoundryAgents.regionalPath = '/subscriptions/x/region-project';
      mockFoundryAgents.foundryAgents = [
        {
          id: 'byo-1',
          name: 'My BYO Agent',
          agentName: 'asst_byo',
          source: '/subscriptions/x/custom-project',
          description: 'Agent from a user-connected project',
        },
        {
          id: 'region-1',
          name: 'Region Only Agent',
          agentName: 'asst_region',
          source: '/subscriptions/x/region-project',
          description: 'Org-managed regional agent',
        },
      ];

      render(<ModelSelect />);

      // Switch to the Agents tab.
      fireEvent.click(screen.getByText('Agents').closest('button')!);

      // BYO custom-source agent is shown; the org-managed region agent is gated out.
      const byoRow = await screen.findByText('My BYO Agent');
      expect(byoRow).toBeInTheDocument();
      expect(screen.queryByText('Region Only Agent')).not.toBeInTheDocument();

      // Clicking the BYO agent actually selects it. This is the bug fix: before,
      // organizationAgentModels was empty when the flag was off, so the click
      // resolved to no model and did nothing.
      fireEvent.click(byoRow.closest('button')!);
      await waitFor(() => {
        expect(mockUseConversations.updateConversation).toHaveBeenCalledWith(
          'conv-1',
          expect.objectContaining({
            model: expect.objectContaining({
              id: expect.stringContaining('foundry-'),
            }),
          }),
        );
      });
    });

    it('shows the empty state when discovery is off and no custom sources exist', () => {
      mockFlags.exploreBots = false;

      render(<ModelSelect />);
      fireEvent.click(screen.getByText('Agents').closest('button')!);

      expect(
        screen.getByText('No regional / organization agents available'),
      ).toBeInTheDocument();
    });
  });
});
