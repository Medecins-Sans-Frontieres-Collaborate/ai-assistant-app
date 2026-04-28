import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconHexagon,
  IconPlug,
  IconPlugConnectedX,
  IconRefresh,
} from '@tabler/icons-react';
import { useFlags } from 'launchdarkly-react-client-sdk';
import { useSession } from 'next-auth/react';
import React, { FC, useState } from 'react';

import { useTranslations } from 'next-intl';

import { DiscoveredAgent } from '@/lib/services/agents/AgentDiscoveryService';

import { colorForAgent } from '@/lib/utils/app/agentColor';
import { shortSourceHash } from '@/lib/utils/app/agentId';

import { Conversation } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';

import { OrganizationAgentList } from '../OrganizationAgents/OrganizationAgentList';
import { ModelDetailsPanel } from './ModelDetailsPanel';

import { AgentSource } from '@/client/stores/settingsStore';
import { getOrganizationAgents } from '@/lib/organizationAgents';

interface AgentsTabProps {
  handleModelSelect: (model: OpenAIModel) => void;
  organizationAgentModels: OpenAIModel[];
  foundryAgents: DiscoveredAgent[];
  /** Resource path for the user's regional default Foundry project (US or EU). */
  regionalPath: string | null;
  /** Office-specific Foundry project paths beyond the regional default. */
  officePaths: string[];
  selectedModelId: string | null | undefined;
  isLoadingFoundryAgents?: boolean;
  onRefreshAgents: () => void;
  // Agent sources
  agentSources: AgentSource[];
  onAddSource: () => void;
  onEditSource?: (source: AgentSource) => void;
  onDeleteSource: (id: string) => void;
  // Props for details panel
  selectedModel: OpenAIModel | undefined;
  modelConfig: OpenAIModel | null | undefined;
  isCustomAgent: boolean;
  searchModeEnabled: boolean;
  displaySearchMode: SearchMode;
  agentAvailable: boolean;
  showModelAdvanced: boolean;
  selectedConversation: Conversation | null;
  mobileView: 'list' | 'details';
  setMobileView: (view: 'list' | 'details') => void;
  handleToggleSearchMode: () => void;
  handleSetSearchMode: (mode: SearchMode) => void;
  setShowModelAdvanced: (show: boolean) => void;
  updateConversation: (id: string, updates: Partial<Conversation>) => void;
}

