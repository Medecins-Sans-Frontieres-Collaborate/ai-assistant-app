import { IconX } from '@tabler/icons-react';
import { useFlags } from 'launchdarkly-react-client-sdk';
import React, { FC, useCallback, useEffect, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useConversations } from '@/client/hooks/conversation/useConversations';
import { useFoundryAgents } from '@/client/hooks/settings/useFoundryAgents';
import { useModelOrder } from '@/client/hooks/settings/useModelOrder';
import { useModelSelectState } from '@/client/hooks/settings/useModelSelectState';
import { useSettings } from '@/client/hooks/settings/useSettings';

import { Conversation } from '@/types/chat';
import { OpenAIModel, OpenAIModelID, OpenAIModels } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';

import { AzureAIIcon, AzureOpenAIIcon } from '../Icons/providers';
import { TabNavigation } from '../UI/TabNavigation';
import { AgentSourceForm } from './AgentSources/AgentSourceForm';
import { ModelCard } from './ModelCard';
import { AgentsTab } from './ModelSelect/AgentsTab';
import { ModelDetailsPanel } from './ModelSelect/ModelDetailsPanel';
import { ModelOrderControls } from './ModelSelect/ModelOrderControls';
import { ModelProviderIcon } from './ModelSelect/ModelProviderIcon';
import { ModelTypeIcon } from './ModelSelect/ModelTypeIcon';

