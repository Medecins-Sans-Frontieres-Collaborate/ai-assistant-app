import { IconCpu, IconTemperature, IconTool, IconX } from '@tabler/icons-react';
import React, { FC, useEffect, useMemo, useState } from 'react';
import { RiRobot2Line } from 'react-icons/ri';

import { useTranslations } from 'next-intl';

import { useConversations } from '@/client/hooks/conversation/useConversations';
import { useAgentManagement } from '@/client/hooks/settings/useAgentManagement';
import { useModelSelectState } from '@/client/hooks/settings/useModelSelectState';
import { useModelSelection } from '@/client/hooks/settings/useModelSelection';
import { useSettings } from '@/client/hooks/settings/useSettings';

import { Conversation } from '@/types/chat';
import { OpenAIModel, OpenAIModelID, OpenAIModels } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';

import {
  AzureAIIcon,
  AzureOpenAIIcon,
  DeepSeekIcon,
  MetaIcon,
  OpenAIIcon,
  XAIIcon,
} from '../Icons/providers';
import { TabNavigation } from '../UI/TabNavigation';
import { CustomAgentForm } from './CustomAgents/CustomAgentForm';
import { ModelCard } from './ModelCard';
import { AgentsTab } from './ModelSelect/AgentsTab';
import { ModelDetailsPanel } from './ModelSelect/ModelDetailsPanel';
import { ModelProviderIcon } from './ModelSelect/ModelProviderIcon';

import { CustomAgent } from '@/client/stores/settingsStore';

interface ModelSelectProps {
  onClose?: () => void;
}

