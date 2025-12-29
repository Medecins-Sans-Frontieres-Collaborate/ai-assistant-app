import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import { Conversation } from '@/types/chat';
import { OpenAIModelID, OpenAIModels } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';

import { ModelSelect } from '@/components/Chat/ModelSelect';

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

vi.mock('@/client/hooks/conversation/useConversations', () => ({
  useConversations: () => mockUseConversations,
}));

vi.mock('@/client/hooks/settings/useSettings', () => ({
  useSettings: () => mockUseSettings,
}));

vi.mock('@/client/hooks/settings/useCustomAgents', () => ({
  useCustomAgents: () => mockUseCustomAgents,
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

describe('ModelSelect', () => {
  beforeEach(() => {
    vi.clearAllMocks();

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
    it('renders list of available models', () => {
      render(<ModelSelect />);

      // Check that model buttons exist (using getAllByRole since there might be multiple GPT-5 variants)
      const gpt5Buttons = screen
        .getAllByRole('button')
        .filter((btn) => btn.textContent?.includes('GPT-5'));
      expect(gpt5Buttons.length).toBeGreaterThan(0);

      // Check for DeepSeek
      expect(
        screen.getByRole('button', { name: /DeepSeek-V3\.1/i }),
      ).toBeInTheDocument();

      // Check for Llama
      expect(
        screen.getByRole('button', { name: /Llama 4 Maverick/i }),
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

      const deepseekButton = screen
        .getByText('DeepSeek-V3.1')
        .closest('button');
      expect(deepseekButton).not.toBeNull();

      fireEvent.click(deepseekButton!);

      await waitFor(() => {
        expect(mockUseConversations.updateConversation).toHaveBeenCalled();
      });
    });

    it('sets default model when model is selected', async () => {
      render(<ModelSelect />);

      const deepseekButton = screen
        .getByText('DeepSeek-V3.1')
        .closest('button');
      fireEvent.click(deepseekButton!);

      await waitFor(() => {
        expect(mockUseSettings.setDefaultModelId).toHaveBeenCalledWith(
          OpenAIModelID.DEEPSEEK_V3_1,
        );
      });
    });

    it('sets model with agent capabilities', async () => {
      render(<ModelSelect />);

      const gpt41Button = screen.getByRole('button', { name: /GPT-4\.1/i });
      fireEvent.click(gpt41Button);

      await waitFor(() => {
        expect(mockUseConversations.updateConversation).toHaveBeenCalledWith(
          'conv-1',
          expect.objectContaining({
            model: expect.objectContaining({
              agentId: 'asst_Puf3ldskHlYHmW5z9aQy5fZL',
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
    it('displays model type badge', () => {
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

      expect(screen.getByText('omni')).toBeInTheDocument();
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

      expect(screen.getByText(/Knowledge cutoff:/)).toBeInTheDocument();
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

      expect(screen.getByText(/most advanced model/)).toBeInTheDocument();
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

    it('orders providers correctly (OpenAI, DeepSeek, Meta)', () => {
      const { container } = render(<ModelSelect />);

      const modelButtons = screen
        .getAllByRole('button')
        .filter((button) => button.querySelector('.font-medium'));

      // Get model names in order
      const modelNames = modelButtons.map(
        (button) => button.querySelector('.font-medium')?.textContent || '',
      );

      // GPT-5 (OpenAI) should come before Llama (Meta), and Llama before DeepSeek
      const gpt5Index = modelNames.findIndex((name) => name.includes('GPT-5'));
      const llamaIndex = modelNames.findIndex((name) => name.includes('Llama'));
      const deepseekIndex = modelNames.findIndex((name) =>
        name.includes('DeepSeek'),
      );

      expect(gpt5Index).toBeLessThan(llamaIndex);
      expect(llamaIndex).toBeLessThan(deepseekIndex);
    });

    it('places GPT-4.1 first among OpenAI models', () => {
      const { container } = render(<ModelSelect />);

      const modelButtons = screen
        .getAllByRole('button')
        .filter((button) => button.querySelector('.font-medium'));

      const modelNames = modelButtons.map(
        (button) => button.querySelector('.font-medium')?.textContent || '',
      );

      const openAIModels = modelNames.filter(
        (name) => name.includes('GPT') || name.includes('o3'),
      );

      // GPT-4.1 should be first (agent model)
      expect(openAIModels[0]).toContain('GPT-4.1');
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
});
