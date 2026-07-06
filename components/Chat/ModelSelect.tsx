import { IconBrain, IconX } from '@tabler/icons-react';
import { useFlags } from 'launchdarkly-react-client-sdk';
import React, { FC, useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { useConversations } from '@/client/hooks/conversation/useConversations';
import { useFoundryAgents } from '@/client/hooks/settings/useFoundryAgents';
import { useModelOrder } from '@/client/hooks/settings/useModelOrder';
import { useModelSelectState } from '@/client/hooks/settings/useModelSelectState';
import { useSettings } from '@/client/hooks/settings/useSettings';

import { shortSourceHash } from '@/lib/utils/app/agentId';
import { seriesRepresentative, versionRank } from '@/lib/utils/app/modelSeries';

import { Conversation } from '@/types/chat';
import {
  OpenAIModel,
  OpenAIModelID,
  OpenAIModels,
  getModelHosting,
  getModelTier,
} from '@/types/openai';
import { SearchMode } from '@/types/searchMode';

import { AzureAIIcon, AzureOpenAIIcon } from '../Icons/providers';
import { ConfirmDialog } from '../UI/ConfirmDialog';
import { TabNavigation } from '../UI/TabNavigation';
import { AgentSourceForm } from './AgentSources/AgentSourceForm';
import { ModelCard } from './ModelCard';
import { AgentsTab } from './ModelSelect/AgentsTab';
import { HiddenItemsSection } from './ModelSelect/HiddenItemsSection';
import { ModelDetailsPanel } from './ModelSelect/ModelDetailsPanel';
import {
  FAMILY_LABEL,
  FAMILY_ORDER,
  ModelFamily,
  ModelFamilyFilter,
} from './ModelSelect/ModelFamilyFilter';
import { ModelOrderControls } from './ModelSelect/ModelOrderControls';
import { ModelProviderIcon } from './ModelSelect/ModelProviderIcon';
import { ModelStatusBadge } from './ModelSelect/ModelStatusBadge';

import { AgentSource, useSettingsStore } from '@/client/stores/settingsStore';
import {
  getOrganizationAgentIdFromModelId,
  getOrganizationAgents,
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
  const {
    foundryAgents,
    regionalPath,
    officePaths,
    isLoadingFoundryAgents,
    refetchFoundryAgents,
  } = useFoundryAgents();

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

  // Hidden models/agents — one list keyed by model ID covers both.
  const hiddenModelIds = useSettingsStore((s) => s.hiddenModelIds);
  const hideModel = useSettingsStore((s) => s.hideModel);
  const unhideModel = useSettingsStore((s) => s.unhideModel);
  const hiddenSet = useMemo(() => new Set(hiddenModelIds), [hiddenModelIds]);
  // Pending hide awaiting confirmation (null = dialog closed).
  const [hideTarget, setHideTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);

  // View-only filter narrowing the catalog to a single provider family.
  // 'all' (default) shows every family.
  const [familyFilter, setFamilyFilter] = useState<ModelFamily>('all');

  // Stars + dismissed default favorites drive the Favorites section;
  // userRegion drives the region badges/notes (EU users only see EU-hosted
  // models via discovery; US users can chat cross-region).
  const starredModelIds = useSettingsStore((s) => s.starredModelIds);
  const starModel = useSettingsStore((s) => s.starModel);
  const unstarModel = useSettingsStore((s) => s.unstarModel);
  const userRegion = useSettingsStore((s) => s.userRegion);
  const starredSet = useMemo(() => new Set(starredModelIds), [starredModelIds]);

  const [modelSearch, setModelSearch] = useState('');

  const requestHide = useCallback((id: string, name: string) => {
    setHideTarget({ id, name });
  }, []);

  const confirmHide = useCallback(() => {
    if (!hideTarget) return;
    const { id, name } = hideTarget;
    hideModel(id);
    setHideTarget(null);

    // Undo toast — mirrors the disconnect-source pattern below.
    toast(
      (toastInstance) => (
        <div className="flex items-center gap-3">
          <span>{t('modelSelect.hiddenToast', { name })}</span>
          <button
            onClick={() => {
              unhideModel(id);
              toast.dismiss(toastInstance.id);
            }}
            className="text-sm font-semibold text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300"
          >
            {t('common.undo')}
          </button>
        </div>
      ),
      { duration: 8000 },
    );
  }, [hideTarget, hideModel, unhideModel, t]);

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
    // The `exploreBots` flag gates org-managed discovery (static org agents +
    // region/office Foundry projects) — NOT the user's own connected sources.
    // When the flag is off we still keep agents from custom (BYO) sources so
    // users can use Foundry projects they connected themselves.
    const customSourcePaths = new Set(
      customAgentSources.map((s) => s.resourcePath),
    );
    const visibleFoundryAgents = isBotsEnabled
      ? foundryAgents
      : foundryAgents.filter(
          (a) => a.source && customSourcePaths.has(a.source),
        );

    // Static agents from organization-agents.json (RAG agents + any static
    // Foundry agents) are org-managed, so they're skipped when the flag is off.
    const staticAgents = isBotsEnabled ? getOrganizationAgents() : [];
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

    // Dynamically discovered Foundry agents from ARM API (RBAC-filtered per user).
    // Model ID includes a short hash of the source path so the same-named agent
    // discovered from two different Foundry projects produces two distinct models
    // (otherwise React key collisions + ambiguous selection).
    const dynamicModels = visibleFoundryAgents.map((agent) => {
      const baseModel = OpenAIModels[OpenAIModelID.GPT_4_1];
      const sourceHash = shortSourceHash(agent.source);
      return {
        ...baseModel,
        id: `foundry-${sourceHash}-${agent.id}`,
        name: agent.name,
        description: agent.description,
        modelType: 'agent' as const,
        agentId: agent.agentName,
        agentVersion: agent.agentVersion,
        foundryEndpoint: agent.foundryEndpoint,
        agentSource: agent.source,
        isOrganizationAgent: true,
      };
    });

    // Deduplicate: if a Foundry agent exists in both static config and dynamic discovery,
    // prefer the dynamic version (it has RBAC validation)
    const dynamicAgentNames = new Set(
      visibleFoundryAgents.map((a) => a.agentName),
    );
    const deduplicatedStatic = staticModels.filter(
      (m) => !m.agentId || !dynamicAgentNames.has(m.agentId),
    );

    return [...deduplicatedStatic, ...dynamicModels];
  }, [isBotsEnabled, foundryAgents, customAgentSources]);

  // Combine base models and organization/discovered agents
  const availableModels = useMemo(
    () => [...baseModels, ...organizationAgentModels],
    [baseModels, organizationAgentModels],
  );

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
      const source = customAgentSources.find((s) => s.id === sourceId);
      if (!source) return;

      // Disconnecting only removes the source registration; existing
      // conversations keep their agent model intact (history, topbar label,
      // metadata). If the user later tries to send in one of those, the
      // request surfaces a clear "agent unavailable" error from the server
      // and they can pick a new model from the picker. Silently rewriting
      // the model to GPT-5.2 made the topbar lie about who answered.
      deleteCustomAgentSource(sourceId);

      // Show undo toast — restore the source if user changes their mind
      toast(
        (toastInstance) => (
          <div className="flex items-center gap-3">
            <span>
              {t('agentsTab.agentSources.disconnectedToast', {
                name: source.name,
              })}
            </span>
            <button
              onClick={() => {
                addCustomAgentSource(source);
                toast.dismiss(toastInstance.id);
              }}
              className="text-sm font-semibold text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300"
            >
              {t('common.undo')}
            </button>
          </div>
        ),
        { duration: 8000 },
      );
    },
    [deleteCustomAgentSource, addCustomAgentSource, customAgentSources, t],
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
              <div>
                {(() => {
                  // Hidden models drop out of the main list and resurface in
                  // the collapsible "Hidden" group below.
                  const visibleModels = orderedModels.filter(
                    (m) => !hiddenSet.has(m.id),
                  );
                  const hiddenModels = orderedModels.filter((m) =>
                    hiddenSet.has(m.id),
                  );

                  // Static metadata when known; discovered/unknown models
                  // carry their own fields.
                  const providerOf = (m: OpenAIModel) =>
                    OpenAIModels[m.id as OpenAIModelID]?.provider ?? m.provider;
                  const metaOf = (m: OpenAIModel) =>
                    OpenAIModels[m.id as OpenAIModelID] ?? m;

                  const toggleStar = (model: OpenAIModel) =>
                    starredSet.has(model.id)
                      ? unstarModel(model.id)
                      : starModel(model.id);

                  // Informational badges: hosting region (US users, models
                  // with no US instance — still selectable, chat routes to
                  // the hosting region) and external hosting.
                  const badgeFor = (model: OpenAIModel) => {
                    const isExternal =
                      getModelHosting(metaOf(model)) === 'external';
                    const foreignOnly =
                      userRegion === 'US' &&
                      !!model.hostedIn?.length &&
                      !model.hostedIn.includes('US');
                    const isReasoning = metaOf(model).modelType === 'reasoning';
                    if (!isExternal && !foreignOnly && !isReasoning) {
                      return undefined;
                    }
                    return (
                      <>
                        {isReasoning && (
                          <span
                            title={t('modelSelect.reasoningModel')}
                            aria-label={t('modelSelect.reasoningModel')}
                            className="shrink-0 inline-flex text-gray-500 dark:text-gray-400 cursor-help"
                          >
                            <IconBrain size={14} aria-hidden="true" />
                          </span>
                        )}
                        {foreignOnly && (
                          <ModelStatusBadge
                            // Region codes are proper nouns, not translated.
                            label={(model.hostedIn ?? []).join(' & ')}
                            tooltip={t(
                              'modelSelect.badges.regionHostedTooltip',
                              { region: (model.hostedIn ?? []).join(' & ') },
                            )}
                          />
                        )}
                        {isExternal && (
                          <ModelStatusBadge
                            label={t('modelSelect.badges.external')}
                            tooltip={t('modelSelect.badges.externalTooltip')}
                          />
                        )}
                      </>
                    );
                  };

                  const recommendedPill = (
                    <span className="shrink-0 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-800 dark:bg-blue-500/15 dark:text-blue-300">
                      {t('modelSelect.recommended')}
                    </span>
                  );

                  const sectionHeading = (label: string) => (
                    <h4 className="text-[11px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
                      {label}
                    </h4>
                  );

                  const renderModelCard = (
                    model: OpenAIModel,
                    opts?: { name?: string; versionTag?: string },
                  ) => {
                    const isStarred = starredSet.has(model.id);
                    const isFeatured =
                      getModelTier(metaOf(model)) === 'featured';
                    const infoBadge = badgeFor(model);
                    const badge =
                      opts?.versionTag || isFeatured || infoBadge ? (
                        <>
                          {opts?.versionTag && (
                            <ModelStatusBadge
                              label={opts.versionTag}
                              tooltip={model.name}
                            />
                          )}
                          {isFeatured && recommendedPill}
                          {infoBadge}
                        </>
                      ) : undefined;
                    return (
                      <ModelCard
                        key={model.id}
                        id={model.id}
                        name={opts?.name ?? model.name}
                        tagline={metaOf(model)?.tagline}
                        badge={badge}
                        isSelected={selectedModelId === model.id}
                        onClick={() => handleModelSelect(model)}
                        icon={
                          <ModelProviderIcon provider={providerOf(model)} />
                        }
                        showReorderControls={isEditingOrder}
                        canMoveUp={canMoveUp(model.id)}
                        canMoveDown={canMoveDown(model.id)}
                        onMoveUp={() => moveModel(model.id, 'up')}
                        onMoveDown={() => moveModel(model.id, 'down')}
                        starred={isStarred}
                        onToggleStar={
                          isEditingOrder ? undefined : () => toggleStar(model)
                        }
                        starLabel={
                          isStarred
                            ? t('modelSelect.unstar', { name: model.name })
                            : t('modelSelect.star', { name: model.name })
                        }
                        onHide={
                          isEditingOrder
                            ? undefined
                            : () => requestHide(model.id, model.name)
                        }
                        hideLabel={t('modelSelect.hide')}
                      />
                    );
                  };

                  // ── Favorites: user-starred models ONLY, in star order.
                  // The section doesn't exist until the user stars something;
                  // recommended defaults carry an inline pill in the tree
                  // instead of occupying a section.
                  const favorites = starredModelIds
                    .map((id) => visibleModels.find((m) => m.id === id))
                    .filter((m): m is OpenAIModel => !!m);
                  const renderFavoriteCard = (model: OpenAIModel) => {
                    const infoBadge = badgeFor(model);
                    return (
                      <ModelCard
                        key={`fav-${model.id}`}
                        id={model.id}
                        name={model.name}
                        tagline={metaOf(model)?.tagline}
                        badge={infoBadge}
                        isSelected={selectedModelId === model.id}
                        onClick={() => handleModelSelect(model)}
                        icon={
                          <ModelProviderIcon provider={providerOf(model)} />
                        }
                        starred
                        onToggleStar={() => unstarModel(model.id)}
                        starLabel={t('modelSelect.unstar', {
                          name: model.name,
                        })}
                        onHide={() => requestHide(model.id, model.name)}
                        hideLabel={t('modelSelect.hide')}
                      />
                    );
                  };

                  // Search spans ALL visible models.
                  const query = modelSearch.trim().toLowerCase();
                  const searchResults = query
                    ? visibleModels.filter((m) => {
                        const family = providerOf(m);
                        return (
                          m.name.toLowerCase().includes(query) ||
                          m.id.toLowerCase().includes(query) ||
                          (family &&
                            FAMILY_LABEL[family].toLowerCase().includes(query))
                        );
                      })
                    : null;

                  // ── Family tree: family → type → series → version chips,
                  // always visible (nothing collapses whole families).
                  const treeModels =
                    familyFilter === 'all'
                      ? visibleModels
                      : visibleModels.filter(
                          (m) => providerOf(m) === familyFilter,
                        );
                  const availableFamilies = FAMILY_ORDER.filter((f) =>
                    visibleModels.some((m) => providerOf(m) === f),
                  );

                  // Series rows + plain rows, preserving list order (first
                  // member encountered anchors its series' position).
                  const renderTypeBlock = (models: OpenAIModel[]) => {
                    const seriesGroups = new Map<string, OpenAIModel[]>();
                    const units: Array<{ key: string; seriesKey?: string }> =
                      [];
                    for (const m of models) {
                      const seriesKey = metaOf(m).series;
                      if (seriesKey) {
                        if (!seriesGroups.has(seriesKey)) {
                          seriesGroups.set(seriesKey, []);
                          units.push({
                            key: `series-${seriesKey}`,
                            seriesKey,
                          });
                        }
                        seriesGroups.get(seriesKey)!.push(m);
                      } else {
                        units.push({ key: m.id });
                      }
                    }
                    const byId = new Map(models.map((m) => [m.id, m]));
                    return (
                      <div className="space-y-1">
                        {units.map((unit) => {
                          if (!unit.seriesKey) {
                            return renderModelCard(byId.get(unit.key)!);
                          }
                          const versions = [
                            ...seriesGroups.get(unit.seriesKey)!,
                          ].sort((a, b) => versionRank(b) - versionRank(a));
                          if (versions.length === 1) {
                            return renderModelCard(versions[0]);
                          }
                          // One quiet row per series: the representative
                          // version fronts it with an inline version tag;
                          // switching versions lives in the details panel.
                          const rep = seriesRepresentative(
                            versions,
                            selectedModelId,
                          )!;
                          return renderModelCard(rep, {
                            name: rep.seriesLabel ?? rep.name,
                            versionTag: rep.versionLabel,
                          });
                        })}
                      </div>
                    );
                  };

                  // No Reasoning/General sub-headers: with tunable reasoning
                  // on newer models the split is an anachronism, and it cost
                  // two lines per family. Dedicated reasoning models carry a
                  // quiet brain icon instead (see badgeFor).
                  const renderFamilySection = (
                    key: string,
                    label: string,
                    models: OpenAIModel[],
                  ) => (
                    <div key={key} className="mb-3 last:mb-0">
                      <h5 className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
                        {label} ({models.length})
                      </h5>
                      {renderTypeBlock(models)}
                    </div>
                  );

                  const leftover =
                    familyFilter === 'all'
                      ? treeModels.filter((m) => {
                          const family = providerOf(m);
                          return !family || !FAMILY_LABEL[family];
                        })
                      : [];

                  return (
                    <div>
                      <input
                        type="search"
                        value={modelSearch}
                        onChange={(e) => setModelSearch(e.target.value)}
                        placeholder={t('modelSelect.searchPlaceholder')}
                        aria-label={t('modelSelect.searchPlaceholder')}
                        className="w-full mb-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-inkwell-panel px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-500 focus:border-blue-600 focus:outline-none"
                      />
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        {userRegion === 'EU' ? (
                          // Affirmative residency framing for EU users — all
                          // their models run in the EU (discovery guarantees
                          // it; the server also pins their chat to EU).
                          <p className="text-[10px] text-gray-500 dark:text-gray-400">
                            {t('modelSelect.euResidencyNote')}
                          </p>
                        ) : (
                          <span />
                        )}
                        <ModelOrderControls
                          orderMode={orderMode}
                          onOrderModeChange={setOrderMode}
                          onReset={resetOrder}
                          isEditing={isEditingOrder}
                          onToggleEdit={handleToggleEditOrder}
                        />
                      </div>
                      {isEditingOrder ? (
                        // Reordering flattens everything into one list —
                        // sections and series rows would fight the manual
                        // order.
                        <div className="space-y-1">
                          {visibleModels.map((m) => renderModelCard(m))}
                        </div>
                      ) : searchResults ? (
                        searchResults.length > 0 ? (
                          <div className="space-y-1">
                            {searchResults.map((m) => renderModelCard(m))}
                          </div>
                        ) : (
                          <p className="px-1 py-2 text-sm text-gray-500 dark:text-gray-400">
                            {t('modelSelect.searchEmpty')}
                          </p>
                        )
                      ) : (
                        <>
                          {favorites.length > 0 && (
                            <div className="mb-3">
                              {sectionHeading(t('modelSelect.favorites'))}
                              <div className="space-y-1">
                                {favorites.map(renderFavoriteCard)}
                              </div>
                            </div>
                          )}
                          {availableFamilies.length >= 2 && (
                            <ModelFamilyFilter
                              families={availableFamilies}
                              value={familyFilter}
                              onChange={setFamilyFilter}
                            />
                          )}
                          {availableFamilies.map((family) => {
                            const group = treeModels.filter(
                              (m) => providerOf(m) === family,
                            );
                            if (group.length === 0) return null;
                            return renderFamilySection(
                              family,
                              FAMILY_LABEL[family],
                              group,
                            );
                          })}
                          {leftover.length > 0 &&
                            renderFamilySection(
                              'other',
                              t('modelSelect.otherFamily'),
                              leftover,
                            )}
                        </>
                      )}
                      <HiddenItemsSection
                        items={hiddenModels.map((m) => ({
                          id: m.id,
                          name: m.name,
                          icon: <ModelProviderIcon provider={providerOf(m)} />,
                        }))}
                        onRestore={unhideModel}
                      />
                    </div>
                  );
                })()}
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
                  onSelectVersion={handleModelSelect}
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
          regionalPath={regionalPath}
          officePaths={officePaths}
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
          hiddenIds={hiddenSet}
          onHideAgent={requestHide}
          onUnhideAgent={unhideModel}
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

      {/* Hide confirmation — destructive styling, reversible copy.
          z-[200] stacks it above the model-select modal (z-[150]) it opens
          from; without this the Modal default (z-50) renders behind it. */}
      <ConfirmDialog
        isOpen={hideTarget !== null}
        title={t('modelSelect.hideConfirmTitle', {
          name: hideTarget?.name ?? '',
        })}
        message={t('modelSelect.hideConfirmMessage')}
        confirmLabel={t('modelSelect.hideConfirm')}
        cancelLabel={t('common.cancel')}
        confirmVariant="danger"
        className="z-[200]"
        onConfirm={confirmHide}
        onCancel={() => setHideTarget(null)}
      />
    </div>
  );
};
