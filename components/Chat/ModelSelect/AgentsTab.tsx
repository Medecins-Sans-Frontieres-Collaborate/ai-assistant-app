import {
  IconChevronDown,
  IconChevronUp,
  IconInfoCircle,
  IconPlus,
} from '@tabler/icons-react';
import React, { FC } from 'react';

import { OpenAIModel } from '@/types/openai';

import { AzureAIIcon } from '@/components/Icons/providers';

import { CustomAgentList } from '../CustomAgents/CustomAgentList';

import { CustomAgent } from '@/client/stores/settingsStore';

interface AgentsTabProps {
  showAgentWarning: boolean;
  setShowAgentWarning: (show: boolean) => void;
  openAgentForm: () => void;
  customAgents: CustomAgent[];
  handleEditAgent: (agent: CustomAgent) => void;
  handleDeleteAgent: (agentId: string) => void;
  handleImportAgents: (agents: CustomAgent[]) => void;
  handleModelSelect: (model: OpenAIModel) => void;
  customAgentModels: OpenAIModel[];
  selectedModelId: string | null | undefined;
}

export const AgentsTab: FC<AgentsTabProps> = ({
  showAgentWarning,
  setShowAgentWarning,
  openAgentForm,
  customAgents,
  handleEditAgent,
  handleDeleteAgent,
  handleImportAgents,
  handleModelSelect,
  customAgentModels,
  selectedModelId,
}) => {
  return (
    <div
      className="flex-1 overflow-hidden flex flex-col animate-fade-in-fast"
      key="agents-tab"
    >
      <div className="mb-6 p-4 md:p-0">
        <div className="flex items-center gap-2 mb-3">
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
            Advanced Feature
          </span>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Create and manage custom AI agents with specialized capabilities.
          These agents run on the MSF AI Assistant Foundry instance.
        </p>

        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800 overflow-hidden">
          <button
            onClick={() => setShowAgentWarning(!showAgentWarning)}
            className="w-full p-4 flex items-start gap-3 hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors"
          >
            <IconInfoCircle
              size={18}
              className="flex-shrink-0 text-blue-600 dark:text-blue-400 mt-0.5"
            />
            <div className="flex-1 text-left">
              <div className="text-sm font-medium text-blue-700 dark:text-blue-300">
                Advanced Feature - Requires Coordination with AI Assistant
                Technical Team
              </div>
            </div>
            {showAgentWarning ? (
              <IconChevronUp
                size={18}
                className="flex-shrink-0 text-blue-600 dark:text-blue-400"
              />
            ) : (
              <IconChevronDown
                size={18}
                className="flex-shrink-0 text-blue-600 dark:text-blue-400"
              />
            )}
          </button>
          {showAgentWarning && (
            <div className="px-4 pb-4 text-sm text-blue-700 dark:text-blue-300">
              Custom agents only work with the{' '}
              <strong>MSF AI Assistant Foundry instance</strong>. Agent IDs must
              be created by the AI Assistant technical team in this specific
              instance and coordinated with you before use.
            </div>
          )}
        </div>
      </div>

      <div className="mb-6 px-4 md:px-0">
        <button
          onClick={() => openAgentForm()}
          className="w-full p-4 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 hover:border-blue-500 dark:hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/10 transition-all flex items-center justify-center gap-2"
        >
          <IconPlus size={18} />
          Create New Custom Agent
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 md:px-0">
        {customAgents.length > 0 ? (
          <CustomAgentList
            agents={customAgents}
            onEdit={handleEditAgent}
            onDelete={handleDeleteAgent}
            onImport={handleImportAgents}
            onSelect={(agent) => {
              const agentModel = customAgentModels.find(
                (m) => m.id === `custom-${agent.id}`,
              );
              if (agentModel) {
                handleModelSelect(agentModel);
              }
            }}
            selectedModelId={selectedModelId ?? undefined}
          />
        ) : (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="w-16 h-16 bg-gray-100 dark:bg-gray-800 rounded-full flex items-center justify-center mb-4">
              <AzureAIIcon className="w-8 h-8" />
            </div>
            <h4 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
              No Custom Agents Yet
            </h4>
            <p className="text-sm text-gray-600 dark:text-gray-400 max-w-md">
              Create your first custom agent to extend AI capabilities with
              specialized tools and behaviors.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
