import { IconX } from '@tabler/icons-react';
import { useFlags } from 'launchdarkly-react-client-sdk';
import React, { FC, useEffect, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useConversations } from '@/client/hooks/conversation/useConversations';
import { useAgentManagement } from '@/client/hooks/settings/useAgentManagement';
import { useModelOrder } from '@/client/hooks/settings/useModelOrder';
import { useModelSelectState } from '@/client/hooks/settings/useModelSelectState';
import { useSettings } from '@/client/hooks/settings/useSettings';

import { Conversation } from '@/types/chat';
import { OpenAIModel, OpenAIModelID, OpenAIModels } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';

import { AzureAIIcon, AzureOpenAIIcon } from '../Icons/providers';
import { TabNavigation } from '../UI/TabNavigation';
import { CustomAgentForm } from './CustomAgents/CustomAgentForm';
import { ModelCard } from './ModelCard';
import { AgentsTab } from './ModelSelect/AgentsTab';
import { ModelDetailsPanel } from './ModelSelect/ModelDetailsPanel';
import { ModelOrderControls } from './ModelSelect/ModelOrderControls';
import { ModelProviderIcon } from './ModelSelect/ModelProviderIcon';
import { ModelTypeIcon } from './ModelSelect/ModelTypeIcon';

import { CustomAgent } from '@/client/stores/settingsStore';
import {
  getOrganizationAgentIdFromModelId,
  getOrganizationAgents,
} from '@/lib/organizationAgents';

interface ModelSelectProps {
  onClose?: () => void;
}