export const AgentsTab: FC<AgentsTabProps> = ({
  handleModelSelect,
  organizationAgentModels,
  foundryAgents,
  regionalPath,
  officePaths,
  selectedModelId,
  isLoadingFoundryAgents,
  onRefreshAgents,
  agentSources,
  onAddSource,
  onEditSource,
  onDeleteSource,
  // Details panel props
  selectedModel,
  modelConfig,
  isCustomAgent,
  searchModeEnabled,
  displaySearchMode,
  agentAvailable,
  showModelAdvanced,
  selectedConversation,
  mobileView,
  setMobileView,
  handleToggleSearchMode,
  handleSetSearchMode,
  setShowModelAdvanced,
  updateConversation,
}) => {
  const t = useTranslations('agentsTab');
  const { exploreBots } = useFlags();
  const { data: session } = useSession();

  const organizationAgents = getOrganizationAgents();
  const isBotsEnabled = exploreBots !== false;
  const hasOrganizationAgents = isBotsEnabled && organizationAgents.length > 0;

  // Region/office labels. Office name is user-defined config (place name), so it
  // isn't translated; the rest is.
  const officeName = session?.user?.officeName;
  const region = session?.user?.region;
  const regionLabel =
    region === 'US'
      ? t('regionAgents.us')
      : region === 'EU'
        ? t('regionAgents.eu')
        : t('regionAgents.default');

  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
    null,
  );
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [showSourceTechnicalDetails, setShowSourceTechnicalDetails] =
    useState(false);
  const selectedSource = agentSources.find((s) => s.id === selectedSourceId);

  // Bucket discovered agents by source: regional (org default), office (extra
  // office-scoped projects), and custom (user-added connections, rendered per-source below).
  const officePathSet = new Set(officePaths);
  const regionalAgents = foundryAgents.filter(
    (a) => !a.source || a.source === regionalPath,
  );
  const officeFoundryAgents = foundryAgents.filter(
    (a) => a.source && officePathSet.has(a.source),
  );
  const getSourceAgents = (sourcePath: string) =>
    foundryAgents.filter((a) => a.source === sourcePath);
  const hasOfficeSection = officeName != null && officeFoundryAgents.length > 0;

  // Stable model ID for a discovered Foundry agent — matches what ModelSelect
  // builds when constructing organizationAgentModels. Includes a source hash so
  // same-named agents from different projects don't collide.
  const foundryModelId = (a: DiscoveredAgent) =>
    `foundry-${shortSourceHash(a.source)}-${a.id}`;

  const isAgentSelected =
    selectedModelId?.startsWith('org-') ||
    selectedModelId?.startsWith('foundry-') ||
    selectedModelId?.startsWith('custom-');

  const selectedStaticOrgAgent = selectedModelId?.startsWith('org-')
    ? organizationAgents.find((a) => `org-${a.id}` === selectedModelId)
    : undefined;

  // For Foundry-discovered agents, synthesize a minimal OrganizationAgent so the
  // details header renders the same hexagon + matte color shown in the list,
  // instead of falling back to the generic provider icon.
  const selectedFoundryAgent =
    !selectedStaticOrgAgent && selectedModelId?.startsWith('foundry-')
      ? foundryAgents.find((a) => foundryModelId(a) === selectedModelId)
      : undefined;
  const selectedOrgAgent = selectedStaticOrgAgent
    ? selectedStaticOrgAgent
    : selectedFoundryAgent
      ? {
          id: selectedFoundryAgent.id,
          name: selectedFoundryAgent.name,
          description: selectedFoundryAgent.description ?? '',
          icon: selectedFoundryAgent.icon || 'IconHexagon',
          color:
            selectedFoundryAgent.color ||
            colorForAgent(selectedFoundryAgent.name),
          type: 'foundry' as const,
          agentId: selectedFoundryAgent.agentName,
        }
      : undefined;

  const handleDeleteWithConfirm = (id: string) => {
    if (confirmingDeleteId === id) {
      onDeleteSource(id);
      setConfirmingDeleteId(null);
    } else {
      setConfirmingDeleteId(id);
      // Auto-reset after 3 seconds
      setTimeout(() => setConfirmingDeleteId(null), 3000);
    }
  };

  return (
    <div
      className="flex-1 flex flex-col overflow-hidden animate-fade-in-fast"
      key="agents-tab"
    >
      <div className="flex-1 flex flex-col md:flex-row gap-4 md:gap-6 overflow-hidden p-4 md:p-0">
        {/* Left: Agent List */}
        <div
          className={`${
            mobileView === 'details' ? 'hidden md:block' : 'block'
          } w-full md:w-80 flex-shrink-0 overflow-y-auto md:border-e border-gray-200 dark:border-gray-700 md:pe-4`}
        >
          {/* Region Agents — primary section */}
          {hasOrganizationAgents && (
            <section>
              <div className="flex items-center justify-between mb-1.5">
                <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">
                  {regionLabel}
                </h4>
                <button
                  onClick={onRefreshAgents}
                  disabled={isLoadingFoundryAgents}
                  className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-50 transition-colors"
                  title={t('agentSources.refreshAgents')}
                >
                  <IconRefresh
                    size={14}
                    className={isLoadingFoundryAgents ? 'animate-spin' : ''}
                  />
                </button>
              </div>
              <OrganizationAgentList
                onSelect={(agent) => {
                  // Static org agents use `org-{id}`; foundry display agents
                  // carry a precomputed `matchId` from the parent.
                  const matchId =
                    'matchId' in agent && agent.matchId
                      ? agent.matchId
                      : `org-${agent.id}`;
                  const agentModel = organizationAgentModels.find(
                    (m) => m.id === matchId,
                  );
                  if (agentModel) {
                    handleModelSelect(agentModel);
                    setMobileView('details');
                  }
                }}
                selectedAgentId={selectedModelId ?? undefined}
                discoveredAgents={regionalAgents.map((a) => ({
                  id: a.id,
                  name: a.name,
                  description: a.description,
                  icon: a.icon,
                  color: a.color,
                  matchId: foundryModelId(a),
                }))}
              />
              {isLoadingFoundryAgents && (
                <div className="space-y-1 mt-1">
                  {[1, 2].map((i) => (
                    <div
                      key={i}
                      className="animate-pulse flex items-center gap-3 px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-800"
                    >
                      <div className="w-6 h-6 rounded bg-gray-200 dark:bg-gray-700" />
                      <div className="flex-1">
                        <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded w-3/4" />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* Office Agents — only shown if user belongs to an office with extra projects */}
          {hasOfficeSection && (
            <section className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
              <div className="flex items-center mb-1.5">
                <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">
                  {officeName} {t('officeAgents.suffix')}
                </h4>
              </div>
              <div className="space-y-1">
                {officeFoundryAgents.map((agent) => {
                  const modelId = foundryModelId(agent);
                  const agentModel = organizationAgentModels.find(
                    (m) => m.id === modelId,
                  );
                  const isSelected = selectedModelId === modelId;
                  return (
                    <button
                      key={modelId}
                      type="button"
                      onClick={() => {
                        if (agentModel) {
                          handleModelSelect(agentModel);
                          setMobileView('details');
                        }
                      }}
                      className={`w-full text-left px-3 py-2 rounded-lg transition-all duration-150 flex items-center justify-between gap-2 ${
                        isSelected
                          ? 'bg-blue-50 dark:bg-blue-900/20 border-2 border-blue-300 dark:border-blue-600'
                          : 'bg-white dark:bg-surface-dark border-2 border-transparent hover:border-gray-200 dark:hover:border-gray-700'
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <IconHexagon
                          size={18}
                          className="shrink-0"
                          style={{ color: colorForAgent(agent.name) }}
                        />
                        <span className="font-medium text-sm text-gray-900 dark:text-white">
                          {agent.name}
                        </span>
                      </div>
                      {isSelected && (
                        <IconCheck
                          size={16}
                          className="text-blue-600 dark:text-blue-400 shrink-0"
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* Custom source sections — each gets a header like BASE AGENTS */}
          {agentSources.map((source) => {
            const sourceAgents = getSourceAgents(source.resourcePath);
            const countLabel = isLoadingFoundryAgents
              ? '...'
              : `${sourceAgents.length}`;
            const countColor = isLoadingFoundryAgents
              ? 'text-gray-400 dark:text-gray-500'
              : sourceAgents.length > 0
                ? 'text-green-600 dark:text-green-400'
                : 'text-gray-400 dark:text-gray-500';
            return (
              <section
                key={source.id}
                className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700"
              >
                <div className="flex items-center mb-1.5">
                  <button
                    onClick={() => setSelectedSourceId(source.id)}
                    className="group flex items-center gap-1.5 -mx-1 px-1 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                    title={
                      t('agentSources.viewConnection') || 'View connection'
                    }
                  >
                    <IconPlug
                      size={12}
                      className="text-gray-400 dark:text-gray-500 group-hover:text-gray-600 dark:group-hover:text-gray-300 transition-colors"
                      aria-hidden="true"
                    />
                    <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase group-hover:text-gray-700 dark:group-hover:text-gray-200 transition-colors">
                      {source.name}
                    </span>
                    <span
                      className={`text-xs font-semibold tabular-nums ${countColor}`}
                      aria-label={`${sourceAgents.length} agents`}
                    >
                      ({countLabel})
                    </span>
                    <IconChevronRight
                      size={12}
                      className="text-gray-400 dark:text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity"
                      aria-hidden="true"
                    />
                  </button>
                </div>
                {isLoadingFoundryAgents ? (
                  <div className="space-y-1">
                    {[1, 2].map((i) => (
                      <div
                        key={i}
                        className="animate-pulse flex items-center gap-3 px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-800"
                      >
                        <div className="w-4 h-4 rounded bg-gray-200 dark:bg-gray-700" />
                        <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded w-3/4" />
                      </div>
                    ))}
                  </div>
                ) : sourceAgents.length > 0 ? (
                  <div className="space-y-1">
                    {sourceAgents.map((agent) => {
                      const modelId = foundryModelId(agent);
                      const agentModel = organizationAgentModels.find(
                        (m) => m.id === modelId,
                      );
                      const isSelected = selectedModelId === modelId;
                      return (
                        <button
                          key={modelId}
                          type="button"
                          onClick={() => {
                            if (agentModel) {
                              handleModelSelect(agentModel);
                              setSelectedSourceId(null);
                              setMobileView('details');
                            }
                          }}
                          className={`w-full text-left px-3 py-2 rounded-lg transition-all duration-150 flex items-center justify-between gap-2 ${
                            isSelected
                              ? 'bg-blue-50 dark:bg-blue-900/20 border-2 border-blue-300 dark:border-blue-600'
                              : 'bg-white dark:bg-surface-dark border-2 border-transparent hover:border-gray-200 dark:hover:border-gray-700'
                          }`}
                        >
                          <div className="flex items-center gap-2.5">
                            <IconHexagon
                              size={18}
                              className="shrink-0"
                              style={{ color: colorForAgent(agent.name) }}
                            />
                            <span className="font-medium text-sm text-gray-900 dark:text-white">
                              {agent.name}
                            </span>
                          </div>
                          {isSelected && (
                            <IconCheck
                              size={16}
                              className="text-blue-600 dark:text-blue-400 shrink-0"
                            />
                          )}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-xs text-gray-400 dark:text-gray-500 italic px-1">
                    {t('agentSources.noAgentsPublished')}
                  </p>
                )}
              </section>
            );
          })}

          {/* Connect button */}
          <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
            <button
              onClick={onAddSource}
              className="inline-flex items-center gap-1.5 text-sm text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors whitespace-nowrap"
            >
              <IconPlug size={16} className="shrink-0" />
              <span>
                {agentSources.length === 0
                  ? t('agentSources.connectButtonShort') ||
                    'Connect a Foundry project'
                  : t('agentSources.addAnother') || 'Add another connection'}
              </span>
            </button>
          </div>
        </div>

        {/* Right: Agent Details or Connection Details */}
        <div
          className={`${
            mobileView === 'list' ? 'hidden md:block' : 'block'
          } flex-1 overflow-y-auto`}
        >
          {/* Connection details view */}
          {selectedSource &&
            (() => {
              const parts = selectedSource.resourcePath.split('/');
              const subIdx = parts.indexOf('subscriptions');
              const rgIdx = parts.indexOf('resourceGroups');
              const accountIdx = parts.indexOf('accounts');
              const projectIdx = parts.indexOf('projects');
              const subscription = subIdx >= 0 ? parts[subIdx + 1] : '—';
              const resourceGroup = rgIdx >= 0 ? parts[rgIdx + 1] : '—';
              const account = accountIdx >= 0 ? parts[accountIdx + 1] : '—';
              const project =
                projectIdx >= 0 ? parts[projectIdx + 1] : 'default';
              const sourceAgents = foundryAgents.filter(
                (a) => a.source === selectedSource.resourcePath,
              );
              const isConfirming = confirmingDeleteId === selectedSource.id;
              const connectedDate = new Date(selectedSource.createdAt);
              const connectedLabel = connectedDate.toISOString().split('T')[0];

              return (
                <div className="p-1">
                  {/* Header */}
                  <div className="flex items-start justify-between mb-1">
                    <div>
                      <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                        {selectedSource.name}
                      </h3>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        <span className="font-mono">
                          {account}
                          {project !== 'default' ? ` / ${project}` : ''}
                        </span>
                        <span className="mx-1.5 text-gray-400 dark:text-gray-500">
                          •
                        </span>
                        <span title={connectedDate.toLocaleString()}>
                          {t('agentSources.connectedOn', {
                            date: connectedLabel,
                          })}
                        </span>
                      </p>
                    </div>
                    <button
                      onClick={() => onEditSource?.(selectedSource)}
                      className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 px-2 py-1 rounded-md hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                    >
                      {t('agentSources.edit')}
                    </button>
                  </div>

                  {/* Discovered Agents — primary content */}
                  <div className="mt-5">
                    <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase mb-2">
                      {t('agentSources.discoveredAgents') ||
                        'Discovered Agents'}{' '}
                      <span className="tabular-nums">
                        ({sourceAgents.length})
                      </span>
                    </h4>
                    {sourceAgents.length > 0 ? (
                      <div className="space-y-1">
                        {sourceAgents.map((agent) => (
                          <div
                            key={agent.id}
                            className="flex items-start gap-2.5 rounded-lg px-3 py-2 bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700"
                          >
                            <IconHexagon
                              size={16}
                              className="shrink-0 mt-0.5"
                              style={{ color: colorForAgent(agent.name) }}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-medium text-gray-900 dark:text-white">
                                {agent.name}
                              </div>
                              {agent.description && (
                                <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-2">
                                  {agent.description}
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-lg border border-dashed border-gray-300 dark:border-gray-700 px-4 py-5 text-center">
                        <p className="text-sm text-gray-600 dark:text-gray-300 leading-tight">
                          {isLoadingFoundryAgents
                            ? t('agentSources.loadingAgents')
                            : t('agentSources.noAgentsFound')}
                        </p>
                        {!isLoadingFoundryAgents && (
                          <>
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1.5 leading-snug">
                              {t('agentSources.noAgentsFoundHint')}
                            </p>
                            <button
                              onClick={onRefreshAgents}
                              className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
                            >
                              <IconRefresh size={12} />
                              {t('agentSources.refresh')}
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Technical details — collapsible */}
                  <div className="mt-5 border-t border-gray-200 dark:border-gray-700 pt-3">
                    <button
                      onClick={() =>
                        setShowSourceTechnicalDetails(
                          !showSourceTechnicalDetails,
                        )
                      }
                      className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
                    >
                      {showSourceTechnicalDetails ? (
                        <IconChevronDown size={12} />
                      ) : (
                        <IconChevronRight size={12} />
                      )}
                      <span>Technical details</span>
                    </button>
                    {showSourceTechnicalDetails && (
                      <div className="mt-2 rounded-lg bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 p-3 text-xs space-y-2">
                        {[
                          ['Account', account],
                          ['Project', project],
                          ['Resource Group', resourceGroup],
                          ['Subscription', subscription],
                        ].map(([label, value]) => (
                          <div key={label}>
                            <div className="text-gray-500 dark:text-gray-400">
                              {label}
                            </div>
                            <div
                              className="text-gray-800 dark:text-gray-200 font-mono truncate"
                              title={value}
                            >
                              {value}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Disconnect — louder, with icon and red text */}
                  <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
                    <button
                      onClick={() => {
                        handleDeleteWithConfirm(selectedSource.id);
                        if (isConfirming) {
                          setSelectedSourceId(null);
                        }
                      }}
                      className={`inline-flex items-center gap-1.5 text-sm font-medium transition-colors ${
                        isConfirming
                          ? 'text-red-700 dark:text-red-300'
                          : 'text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300'
                      }`}
                    >
                      <IconPlugConnectedX size={16} />
                      <span>
                        {isConfirming
                          ? t('agentSources.confirmDisconnect')
                          : t('agentSources.disconnectSource')}
                      </span>
                    </button>
                  </div>
                </div>
              );
            })()}

          {/* Agent details view */}
          {!selectedSource &&
            isAgentSelected &&
            selectedModel &&
            (modelConfig || isCustomAgent || selectedOrgAgent) && (
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
                organizationAgent={selectedOrgAgent}
              />
            )}
          {!selectedSource && !isAgentSelected && (
            <div className="h-full flex items-center justify-center text-gray-500 dark:text-gray-400">
              <p className="text-sm">{t('selectAgentPrompt')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
