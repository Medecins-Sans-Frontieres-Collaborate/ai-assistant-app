import { IconBuilding, IconPlus, IconTools } from '@tabler/icons-react';
import { useFlags } from 'launchdarkly-react-client-sdk';
import React, { FC } from 'react';

import { Conversation } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';

import { CustomAgentList } from '../CustomAgents/CustomAgentList';
import { OrganizationAgentList } from '../OrganizationAgents/OrganizationAgentList';
import { ModelDetailsPanel } from './ModelDetailsPanel';

import { CustomAgent } from '@/client/stores/settingsStore';
import { getOrganizationAgents } from '@/lib/organizationAgents';

interface AgentsTabProps {
  openAgentForm: () => void;
  customAgents: CustomAgent[];
  handleEditAgent: (agent: CustomAgent) => void;
  handleDeleteAgent: (agentId: string) => void;
  handleModelSelect: (model: OpenAIModel) => void;
  customAgentModels: OpenAIModel[];
  organizationAgentModels: OpenAIModel[];
  selectedModelId: string | null | undefined;
  defunctAgentIds: Set<string>;
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
  openAgentForm,
  customAgents,
  handleEditAgent,
  handleDeleteAgent,
  handleModelSelect,
  customAgentModels,
  organizationAgentModels,
  selectedModelId,
  defunctAgentIds,
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
  const { exploreBots } = useFlags();

  const organizationAgents = getOrganizationAgents();
  // Only show organization agents if the exploreBots feature flag is enabled
  // Default to true if LaunchDarkly is not configured (for local development)
  const isBotsEnabled = exploreBots !== false;
  const hasOrganizationAgents = isBotsEnabled && organizationAgents.length > 0;

  // Check if an agent is selected (either org or custom)
  const isAgentSelected =
    selectedModelId?.startsWith('org-') ||
    selectedModelId?.startsWith('custom-');

  // Find the selected custom agent for passing to details panel
  const selectedCustomAgent = selectedModelId?.startsWith('custom-')
    ? customAgents.find((a) => `custom-${a.id}` === selectedModelId)
    : undefined;

  // Find the selected organization agent for passing to details panel
  const selectedOrgAgent = selectedModelId?.startsWith('org-')
    ? organizationAgents.find((a) => `org-${a.id}` === selectedModelId)
    : undefined;

  return (
    <div
      className="flex-1 flex flex-col overflow-hidden animate-fade-in-fast"
      key="agents-tab"
    >
      <div className="flex-1 flex flex-col md:flex-row gap-4 md:gap-6 overflow-hidden p-4 md:p-0">
        {/* Left: Agent List (narrow, like Models tab) */}
        <div
          className={`${
            mobileView === 'details' ? 'hidden md:block' : 'block'
          } w-full md:w-80 flex-shrink-0 overflow-y-auto md:border-e border-gray-200 dark:border-gray-700 md:pe-4`}
        >
          {/* Organization Agents Section */}
          {hasOrganizationAgents && (
            <section className="mb-6">
              <div className="flex items-center gap-2 mb-4">
                <IconBuilding
                  size={20}
                  className="text-blue-600 dark:text-blue-400"
                />
                <h3 className="text-base font-semibold text-gray-900 dark:text-white">
                  Organization Agents
                </h3>
                <span className="text-sm text-gray-500 dark:text-gray-400">
                  ({organizationAgents.length})
                </span>
              </div>
              <OrganizationAgentList
                onSelect={(agent) => {
                  const agentModel = organizationAgentModels.find(
                    (m) => m.id === `org-${agent.id}`,
                  );
                  if (agentModel) {
                    handleModelSelect(agentModel);
                    setMobileView('details');
                  }
                }}
                selectedAgentId={selectedModelId ?? undefined}
              />
            </section>
          )}

          {/* Divider */}
          {hasOrganizationAgents && (
            <div className="border-t border-gray-200 dark:border-gray-700 my-6" />
          )}

          {/* Custom Agents Section - Same style as Organization Agents */}
          <section>
            <div className="flex items-center gap-2 mb-4">
              <IconTools
                size={20}
                className="text-purple-600 dark:text-purple-400"
              />
              <h3 className="text-base font-semibold text-gray-900 dark:text-white">
                Custom Agents
              </h3>
              <span className="text-sm text-gray-500 dark:text-gray-400">
                ({customAgents.length})
              </span>
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                Advanced
              </span>
            </div>

            {/* Custom Agents List */}
            <CustomAgentList
              agents={customAgents}
              onSelect={(agent) => {
                const agentModel = customAgentModels.find(
                  (m) => m.id === `custom-${agent.id}`,
                );
                if (agentModel) {
                  handleModelSelect(agentModel);
                  setMobileView('details');
                }
              }}
              selectedModelId={selectedModelId ?? undefined}
              defunctAgentIds={defunctAgentIds}
            />

            {/* Create Button */}
            <button
              onClick={() => openAgentForm()}
              className="w-full mt-2 p-3 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg text-sm font-medium text-gray-600 dark:text-gray-400 hover:border-purple-400 dark:hover:border-purple-500 hover:text-purple-600 dark:hover:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/10 transition-all flex items-center justify-center gap-2"
            >
              <IconPlus size={18} />
              Create Custom Agent
            </button>
          </section>
        </div>

        {/* Right: Agent Details */}
        <div
          className={`${
            mobileView === 'list' ? 'hidden md:block' : 'block'
          } flex-1 overflow-y-auto`}
        >
          {isAgentSelected &&
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
                // Custom agent props for action buttons
                customAgent={selectedCustomAgent}
                onEditAgent={handleEditAgent}
                onDeleteAgent={handleDeleteAgent}
                // Organization agent props
                organizationAgent={selectedOrgAgent}
              />
            )}
          {!isAgentSelected && (
            <div className="h-full flex items-center justify-center text-gray-500 dark:text-gray-400">
              <p className="text-sm">Select an agent to view details</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
