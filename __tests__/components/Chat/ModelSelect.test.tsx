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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
      customModelSources: [],
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

      // One row per family, fronted by the representative with an inline
      // variant/version tag ('standard' variant labels are suppressed).
      expect(screen.getByText('GPT').closest('button')).not.toBeNull();
      expect(screen.getByText('GPT Chat').closest('button')).not.toBeNull();
      expect(screen.getByText('DeepSeek').closest('button')).not.toBeNull();
      // Claude fronts the latest Sonnet (family default); Llama fronts
      // Maverick 4 (non-standard variants keep their label in the tag).
      expect(screen.getByText('Sonnet 5')).toBeInTheDocument();
      expect(screen.getByText('Maverick 4')).toBeInTheDocument();
    });

    it('renders no search-mode controls (they moved to the capabilities tray)', () => {
      render(<ModelSelect />);

      expect(screen.queryByText('Search Mode')).toBeNull();
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

      const deepseekButton = screen.getByText('DeepSeek').closest('button');
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

  describe('Search Mode Controls (moved to capabilities tray)', () => {
    it('renders neither search-mode nor agent-routing controls in the picker', () => {
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
        defaultSearchMode: SearchMode.INTELLIGENT,
      };

      render(<ModelSelect />);

      // Phase 2 consolidation: the picker picks models; search and
      // interpreter defaults live in ToolModeControls (composer tray).
      expect(screen.queryByText('Search Mode')).toBeNull();
      expect(screen.queryByText(/Azure AI Agent Mode/)).toBeNull();
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

    // NOTE: the old "displays custom agents in agents tab" test was removed:
    // the legacy assistant-style custom-agent list (useCustomAgents /
    // CustomAgentList) is no longer rendered by the Agents tab — the tab
    // shows Foundry/organization agents from sources. The test only ever
    // "passed" because its waitFor was never awaited; once awaited it fails
    // deterministically, and the floating promise intermittently rejected
    // AFTER its test ended, failing CI with all tests green (run 28823325872).
  });

  describe('Model Organization', () => {
    it('groups models by provider', () => {
      const { container } = render(<ModelSelect />);

      // Should have Models section
      expect(screen.getByText('Models')).toBeInTheDocument();
    });

    it('interleaves providers per DEFAULT_MODEL_ORDER (Mistral high, o3 demoted) without headers', () => {
      const { container } = render(<ModelSelect />);

      // No per-family headers — provider icons carry that — and the flat
      // list follows DEFAULT_MODEL_ORDER, which deliberately mixes families.
      expect(container.querySelector('h5')).toBeNull();

      const names = Array.from(container.querySelectorAll('.font-medium')).map(
        (el) => el.textContent || '',
      );
      const gptIndex = names.indexOf('GPT');
      const mistralIndex = names.findIndex((n) => n.startsWith('Mistral'));
      const deepseekIndex = names.findIndex((n) => n.startsWith('DeepSeek'));
      const oSeriesIndex = names.indexOf('o-series');

      expect(gptIndex).toBeGreaterThanOrEqual(0);
      // Mistral sits in the top rows, below the GPT flagship…
      expect(gptIndex).toBeLessThan(mistralIndex);
      expect(mistralIndex).toBeLessThan(deepseekIndex);
      // …and the o-series reasoning family is demoted below it despite being
      // OpenAI models.
      expect(mistralIndex).toBeLessThan(oSeriesIndex);
    });

    it('marks dedicated reasoning models with a quiet icon, not a section', () => {
      render(<ModelSelect />);

      // No Reasoning/General sub-headers anymore…
      expect(screen.queryByText('General')).not.toBeInTheDocument();
      // …instead the o-series row (fronted by o3) carries the tooltip'd
      // brain icon. DeepSeek's row fronts the standard variant, so its
      // reasoning members mark themselves via the Variant control instead.
      expect(
        screen.getAllByLabelText(/Reasoning model:/).length,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Favorites, hierarchy, and region', () => {
    it('has NO Favorites section until the user stars something; Recommended tag is hidden', () => {
      render(<ModelSelect />);

      expect(screen.queryByText('Favorites')).not.toBeInTheDocument();
      // The Recommended tag is currently disabled everywhere (list pill and
      // version chips) — see SHOW_RECOMMENDED_TAG.
      expect(screen.queryByText('Recommended')).not.toBeInTheDocument();
      // The model list is fully visible — nothing is collapsed away — and
      // there are no per-family headers; provider icons carry the grouping.
      expect(screen.getByText('DeepSeek')).toBeInTheDocument();
      expect(screen.queryByText(/OpenAI \(\d+\)/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Anthropic \(\d+\)/)).not.toBeInTheDocument();
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

    it('scopes Version chips to the active variant and switches variants via the Variant control', async () => {
      render(<ModelSelect />);

      // Selected model is GPT-5.2 (standard variant) → the Variant control
      // offers the family's size variants, and the Version chips exclude
      // mini/nano members.
      expect(screen.getByText('Variant')).toBeInTheDocument();
      const variantGroup = screen.getByRole('group', { name: 'Variant' });
      expect(within(variantGroup).getByText('Standard')).toBeInTheDocument();
      expect(within(variantGroup).getByText('Mini')).toBeInTheDocument();
      expect(within(variantGroup).getByText('Nano')).toBeInTheDocument();
      const versionGroup = screen.getByRole('group', { name: 'Version' });
      expect(
        within(versionGroup).queryByTitle('GPT-5 Mini'),
      ).not.toBeInTheDocument();
      expect(within(versionGroup).getByTitle('GPT-5.4')).toBeInTheDocument();

      // Switching to Mini: no 5.2 mini exists, so the ragged-matrix fallback
      // selects the variant's representative (GPT-5 Mini).
      fireEvent.click(within(variantGroup).getByText('Mini'));

      await waitFor(() => {
        expect(mockUseSettings.setDefaultModelId).toHaveBeenCalledWith(
          OpenAIModelID.GPT_5_MINI,
        );
      });
    });

    it('does not render a Variant control for single-variant families', () => {
      mockUseConversations.selectedConversation = {
        id: 'conv-1',
        name: 'Test',
        messages: [],
        model: OpenAIModels[OpenAIModelID.GPT_5_2_CHAT],
        prompt: '',
        temperature: 0.7,
        folderId: null,
      };

      render(<ModelSelect />);

      // GPT Chat has versions but no variants.
      expect(screen.getByText('Version')).toBeInTheDocument();
      expect(screen.queryByText('Variant')).not.toBeInTheDocument();
    });

    it('hides no-longer-relevant GPT size rows from the list', () => {
      render(<ModelSelect />);

      // Mini/nano models are variants inside the GPT row now, not rows.
      expect(screen.queryByText('GPT Mini')).not.toBeInTheDocument();
      expect(screen.queryByText('GPT-5.4 Nano')).not.toBeInTheDocument();
    });

    it('star toggle on a tree card stars the model in the store', () => {
      render(<ModelSelect />);

      // The DeepSeek family row fronts its default (defaultRank 1 =
      // V4-Flash); the star acts on that concrete model, not the family.
      fireEvent.click(
        screen.getByRole('button', { name: 'Star DeepSeek-V4-Flash' }),
      );

      expect(useSettingsStore.getState().starredModelIds).toContain(
        'DeepSeek-V4-Flash',
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

        // …but selection works (chat routes to the hosting region). The
        // Mistral family row fronts the featured Large 3.
        fireEvent.click(screen.getByText('Mistral').closest('button')!);
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

  describe('Prompt agents (admin-defined personas)', () => {
    const promptAgent = {
      id: 'prompt-abc123def456',
      name: 'Policy Assistant',
      description: 'Answers policy questions',
      agentName: 'prompt-abc123def456',
      source: 'prompt-agent',
      type: 'prompt',
    };

    it('selecting a prompt agent ATTACHES it (bot only) and leaves the model alone', async () => {
      mockFoundryAgents.foundryAgents = [promptAgent];

      render(<ModelSelect />);
      fireEvent.click(screen.getByText('Agents').closest('button')!);

      const row = await screen.findByText('Policy Assistant');
      fireEvent.click(row.closest('button')!);

      await waitFor(() => {
        expect(mockUseConversations.updateConversation).toHaveBeenCalledWith(
          'conv-1',
          expect.objectContaining({
            // botId is the only key the server uses to resolve the persona.
            bot: 'prompt-abc123def456',
          }),
        );
      });

      // Attach semantics (agent/model decoupling): the conversation keeps
      // its real model — no synthesized org- model is written, so nothing
      // here can carry Foundry routing fields or become the default model.
      const updates = mockUseConversations.updateConversation.mock.calls.at(
        -1,
      )![1] as Partial<Conversation>;
      expect(updates.model).toBeUndefined();
      expect(mockUseSettings.setDefaultModelId).not.toHaveBeenCalled();
    });

    it('gates prompt agents behind exploreBots like other org-managed agents', () => {
      mockFlags.exploreBots = false;
      mockFoundryAgents.foundryAgents = [promptAgent];

      render(<ModelSelect />);
      fireEvent.click(screen.getByText('Agents').closest('button')!);

      expect(screen.queryByText('Policy Assistant')).not.toBeInTheDocument();
    });

    it('does not leak prompt agents into the foundry- id scheme', async () => {
      // A prompt agent plus a real regional Foundry agent: only the latter
      // may produce a foundry- model.
      mockFoundryAgents.regionalPath = '/subscriptions/x/region-project';
      mockFoundryAgents.foundryAgents = [
        promptAgent,
        {
          id: 'region-1',
          name: 'Region Agent',
          agentName: 'asst_region',
          source: '/subscriptions/x/region-project',
          description: 'Org-managed regional agent',
          type: 'foundry',
        },
      ];

      render(<ModelSelect />);
      fireEvent.click(screen.getByText('Agents').closest('button')!);

      fireEvent.click(
        (await screen.findByText('Region Agent')).closest('button')!,
      );
      await waitFor(() => {
        expect(mockUseConversations.updateConversation).toHaveBeenCalledWith(
          'conv-1',
          expect.objectContaining({
            model: expect.objectContaining({
              id: expect.stringContaining('foundry-'),
              agentId: 'asst_region',
            }),
          }),
        );
      });
    });
  });

  describe('Custom model sources (BYOM)', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
      // The whole BYOM area is gated on the enableBYOModels LD flag,
      // FAIL-CLOSED (absent = hidden) for staged rollout.
      mockFlags.enableBYOModels = true;
    });

    const BYOM_PATH =
      '/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.CognitiveServices/accounts/acct-1';

    const byomModel = (deploymentName: string) => ({
      id: `byom-abc123-${deploymentName}`,
      name: deploymentName,
      deploymentName,
      provider: 'openai' as const,
      maxLength: 128000,
      tokenLimit: 16384,
      isCustomSourceModel: true,
      modelSource: BYOM_PATH,
    });

    /** Stubs the useCustomSourceModels discovery fetch (/api/models/sources). */
    function stubSourcesFetch(models: unknown[]) {
      const fn = vi.fn((url: string) => {
        const body = url.includes('/api/models/sources?')
          ? { sources: [{ path: BYOM_PATH, models }] }
          : {};
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(body),
        } as Response);
      });
      global.fetch = fn as unknown as typeof fetch;
      return fn;
    }

    const connectSource = (overrides?: Record<string, unknown>) => {
      useSettingsStore.setState({
        customModelSources: [
          {
            id: 'ms-1',
            name: 'My Sandbox',
            resourcePath: BYOM_PATH,
            createdAt: '2026-01-01T00:00:00.000Z',
            autoAddNewModels: true,
            excludedModelNames: [],
            selectedModelNames: [],
            ...overrides,
          },
        ],
      });
    };

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('renders a per-source section with discovered models, applying exclusions', async () => {
      stubSourcesFetch([byomModel('my-gpt'), byomModel('old-gpt')]);
      connectSource({ excludedModelNames: ['old-gpt'] });

      render(<ModelSelect />);

      // Section header carries the source name; the excluded deployment is
      // filtered out while the rest render as plain rows.
      expect(await screen.findByText('My Sandbox')).toBeInTheDocument();
      expect(await screen.findByText('my-gpt')).toBeInTheDocument();
      expect(screen.queryByText('old-gpt')).not.toBeInTheDocument();
      // byom models stay out of the family tree, but the tree is intact.
      expect(screen.getByText('GPT')).toBeInTheDocument();
    });

    it('selects a byom model via the normal model-select path', async () => {
      stubSourcesFetch([byomModel('my-gpt')]);
      connectSource();

      render(<ModelSelect />);

      fireEvent.click((await screen.findByText('my-gpt')).closest('button')!);

      await waitFor(() => {
        expect(mockUseConversations.updateConversation).toHaveBeenCalledWith(
          'conv-1',
          expect.objectContaining({
            model: expect.objectContaining({
              id: 'byom-abc123-my-gpt',
              isCustomSourceModel: true,
              modelSource: BYOM_PATH,
            }),
          }),
        );
      });
    });

    it('shows only the allow-listed deployments when auto-add is off', async () => {
      stubSourcesFetch([byomModel('my-gpt'), byomModel('other-gpt')]);
      connectSource({
        autoAddNewModels: false,
        selectedModelNames: ['other-gpt'],
      });

      render(<ModelSelect />);

      expect(await screen.findByText('other-gpt')).toBeInTheDocument();
      expect(screen.queryByText('my-gpt')).not.toBeInTheDocument();
    });

    it('offers the connect-a-source affordance when the enableBYOModels flag is on', () => {
      stubSourcesFetch([]);

      render(<ModelSelect />);

      expect(screen.getByText('Connect a model source')).toBeInTheDocument();
    });

    it('hides the whole BYOM area when the enableBYOModels flag is absent (fail-closed)', () => {
      delete mockFlags.enableBYOModels;
      stubSourcesFetch([]);

      render(<ModelSelect />);

      expect(
        screen.queryByText('Connect a model source'),
      ).not.toBeInTheDocument();
    });

    it('shows an unreachable state with retry when discovery fails for a source', async () => {
      const fetchFn = vi.fn((url: string) => {
        const body = url.includes('/api/models/sources?')
          ? {
              sources: [
                { path: BYOM_PATH, models: [], error: 'discovery_failed' },
              ],
            }
          : {};
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(body),
        } as Response);
      });
      global.fetch = fetchFn as unknown as typeof fetch;
      connectSource();

      render(<ModelSelect />);

      // Distinct error copy, not the misleading empty state.
      expect(
        await screen.findByText(/Couldn't reach this source/),
      ).toBeInTheDocument();
      expect(
        screen.queryByText('No models available from this source'),
      ).not.toBeInTheDocument();

      // Retry re-runs discovery with the server cache busted.
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() =>
        expect(fetchFn).toHaveBeenCalledWith(
          expect.stringContaining('refresh=1'),
        ),
      );
    });

    it('drives the details panel from the byom model own capability metadata', async () => {
      // A reasoning deployment: fixed temperature, reasoning effort control.
      const reasoningModel = {
        ...byomModel('my-o3'),
        supportsTemperature: false,
        supportsReasoningEffort: true,
      };
      stubSourcesFetch([reasoningModel]);
      connectSource();
      mockUseConversations.selectedConversation = {
        ...mockUseConversations.selectedConversation!,
        model: reasoningModel as unknown as Conversation['model'],
      };

      render(<ModelSelect />);
      // Row + details header both carry the name once discovery lands.
      await screen.findAllByText('my-o3');

      fireEvent.click(screen.getByText('Advanced Options'));

      // The synthetic byom id has no OpenAIModels entry — the selected model
      // object itself must supply the capability flags.
      expect(await screen.findByText('Reasoning Effort')).toBeInTheDocument();
      expect(
        screen.getByText(
          'This model uses fixed temperature values for consistent performance',
        ),
      ).toBeInTheDocument();
    });

    describe('family hierarchy in source sections', () => {
      /** A known-family (Mistral) byom deployment with hierarchy metadata. */
      const mistralDeployment = (
        deploymentName: string,
        meta: Record<string, unknown>,
        { hash = 'abc123', path = BYOM_PATH } = {},
      ) => ({
        id: `byom-${hash}-${deploymentName}`,
        name: deploymentName,
        deploymentName,
        provider: 'mistral' as const,
        maxLength: 128000,
        tokenLimit: 16384,
        isCustomSourceModel: true,
        modelSource: path,
        // Namespaced per source — never collides with the catalog 'mistral'
        // series or another source's.
        series: `byom-${hash}:mistral`,
        seriesLabel: 'Mistral',
        sourceLocation: 'swedencentral',
        ...meta,
      });

      /** Large (family default), Medium (newest), Small. */
      const mistralFamily = (opts?: { hash?: string; path?: string }) => [
        mistralDeployment(
          'Mistral-Large-3',
          {
            versionLabel: '3',
            variant: 'large',
            variantLabel: 'Large',
            variantRank: 1,
            defaultRank: 1,
            deploymentModelVersion: '2411',
          },
          opts,
        ),
        mistralDeployment(
          'mistral-medium-2505',
          {
            versionLabel: '2505',
            variant: 'medium',
            variantLabel: 'Medium',
            variantRank: 2,
          },
          opts,
        ),
        mistralDeployment(
          'mistral-small-2503',
          {
            versionLabel: '2503',
            variant: 'small',
            variantLabel: 'Small',
            variantRank: 3,
          },
          opts,
        ),
      ];

      it('consolidates a known family into ONE row and selects the representative on click', async () => {
        stubSourcesFetch(mistralFamily());
        connectSource();

        render(<ModelSelect />);

        const section = (await screen.findByText('My Sandbox')).closest(
          'section',
        )!;
        const familyRow = (await within(section).findByText('Mistral')).closest(
          'button',
        )!;

        // One row fronted by the representative's variant+version tag —
        // NOT three deployment rows.
        expect(within(familyRow).getByText('Large 3')).toBeInTheDocument();
        expect(
          within(section).queryByText('mistral-medium-2505'),
        ).not.toBeInTheDocument();
        expect(
          within(section).queryByText('mistral-small-2503'),
        ).not.toBeInTheDocument();

        // The catalog's own Mistral family row is untouched (namespaced
        // byom series never merge into the main tree): one row in the tree
        // plus one in the source section.
        expect(screen.getAllByText('Mistral')).toHaveLength(2);

        // Clicking the family row selects the representative: defaultRank 1
        // (Large) wins even though Medium ranks newer by versionLabel.
        fireEvent.click(familyRow);
        await waitFor(() => {
          expect(mockUseConversations.updateConversation).toHaveBeenCalledWith(
            'conv-1',
            expect.objectContaining({
              model: expect.objectContaining({
                id: 'byom-abc123-Mistral-Large-3',
                isCustomSourceModel: true,
              }),
            }),
          );
        });
      });

      it('feeds the details panel Variant/Version controls from the source models and shows the Deployment section', async () => {
        // A second Large version so the Version chip strip renders too.
        const family = [
          ...mistralFamily(),
          mistralDeployment('Mistral-Large-2', {
            versionLabel: '2',
            variant: 'large',
            variantLabel: 'Large',
            variantRank: 1,
          }),
        ];
        stubSourcesFetch(family);
        connectSource();
        mockUseConversations.selectedConversation = {
          ...mockUseConversations.selectedConversation!,
          model: family[0] as unknown as Conversation['model'],
        };

        render(<ModelSelect />);
        await screen.findByText('My Sandbox');

        // Variant control spans the source family (fed by familyModels —
        // none of these ids exist in the catalog).
        const variantGroup = await screen.findByRole('group', {
          name: 'Variant',
        });
        expect(within(variantGroup).getByText('Large')).toBeInTheDocument();
        expect(within(variantGroup).getByText('Medium')).toBeInTheDocument();
        expect(within(variantGroup).getByText('Small')).toBeInTheDocument();

        // Version chips cover the active (Large) variant only.
        const versionGroup = screen.getByRole('group', { name: 'Version' });
        expect(
          within(versionGroup).getByTitle('Mistral-Large-3'),
        ).toBeInTheDocument();
        expect(
          within(versionGroup).getByTitle('Mistral-Large-2'),
        ).toBeInTheDocument();
        expect(
          within(versionGroup).queryByTitle('mistral-medium-2505'),
        ).not.toBeInTheDocument();

        // Deployment section: title + row for the deployment name label…
        expect(screen.getAllByText('Deployment')).toHaveLength(2);
        // …source, account + subscription (parsed from the ARM path),
        // raw Azure region, model version, and publisher.
        expect(screen.getByText('Source')).toBeInTheDocument();
        expect(screen.getByText('acct-1 · sub-1')).toBeInTheDocument();
        expect(screen.getByText('swedencentral')).toBeInTheDocument();
        expect(screen.getByText('Model version')).toBeInTheDocument();
        expect(screen.getByText('2411')).toBeInTheDocument();
        expect(screen.getByText('Mistral AI')).toBeInTheDocument();

        // Switching variant selects that variant's representative from the
        // source pool (no 3-version Medium exists → falls to 2505).
        fireEvent.click(within(variantGroup).getByText('Medium'));
        await waitFor(() => {
          expect(mockUseSettings.setDefaultModelId).toHaveBeenCalledWith(
            'byom-abc123-mistral-medium-2505',
          );
        });
      });

      it('renders one family row per source when two sources share a family', async () => {
        const PATH_2 =
          '/subscriptions/sub-2/resourceGroups/rg-2/providers/Microsoft.CognitiveServices/accounts/acct-2';
        const fn = vi.fn((url: string) => {
          const body = url.includes('/api/models/sources?')
            ? {
                sources: [
                  { path: BYOM_PATH, models: mistralFamily() },
                  {
                    path: PATH_2,
                    models: mistralFamily({ hash: 'def456', path: PATH_2 }),
                  },
                ],
              }
            : {};
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(body),
          } as Response);
        });
        global.fetch = fn as unknown as typeof fetch;
        useSettingsStore.setState({
          customModelSources: [
            {
              id: 'ms-1',
              name: 'Sandbox A',
              resourcePath: BYOM_PATH,
              createdAt: '2026-01-01T00:00:00.000Z',
              autoAddNewModels: true,
              excludedModelNames: [],
              selectedModelNames: [],
            },
            {
              id: 'ms-2',
              name: 'Sandbox B',
              resourcePath: PATH_2,
              createdAt: '2026-01-01T00:00:00.000Z',
              autoAddNewModels: true,
              excludedModelNames: [],
              selectedModelNames: [],
            },
          ],
        });

        render(<ModelSelect />);

        const sectionA = (await screen.findByText('Sandbox A')).closest(
          'section',
        )!;
        const sectionB = (await screen.findByText('Sandbox B')).closest(
          'section',
        )!;
        expect(await within(sectionA).findAllByText('Mistral')).toHaveLength(1);
        expect(await within(sectionB).findAllByText('Mistral')).toHaveLength(1);
      });
    });

    it('disconnect removes the source from the store and the section from the list', async () => {
      stubSourcesFetch([byomModel('my-gpt')]);
      connectSource();

      render(<ModelSelect />);
      await screen.findByText('my-gpt');

      fireEvent.click(
        screen.getByRole('button', { name: 'Disconnect My Sandbox' }),
      );

      expect(useSettingsStore.getState().customModelSources).toHaveLength(0);
      await waitFor(() => {
        expect(screen.queryByText('my-gpt')).not.toBeInTheDocument();
      });
    });
  });
});