export const ModelSelect: FC<ModelSelectProps> = ({ onClose }) => {
  const t = useTranslations();
  const { exploreBots, enableClaudeModels } = useFlags();
  const { selectedConversation, updateConversation, conversations } =
    useConversations();
  const { models, defaultModelId, setDefaultModelId, setDefaultSearchMode } =
    useSettings();

  // Feature flag: Control organization bots visibility via LaunchDarkly
  // Default to true if LaunchDarkly is not configured (for local development)
  const isBotsEnabled = exploreBots !== false;

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

  // Feature flag: Control Claude models visibility via LaunchDarkly
  // Default to true if LaunchDarkly is not configured (for local development)
  const isClaudeEnabled = enableClaudeModels !== false;

  // Filter out disabled models and custom agents (custom agents should only appear in Agents tab)
  const baseModels = useMemo(
    () =>
      models.filter(
        (m) =>
          !OpenAIModels[m.id as OpenAIModelID]?.isDisabled &&
          !m.id.startsWith('custom-') &&
          !m.isCustomAgent &&
          (OpenAIModels[m.id as OpenAIModelID]?.provider !== 'anthropic' ||
            isClaudeEnabled),
      ),
    [models, isClaudeEnabled],
  );

  // Use the model ordering hook for sorting and reordering
  const {
    orderedModels,
    orderMode,
    setOrderMode,
    moveModel,
    resetOrder,
    canMoveUp,
    canMoveDown,
  } = useModelOrder(baseModels);

  // Edit mode for manual model reordering
  const [isEditingOrder, setIsEditingOrder] = useState(false);

  /**
   * Toggle edit mode for model ordering.
   * When entering edit mode, switch to 'custom' order mode if not already.
   */
  const handleToggleEditOrder = () => {
    if (!isEditingOrder && orderMode !== 'custom') {
      // Entering edit mode: switch to custom order
      setOrderMode('custom');
    }
    setIsEditingOrder(!isEditingOrder);
  };

  // Track which agents have defunct base models (deprecated/removed)
  // These agents are shown in the UI but cannot be selected
  const defunctAgentIds = useMemo(() => {
    return new Set(
      customAgents
        .filter((agent) => !OpenAIModels[agent.baseModelId])
        .map((agent) => agent.id),
    );
  }, [customAgents]);

  // Convert custom agents to OpenAIModel format (only valid ones)
  // Agents with defunct base models are filtered out here but displayed separately in AgentsTab
  const customAgentModels: OpenAIModel[] = useMemo(() => {
    return customAgents
      .filter((agent) => !defunctAgentIds.has(agent.id))
      .map((agent) => {
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
  }, [customAgents, defunctAgentIds]);

  // Convert organization agents to OpenAIModel format
  // Only include organization agents if the exploreBots feature flag is enabled
  const organizationAgentModels: OpenAIModel[] = useMemo(() => {
    // Feature flag check: Skip organization agents if disabled in LaunchDarkly
    if (!isBotsEnabled) {
      return [];
    }

    const orgAgents = getOrganizationAgents();
    return orgAgents.map((agent) => {
      // Use gpt-4.1 as default base model for RAG agents, or specified baseModelId
      const baseModelId =
        (agent.baseModelId as OpenAIModelID) || OpenAIModelID.GPT_4_1;
      const baseModel =
        OpenAIModels[baseModelId] || OpenAIModels[OpenAIModelID.GPT_4_1];
      return {
        ...baseModel,
        id: `org-${agent.id}`,
        name: agent.name,
        description: agent.description,
        modelType: agent.type === 'foundry' ? ('agent' as const) : undefined,
        agentId: agent.agentId, // For foundry agents
        isOrganizationAgent: true,
      };
    });
  }, [isBotsEnabled]);

  // Combine base models, custom agents, and organization agents
  const availableModels = [
    ...baseModels,
    ...customAgentModels,
    ...organizationAgentModels,
  ];

  const selectedModel =
    availableModels.find((m) => m.id === selectedModelId) || availableModels[0];
  const modelConfig = selectedModel
    ? OpenAIModels[selectedModel.id as OpenAIModelID]
    : null;
  const isCustomAgent = selectedModel?.isCustomAgent === true;
  const isGpt5 = selectedModel?.id === OpenAIModelID.GPT_5_2;
  // Check agentId on both modelConfig (for base models) and selectedModel (for org/custom agents)
  const agentAvailable =
    modelConfig?.agentId !== undefined || selectedModel?.agentId !== undefined;

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
  // NOTE: This should ONLY run when conversation or model changes, NOT when search mode changes
  useEffect(() => {
    if (!selectedConversation) return;

    const searchMode = selectedConversation.defaultSearchMode;

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

    // Set bot ID for organization agents (enables RAG)
    const orgAgentId = getOrganizationAgentIdFromModelId(model.id);
    if (orgAgentId) {
      updates.bot = orgAgentId;
      console.log(
        `[ModelSelect] Setting bot to organization agent: ${orgAgentId}`,
      );
    } else if (selectedConversation.bot) {
      // Clear bot if switching away from an organization agent
      updates.bot = undefined;
      console.log(`[ModelSelect] Clearing bot (switched to non-org agent)`);
    }

    // Check if the new model supports agents (check both static config and model object for org agents)
    const newModelConfig = OpenAIModels[model.id as OpenAIModelID];
    const newModelHasAgent =
      newModelConfig?.agentId !== undefined || model.agentId !== undefined;

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

    console.log(
      `[ModelSelect] Updating conversation ${selectedConversation.id} with model: ${model.id}`,
    );
    updateConversation(selectedConversation.id, updates);

    // Don't auto-close - let user review settings and close manually
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
            label: t('modelSelect.tabs.models'),
            icon: <AzureOpenAIIcon className="w-5 h-5" />,
            width: '110px',
          },
          {
            id: 'agents',
            label: t('modelSelect.tabs.agents'),
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
              } w-full md:w-80 flex-shrink-0 overflow-y-auto md:border-e border-gray-200 dark:border-gray-700 md:pe-4`}
            >
              <div className="space-y-4">
                {/* Base Models */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">
                      {t('modelSelect.sections.baseModels')}
                    </h4>
                    <ModelOrderControls
                      orderMode={orderMode}
                      onOrderModeChange={setOrderMode}
                      onReset={resetOrder}
                      isEditing={isEditingOrder}
                      onToggleEdit={handleToggleEditOrder}
                    />
                  </div>
                  <div className="space-y-2">
                    {orderedModels.map((model) => {
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
                          typeIcon={
                            <ModelTypeIcon modelType={config?.modelType} />
                          }
                          showReorderControls={isEditingOrder}
                          canMoveUp={canMoveUp(model.id)}
                          canMoveDown={canMoveDown(model.id)}
                          onMoveUp={() => moveModel(model.id, 'up')}
                          onMoveDown={() => moveModel(model.id, 'down')}
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
          openAgentForm={openAgentForm}
          customAgents={customAgents}
          handleEditAgent={handleEditAgent}
          handleDeleteAgent={handleDeleteAgent}
          handleModelSelect={handleModelSelect}
          customAgentModels={customAgentModels}
          organizationAgentModels={organizationAgentModels}
          selectedModelId={selectedModelId}
          defunctAgentIds={defunctAgentIds}
          // Props for details panel
          selectedModel={selectedModel}
          modelConfig={modelConfig}
          isCustomAgent={isCustomAgent}
          searchModeEnabled={searchModeEnabled}
          displaySearchMode={displaySearchMode}
          agentAvailable={agentAvailable}
          showModelAdvanced={showModelAdvanced}
          selectedConversation={selectedConversation}
          mobileView={mobileView}
          setMobileView={setMobileView}
          handleToggleSearchMode={handleToggleSearchMode}
          handleSetSearchMode={handleSetSearchMode}
          setShowModelAdvanced={setShowModelAdvanced}
          updateConversation={updateConversation}
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