import { AgentSource, useSettingsStore } from '@/client/stores/settingsStore';
import {
  getOrganizationAgentIdFromModelId,
  getOrganizationAgents,
  getRAGAgents,
  isFoundryAgentId,
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

  // Dynamically discovered Foundry agents (RBAC-filtered per user)
  const { foundryAgents, isLoadingFoundryAgents, refetchFoundryAgents } =
    useFoundryAgents();

  const selectedModelId = selectedConversation?.model?.id || defaultModelId;

  // Check if the currently selected model is a custom/foundry agent
  const isSelectedModelAgent =
    selectedModelId?.startsWith('custom-') ||
    selectedModelId?.startsWith('foundry-') ||
    false;

  // Custom hooks for state management
  const {
    activeTab,
    setActiveTab,
    showAgentForm,
    openAgentForm,
    closeAgentForm,
    showModelAdvanced,
    setShowModelAdvanced,
    mobileView,
    setMobileView,
    showAgentWarning,
    setShowAgentWarning,
  } = useModelSelectState(isSelectedModelAgent);

  // Agent source management
  const customAgentSources = useSettingsStore((s) => s.customAgentSources);
  const addCustomAgentSource = useSettingsStore((s) => s.addCustomAgentSource);
  const updateCustomAgentSource = useSettingsStore(
    (s) => s.updateCustomAgentSource,
  );
  const deleteCustomAgentSource = useSettingsStore(
    (s) => s.deleteCustomAgentSource,
  );
  const [editingSource, setEditingSource] = useState<AgentSource | undefined>();

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

  // Convert organization agents to OpenAIModel format
  // Combines static RAG agents (from JSON config) with dynamically discovered Foundry agents
  const organizationAgentModels: OpenAIModel[] = useMemo(() => {
    // Feature flag check: Skip organization agents if disabled in LaunchDarkly
    if (!isBotsEnabled) {
      return [];
    }

    // Static agents from organization-agents.json (RAG agents + any static Foundry agents)
    const staticAgents = getOrganizationAgents();
    const staticModels = staticAgents.map((agent) => {
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
        agentId: agent.agentId,
        isOrganizationAgent: true,
      };
    });

    // Dynamically discovered Foundry agents from ARM API (RBAC-filtered per user)
    const dynamicModels = foundryAgents.map((agent) => {
      const baseModel = OpenAIModels[OpenAIModelID.GPT_4_1];
      return {
        ...baseModel,
        id: `foundry-${agent.id}`,
        name: agent.name,
        description: agent.description,
        modelType: 'agent' as const,
        agentId: agent.agentName,
        foundryEndpoint: agent.foundryEndpoint,
        isOrganizationAgent: true,
      };
    });

    // Deduplicate: if a Foundry agent exists in both static config and dynamic discovery,
    // prefer the dynamic version (it has RBAC validation)
    const dynamicAgentNames = new Set(foundryAgents.map((a) => a.agentName));
    const deduplicatedStatic = staticModels.filter(
      (m) => !m.agentId || !dynamicAgentNames.has(m.agentId),
    );

    return [...deduplicatedStatic, ...dynamicModels];
  }, [isBotsEnabled, foundryAgents]);

  // Combine base models and organization/discovered agents
  const availableModels = [...baseModels, ...organizationAgentModels];

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

  const handleModelSelect = useCallback(
    (model: OpenAIModel) => {
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

      // Set bot ID for organization agents (enables RAG) or Foundry agents
      const orgAgentId = getOrganizationAgentIdFromModelId(model.id);
      const foundryAgentId = isFoundryAgentId(model.id);
      if (orgAgentId) {
        updates.bot = orgAgentId;
        console.log(
          `[ModelSelect] Setting bot to organization agent: ${orgAgentId}`,
        );
      } else if (foundryAgentId) {
        // Dynamic Foundry agents don't use bot ID — agent routing is via agentId
        // Clear any previous bot setting
        updates.bot = undefined;
        console.log(
          `[ModelSelect] Selected dynamic Foundry agent: ${model.id}`,
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
    },
    [
      selectedConversation,
      availableModels,
      setMobileView,
      setDefaultModelId,
      updateConversation,
    ],
  );

  const handleToggleSearchMode = useCallback(() => {
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
  }, [
    selectedConversation,
    searchModeEnabled,
    currentSearchMode,
    updateConversation,
    setDefaultSearchMode,
  ]);

  const handleSetSearchMode = useCallback(
    (mode: SearchMode) => {
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
    },
    [
      selectedConversation,
      currentSearchMode,
      updateConversation,
      setDefaultSearchMode,
    ],
  );

  const handleSaveAgentSource = useCallback(
    (source: AgentSource) => {
      if (editingSource) {
        updateCustomAgentSource(source);
      } else {
        addCustomAgentSource(source);
      }
      setEditingSource(undefined);
      closeAgentForm();
    },
    [
      editingSource,
      addCustomAgentSource,
      updateCustomAgentSource,
      closeAgentForm,
    ],
  );

  const handleEditSource = useCallback(
    (source: AgentSource) => {
      setEditingSource(source);
      openAgentForm();
    },
    [openAgentForm],
  );

  const handleDeleteAgentSource = useCallback(
    (sourceId: string) => {
      deleteCustomAgentSource(sourceId);
    },
    [deleteCustomAgentSource],
  );

  return (
    <div className="w-full h-full flex flex-col">
      {/* Tab Navigation */}
      <TabNavigation
        tabs={[
          {
            id: 'models',
            label: t('modelSelect.tabs.models'),
            icon: <AzureOpenAIIcon className="w-5 h-5" />,
            width: '115px',
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
              <div className="space-y-3">
                {/* Base Models */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
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
                  <div className="space-y-1">
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
              {selectedModel && (modelConfig || isCustomAgent) ? (
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
              ) : (
                <div className="h-full flex items-center justify-center text-gray-500 dark:text-gray-400">
                  <p className="text-sm">
                    {t('modelSelect.modelsDescription')}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'agents' && (
        <AgentsTab
          handleModelSelect={handleModelSelect}
          organizationAgentModels={organizationAgentModels}
          foundryAgents={foundryAgents}
          selectedModelId={selectedModelId}
          isLoadingFoundryAgents={isLoadingFoundryAgents}
          onRefreshAgents={() => refetchFoundryAgents()}
          agentSources={customAgentSources}
          onAddSource={() => {
            setEditingSource(undefined);
            openAgentForm();
          }}
          onEditSource={handleEditSource}
          onDeleteSource={handleDeleteAgentSource}
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

      {/* Agent Source Form Modal */}
      {showAgentForm && (
        <AgentSourceForm
          onSave={handleSaveAgentSource}
          onClose={() => {
            setEditingSource(undefined);
            closeAgentForm();
          }}
          existingSource={editingSource}
        />
      )}
    </div>
  );
};
