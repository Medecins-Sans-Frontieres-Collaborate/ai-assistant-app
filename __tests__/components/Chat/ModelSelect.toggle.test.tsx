import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import { Conversation } from '@/types/chat';
import { OpenAIModelID, OpenAIModels } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';

import { ModelSelect } from '@/components/Chat/ModelSelect';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for ModelSelect toggle functionality
 * Verifies search mode and Azure Agent mode toggles work correctly
 */

// Mock the hooks
const mockUseConversations = {
  selectedConversation: null as Conversation | null,
  updateConversation: vi.fn(),
  conversations: [],
};

const mockUseSettings = {
  models: Object.values(OpenAIModels).filter((m) => !m.isDisabled),
  defaultModelId: OpenAIModelID.GPT_4_1,
  setDefaultModelId: vi.fn(),
  setDefaultSearchMode: vi.fn(),
};

const mockUseCustomAgents = {
  customAgents: [],
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

// Note: next-intl is mocked globally in vitest.setup.dom.ts

describe('ModelSelect - Toggle Functionality', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Search Mode State', () => {
    it('displays search mode toggle for all models', () => {
      mockUseConversations.selectedConversation = {
        id: 'conv-1',
        name: 'Test',
        messages: [],
        model: {
          ...OpenAIModels[OpenAIModelID.GPT_5_2],
        },
        prompt: '',
        temperature: 0.7,
        folderId: null,
      };

      render(<ModelSelect />);

      // Should display search mode toggle
      expect(screen.getByText('Search Mode')).toBeInTheDocument();
    });

    it('shows search routing options when search mode is enabled', () => {
      mockUseConversations.selectedConversation = {
        id: 'conv-1',
        name: 'Test',
        messages: [],
        model: {
          ...OpenAIModels[OpenAIModelID.GPT_4_1],
          agentId: 'asst_123',
        },
        prompt: '',
        temperature: 0.7,
        folderId: null,
        defaultSearchMode: SearchMode.INTELLIGENT, // INTELLIGENT mode
      };

      render(<ModelSelect />);

      // Should show routing options
      expect(screen.getByText(/Privacy-Focused/)).toBeInTheDocument();
      expect(screen.getByText(/Azure AI Agent Mode/)).toBeInTheDocument();
    });

    it('displays search mode toggle correctly', () => {
      // This test verifies the search mode toggle is displayed
      mockUseConversations.selectedConversation = {
        id: 'conv-1',
        name: 'Test',
        messages: [],
        model: {
          ...OpenAIModels[OpenAIModelID.GPT_5_2],
        },
        prompt: '',
        temperature: 0.7,
        folderId: null,
      };

      render(<ModelSelect />);

      // Verify the search mode toggle is displayed
      expect(screen.getByText('Search Mode')).toBeInTheDocument();
    });
  });

  describe('Azure Agent Mode Toggle (within Search Mode)', () => {
    it('toggles Azure Agent Mode OFF to ON (Privacy → AI Foundry)', async () => {
      mockUseConversations.selectedConversation = {
        id: 'conv-1',
        name: 'Test',
        messages: [],
        model: {
          ...OpenAIModels[OpenAIModelID.GPT_4_1],
          agentId: 'asst_123',
        },
        prompt: '',
        temperature: 0.7,
        folderId: null,
        defaultSearchMode: SearchMode.INTELLIGENT, // INTELLIGENT mode
      };

      render(<ModelSelect />);

      // Find the Azure AI Agent Mode radio button
      const azureAgentRadio = screen
        .getByText(/Azure AI Agent Mode/)
        .closest('label')
        ?.querySelector('input[type="radio"]');

      expect(azureAgentRadio).not.toBeNull();
      fireEvent.click(azureAgentRadio!);

      await waitFor(() => {
        expect(mockUseConversations.updateConversation).toHaveBeenCalledWith(
          'conv-1',
          expect.objectContaining({
            defaultSearchMode: SearchMode.AGENT, // Toggled to AGENT mode
          }),
        );
      });
    });

    it('toggles Azure Agent Mode ON to OFF (AI Foundry → Privacy)', async () => {
      mockUseConversations.selectedConversation = {
        id: 'conv-1',
        name: 'Test',
        messages: [],
        model: {
          ...OpenAIModels[OpenAIModelID.GPT_4_1],
          agentId: 'asst_123',
        },
        prompt: '',
        temperature: 0.7,
        folderId: null,
        defaultSearchMode: SearchMode.AGENT, // AGENT mode (AI Foundry)
      };

      render(<ModelSelect />);

      // Find the Privacy-Focused radio button
      const privacyRadio = screen
        .getByText(/Privacy-Focused/)
        .closest('label')
        ?.querySelector('input[type="radio"]');

      expect(privacyRadio).not.toBeNull();
      fireEvent.click(privacyRadio!);

      await waitFor(() => {
        expect(mockUseConversations.updateConversation).toHaveBeenCalledWith(
          'conv-1',
          expect.objectContaining({
            defaultSearchMode: SearchMode.INTELLIGENT, // Toggled back to INTELLIGENT (privacy-focused)
          }),
        );
      });
    });

    it('shows privacy warning when Azure Agent Mode is ON', () => {
      mockUseConversations.selectedConversation = {
        id: 'conv-1',
        name: 'Test',
        messages: [],
        model: {
          ...OpenAIModels[OpenAIModelID.GPT_4_1],
          agentId: 'asst_123',
        },
        prompt: '',
        temperature: 0.7,
        folderId: null,
        defaultSearchMode: SearchMode.AGENT, // AGENT mode to show warning
      };

      render(<ModelSelect />);

      // Should show privacy warning
      expect(
        screen.getByText(/Important Privacy Information/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          /Your full conversation will be sent to Azure AI Foundry agent/,
        ),
      ).toBeInTheDocument();
    });

    it('hides privacy warning when Azure Agent Mode is OFF', () => {
      mockUseConversations.selectedConversation = {
        id: 'conv-1',
        name: 'Test',
        messages: [],
        model: {
          ...OpenAIModels[OpenAIModelID.GPT_4_1],
          isAgent: false, // Privacy mode
          agentId: 'asst_123',
        },
        prompt: '',
        temperature: 0.7,
        folderId: null,
      };

      render(<ModelSelect />);

      // Should NOT show privacy warning
      expect(
        screen.queryByText(/Important Privacy Information/),
      ).not.toBeInTheDocument();
    });
  });

  describe('Toggle Visibility Rules', () => {
    it('shows Azure Agent Mode options only for models with agentId', () => {
      mockUseConversations.selectedConversation = {
        id: 'conv-1',
        name: 'Test',
        messages: [],
        model: {
          ...OpenAIModels[OpenAIModelID.GPT_4_1], // Has agentId
        },
        prompt: '',
        temperature: 0.7,
        folderId: null,
        defaultSearchMode: SearchMode.INTELLIGENT, // INTELLIGENT mode
      };

      render(<ModelSelect />);

      // Should show Azure AI Agent Mode option
      expect(screen.getByText(/Azure AI Agent Mode/)).toBeInTheDocument();
    });

    it('hides Azure Agent Mode options for models without agentId', () => {
      mockUseConversations.selectedConversation = {
        id: 'conv-1',
        name: 'Test',
        messages: [],
        model: OpenAIModels[OpenAIModelID.GPT_5_MINI], // No agentId
        prompt: '',
        temperature: 0.7,
        folderId: null,
        defaultSearchMode: SearchMode.INTELLIGENT, // Enable search mode
      };

      render(<ModelSelect />);

      // Should show Privacy-focused message (no Azure AI Agent Mode radio buttons)
      expect(
        screen.getByText(/Privacy-focused search enabled/),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Azure AI Agent Mode/)).not.toBeInTheDocument();
    });

    it('hides search routing options when search mode is OFF', () => {
      mockUseConversations.selectedConversation = {
        id: 'conv-1',
        name: 'Test',
        messages: [],
        model: OpenAIModels[OpenAIModelID.GPT_4_1],
        prompt: '',
        temperature: 0.7,
        folderId: null,
        defaultSearchMode: SearchMode.OFF, // Search mode OFF
      };

      render(<ModelSelect />);

      // Should NOT show routing options
      expect(screen.queryByText(/Privacy-Focused/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Azure AI Agent Mode/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Search Routing/)).not.toBeInTheDocument();
    });
  });

  describe('Toggle State Persistence', () => {
    it('maintains toggle state when switching between models', async () => {
      // Start with GPT-4.1 with search mode enabled
      mockUseConversations.selectedConversation = {
        id: 'conv-1',
        name: 'Test',
        messages: [],
        model: OpenAIModels[OpenAIModelID.GPT_4_1],
        prompt: '',
        temperature: 0.7,
        folderId: null,
        defaultSearchMode: SearchMode.INTELLIGENT, // INTELLIGENT mode
      };

      const { rerender } = render(<ModelSelect />);

      // Switch to another model
      const deepseekButton = screen
        .getByText('DeepSeek-V3.1')
        .closest('button');
      fireEvent.click(deepseekButton!);

      await waitFor(() => {
        expect(mockUseConversations.updateConversation).toHaveBeenCalledWith(
          'conv-1',
          expect.objectContaining({
            model: expect.objectContaining({
              id: OpenAIModelID.DEEPSEEK_V3_1,
            }),
          }),
        );
      });
    });
  });
});