export const ModelSelect: FC<ModelSelectProps> = ({ onClose }) => {
  const t = useTranslations();
  const { selectedConversation, updateConversation, conversations } =
    useConversations();
  const { models, defaultModelId, setDefaultModelId, setDefaultSearchMode } =
    useSettings();

  const selectedModelId = selectedConversation?.model?.id || defaultModelId;

  // Check if the currently selected model is a custom agent
  const isSelectedModelAgent = selectedModelId?.startsWith('custom-') ?? false;

  // Custom hooks for state management
  const {
    activeTab,
    setActiveTab,
    showAgentForm,
    editingAgent,
    openAgentForm,
    closeAgentForm,
    showModelAdvanced,
    setShowModelAdvanced,
    mobileView,
    setMobileView,
    showAgentWarning,
    setShowAgentWarning,
  } = useModelSelectState(isSelectedModelAgent);

  // Agent management
  const {
    customAgents,
    handleSaveAgent: saveAgentToStore,
    handleDeleteAgent: deleteAgentFromStore,
  } = useAgentManagement();

  // Filter out disabled models and custom agents (custom agents should only appear in Agents tab)
  const baseModels = models
    .filter(
      (m) =>
        !OpenAIModels[m.id as OpenAIModelID]?.isDisabled &&
        !m.id.startsWith('custom-') &&
        !m.isCustomAgent,
    )
    .sort((a, b) => {
      // Sort by enum order (defined in types/openai.ts)
      const enumValues = Object.values(OpenAIModelID);
      const aIndex = enumValues.indexOf(a.id as OpenAIModelID);
      const bIndex = enumValues.indexOf(b.id as OpenAIModelID);
      return (aIndex === -1 ? 99 : aIndex) - (bIndex === -1 ? 99 : bIndex);
    });

  // Convert custom agents to OpenAIModel format
  const customAgentModels: OpenAIModel[] = useMemo(() => {
    return customAgents.map((agent) => {
      const baseModel = OpenAIModels[agent.baseModelId];
      return {
        ...baseModel,
        id: `custom-${agent.id}`,
        name: agent.name,
        agentId: agent.agentId,
        description:
          agent.description || `Custom agent based on ${baseModel.name}`,
        modelType: 'agent' as const,
        isCustomAgent: true,
      };
    });
  }, [customAgents]);

  // Combine base models and custom agents
  const availableModels = [...baseModels, ...customAgentModels];

  const selectedModel =
    availableModels.find((m) => m.id === selectedModelId) || availableModels[0];
  const modelConfig = selectedModel
    ? OpenAIModels[selectedModel.id as OpenAIModelID]
    : null;
  const isCustomAgent = selectedModel?.isCustomAgent === true;
  const isGpt5 = selectedModel?.id === OpenAIModelID.GPT_5_2;
  const agentAvailable = modelConfig?.agentId !== undefined;

  // Get current search mode from conversation (default to INTELLIGENT for privacy)
  const currentSearchMode =
    selectedConversation?.defaultSearchMode ?? SearchMode.INTELLIGENT;
  const searchModeEnabled = currentSearchMode !== SearchMode.OFF;

  // For non-agent models, if AGENT mode is somehow set, display as INTELLIGENT in UI
  const displaySearchMode =
    currentSearchMode === SearchMode.AGENT && !agentAvailable
      ? SearchMode.INTELLIGENT
      : currentSearchMode;

  // Automatically fix invalid state when conversation loads with AGENT mode on non-agent model
  // Also ensure custom agents always have search mode OFF
  // NOTE: This should ONLY run when conversation or model changes, NOT when search mode changes
  useEffect(() => {
    if (!selectedConversation) return;

    const searchMode = selectedConversation.defaultSearchMode;

    // Custom agents should always have search mode OFF
    if (isCustomAgent && searchMode !== SearchMode.OFF) {
      console.log(
        '[ModelSelect] Auto-fixing custom agent to have search mode OFF',
      );
      updateConversation(selectedConversation.id, {
        defaultSearchMode: SearchMode.OFF,
      });
      return;
    }

    // Fix invalid AGENT mode on non-agent models
    if (!isCustomAgent && searchMode === SearchMode.AGENT && !agentAvailable) {
      console.log(
        '[ModelSelect] Auto-fixing invalid AGENT mode for non-agent model',
      );
      updateConversation(selectedConversation.id, {
        defaultSearchMode: SearchMode.INTELLIGENT,
      });
    }
    // Only depend on conversation ID, model type changes, and agent availability
    // Do NOT depend on currentSearchMode to avoid overriding user changes
  }, [
    selectedConversation?.id,
    selectedConversation,
    agentAvailable,
    isCustomAgent,
    updateConversation,
  ]);

  const handleModelSelect = (model: OpenAIModel) => {
    if (!selectedConversation) {
      console.warn(
        '[ModelSelect] No conversation selected, cannot update model',
      );
      return;
    }

    // Validate that the model exists in available models
    if (!availableModels.find((m) => m.id === model.id)) {
      console.error(
        '[ModelSelect] Selected model not found in available models:',
        model.id,
      );
      return;
    }

    // Switch to details view on mobile when a model is selected
    setMobileView('details');

    // Set as default model for future conversations
    console.log(
      `[ModelSelect] Setting default model to: ${model.id} (${model.name})`,
    );
    setDefaultModelId(model.id as OpenAIModelID);

    // Update conversation with selected model
    // Initialize defaultSearchMode to INTELLIGENT (privacy-focused) if not already set
    const updates: Partial<Conversation> = {
      model: model,
    };

    // Custom agents always have search mode OFF
    if (model.isCustomAgent) {
      updates.defaultSearchMode = SearchMode.OFF;
      console.log(
        `[ModelSelect] Setting search mode to OFF for custom agent: ${model.id}`,
      );
    } else {
      // Check if the new model supports agents
      const newModelConfig = OpenAIModels[model.id as OpenAIModelID];
      const newModelHasAgent = newModelConfig?.agentId !== undefined;

      // If switching to a model without agent support and current mode is AGENT, reset to INTELLIGENT
      if (
        !newModelHasAgent &&
        selectedConversation.defaultSearchMode === SearchMode.AGENT
      ) {
        updates.defaultSearchMode = SearchMode.INTELLIGENT;
        console.log(
          `[ModelSelect] Resetting AGENT mode to INTELLIGENT for non-agent model`,
        );
      }

      // Only set defaultSearchMode if it's not already set on the conversation
      if (selectedConversation.defaultSearchMode === undefined) {
        updates.defaultSearchMode = SearchMode.INTELLIGENT;
        console.log(
          `[ModelSelect] Initializing defaultSearchMode to INTELLIGENT`,
        );
      }
    }

    console.log(
      `[ModelSelect] Updating conversation ${selectedConversation.id} with model: ${model.id}`,
    );
    updateConversation(selectedConversation.id, updates);
  };

  const handleToggleSearchMode = () => {
    if (!selectedConversation) return;

    const newMode = searchModeEnabled ? SearchMode.OFF : SearchMode.INTELLIGENT;

    console.log(
      `[ModelSelect] Toggling Search Mode: ${currentSearchMode} → ${newMode}`,
    );

    // Update current conversation
    updateConversation(selectedConversation.id, {
      defaultSearchMode: newMode,
    });

    // Set as default search mode for future conversations
    setDefaultSearchMode(newMode);
  };

  const handleSetSearchMode = (mode: SearchMode) => {
    if (!selectedConversation) return;

    console.log(
      `[ModelSelect] Setting Search Mode: ${currentSearchMode} → ${mode}`,
    );

    // Update current conversation
    updateConversation(selectedConversation.id, {
      defaultSearchMode: mode,
    });

    // Set as default search mode for future conversations
    setDefaultSearchMode(mode);
  };

  const handleSaveAgent = (agent: CustomAgent) => {
    saveAgentToStore(agent);
    closeAgentForm();
  };

  const handleEditAgent = (agent: CustomAgent) => {
    openAgentForm(agent);
  };

  const handleImportAgents = (agents: CustomAgent[]) => {
    agents.forEach((agent) => {
      saveAgentToStore(agent);
    });
  };

  const handleDeleteAgent = (agentId: string) => {
    deleteAgentFromStore(agentId);

    // If currently selected model is the deleted agent, switch to default
    if (
      selectedConversation &&
      selectedConversation.model?.id === `custom-${agentId}`
    ) {
      const defaultModel = baseModels[0];
      // Only update the model field to avoid overwriting other conversation properties
      updateConversation(selectedConversation.id, {
        model: defaultModel,
      });
    }
  };

  return (
    <div className="w-full h-full flex flex-col">
      {/* Tab Navigation */}
      <TabNavigation
        tabs={[
          {
            id: 'models',
            label: 'Models',
            icon: <AzureOpenAIIcon className="w-5 h-5" />,
            width: '110px',
          },
          {
            id: 'agents',
            label: 'Agents',
            icon: <AzureAIIcon className="w-5 h-5" />,
            width: '115px',
          },
        ]}
        activeTab={activeTab}
        onTabChange={(tab) => setActiveTab(tab as 'models' | 'agents')}
        onClose={onClose}
        closeIcon={<IconX size={20} />}
      />

      {/* Models Tab Content */}
      {activeTab === 'models' && (
        <div
          className="flex-1 flex flex-col overflow-hidden animate-fade-in-fast"
          key="models-tab"
        >
          <div className="flex-1 flex flex-col md:flex-row gap-4 md:gap-6 overflow-hidden p-4 md:p-0">
            {/* Left: Model List */}
            <div
              className={`${
                mobileView === 'details' ? 'hidden md:block' : 'block'
              } w-full md:w-80 flex-shrink-0 overflow-y-auto md:border-r border-gray-200 dark:border-gray-700 md:pr-4`}
            >
              <div className="space-y-4">
                {/* Base Models */}
                <div>
                  <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase mb-2">
                    Base Models
                  </h4>
                  <div className="space-y-2">
                    {baseModels.map((model) => {
                      const config = OpenAIModels[model.id as OpenAIModelID];
                      const isSelected = selectedModelId === model.id;

                      return (
                        <ModelCard
                          key={model.id}
                          id={model.id}
                          name={model.name}
                          isSelected={isSelected}
                          onClick={() => handleModelSelect(model)}
                          icon={
                            <ModelProviderIcon provider={config?.provider} />
                          }
                        />
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            {/* Right: Model Details */}
            <div
              className={`${
                mobileView === 'list' ? 'hidden md:block' : 'block'
              } flex-1 overflow-y-auto`}
            >
              {selectedModel && (modelConfig || isCustomAgent) && (
                <ModelDetailsPanel
                  selectedModel={selectedModel}
                  modelConfig={modelConfig}
                  isCustomAgent={isCustomAgent}
                  searchModeEnabled={searchModeEnabled}
                  displaySearchMode={displaySearchMode}
                  agentAvailable={agentAvailable}
                  showModelAdvanced={showModelAdvanced}
                  selectedConversation={selectedConversation}
                  setMobileView={setMobileView}
                  handleToggleSearchMode={handleToggleSearchMode}
                  handleSetSearchMode={handleSetSearchMode}
                  setShowModelAdvanced={setShowModelAdvanced}
                  updateConversation={updateConversation}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'agents' && (
        <AgentsTab
          showAgentWarning={showAgentWarning}
          setShowAgentWarning={setShowAgentWarning}
          openAgentForm={openAgentForm}
          customAgents={customAgents}
          handleEditAgent={handleEditAgent}
          handleDeleteAgent={handleDeleteAgent}
          handleImportAgents={handleImportAgents}
          handleModelSelect={handleModelSelect}
          customAgentModels={customAgentModels}
          selectedModelId={selectedModelId}
        />
      )}

      {/* Custom Agent Form Modal */}
      {showAgentForm && (
        <CustomAgentForm
          onSave={handleSaveAgent}
          onClose={closeAgentForm}
          existingAgent={editingAgent}
          existingAgents={customAgents}
        />
      )}
    </div>
  );
};
