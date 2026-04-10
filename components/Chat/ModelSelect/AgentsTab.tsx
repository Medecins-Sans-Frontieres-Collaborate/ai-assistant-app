import {
  IconCheck,
  IconHexagon,
  IconLoader2,
  IconPlug,
  IconPlus,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-react';
import { useFlags } from 'launchdarkly-react-client-sdk';
import React, { FC, useState } from 'react';

import { useTranslations } from 'next-intl';

import { DiscoveredAgent } from '@/lib/services/agents/AgentDiscoveryService';

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

  const organizationAgents = getOrganizationAgents();
  const isBotsEnabled = exploreBots !== false;
  const hasOrganizationAgents = isBotsEnabled && organizationAgents.length > 0;

  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
    null,
  );
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const selectedSource = agentSources.find((s) => s.id === selectedSourceId);

  // Split discovered agents: default (from env-configured sources) vs custom (from user-added sources)
  const customSourcePaths = new Set(agentSources.map((s) => s.resourcePath));
  const defaultFoundryAgents = foundryAgents.filter(
    (a) => !a.source || !customSourcePaths.has(a.source),
  );
  const getSourceAgents = (sourcePath: string) =>
    foundryAgents.filter((a) => a.source === sourcePath);

  const isAgentSelected =
    selectedModelId?.startsWith('org-') ||
    selectedModelId?.startsWith('foundry-') ||
    selectedModelId?.startsWith('custom-');

  const selectedOrgAgent = selectedModelId?.startsWith('org-')
    ? organizationAgents.find((a) => `org-${a.id}` === selectedModelId)
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
          {/* Agents List */}
          {hasOrganizationAgents && (
            <section>
              <div className="flex items-center justify-between mb-1.5">
                <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">
                  {t('organizationAgents.title')}
                </h4>
                <button
                  onClick={onRefreshAgents}
                  disabled={isLoadingFoundryAgents}
                  className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-50 transition-colors"
                  title="Refresh agents"
                >
                  <IconRefresh
                    size={14}
                    className={isLoadingFoundryAgents ? 'animate-spin' : ''}
                  />
                </button>
              </div>
              <OrganizationAgentList
                onSelect={(agent) => {
                  const agentModel = organizationAgentModels.find(
                    (m) =>
                      m.id === `org-${agent.id}` ||
                      m.id === `foundry-${agent.id}`,
                  );
                  if (agentModel) {
                    handleModelSelect(agentModel);
                    setMobileView('details');
                  }
                }}
                selectedAgentId={selectedModelId ?? undefined}
                discoveredAgents={defaultFoundryAgents.map((a) => ({
                  id: a.id,
                  name: a.name,
                  description: a.description,
                  icon: a.icon,
                  color: a.color,
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

          {/* Custom source sections — each gets a header like BASE AGENTS */}
          {agentSources.map((source) => {
            const sourceAgents = getSourceAgents(source.resourcePath);
            return (
              <section
                key={source.id}
                className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700"
              >
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        isLoadingFoundryAgents
                          ? 'bg-gray-400 animate-pulse'
                          : sourceAgents.length > 0
                            ? 'bg-green-500'
                            : 'bg-amber-500'
                      }`}
                    />
                    <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">
                      {source.name}
                    </span>
                    <button
                      onClick={() => setSelectedSourceId(source.id)}
                      className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
                    >
                      Edit
                    </button>
                  </div>
                  <button
                    onClick={onRefreshAgents}
                    disabled={isLoadingFoundryAgents}
                    className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-50 transition-colors"
                    title={`Refresh ${source.name}`}
                  >
                    <IconRefresh
                      size={14}
                      className={isLoadingFoundryAgents ? 'animate-spin' : ''}
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
                      const agentModel = organizationAgentModels.find(
                        (m) => m.id === `foundry-${agent.id}`,
                      );
                      const isSelected =
                        selectedModelId === `foundry-${agent.id}`;
                      return (
                        <button
                          key={agent.id}
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
                              className="shrink-0 text-blue-400"
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
                    No agents published
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

              return (
                <div className="p-1">
                  <div className="flex items-start justify-between mb-1">
                    <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                      {selectedSource.name}
                    </h3>
                    <button
                      onClick={() => onEditSource?.(selectedSource)}
                      className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 px-2 py-1 rounded-md hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                    >
                      Edit
                    </button>
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
                    Connected{' '}
                    {new Date(selectedSource.createdAt).toLocaleDateString()}
                  </p>

                  <div className="mb-6 rounded-lg bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 p-3 text-xs space-y-2">
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

                  <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase mb-2">
                    {t('agentSources.discoveredAgents') || 'Discovered Agents'}{' '}
                    ({sourceAgents.length})
                  </h4>
                  {sourceAgents.length > 0 ? (
                    <div className="space-y-1.5">
                      {sourceAgents.map((agent) => (
                        <div
                          key={agent.id}
                          className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700"
                        >
                          <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
                          <span>{agent.name}</span>
                          {agent.description && (
                            <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
                              — {agent.description}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {isLoadingFoundryAgents
                        ? 'Loading...'
                        : 'No agents discovered. Check that agents are published and you have access.'}
                    </p>
                  )}

                  <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
                    <button
                      onClick={() => {
                        handleDeleteWithConfirm(selectedSource.id);
                        if (confirmingDeleteId === selectedSource.id) {
                          setSelectedSourceId(null);
                        }
                      }}
                      className={`text-sm transition-colors ${
                        confirmingDeleteId === selectedSource.id
                          ? 'text-red-600 dark:text-red-400 font-medium'
                          : 'text-gray-500 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400'
                      }`}
                    >
                      {confirmingDeleteId === selectedSource.id
                        ? 'Click again to disconnect'
                        : 'Disconnect this source'}
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
