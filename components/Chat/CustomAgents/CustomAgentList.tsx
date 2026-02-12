'use client';

import { IconAlertTriangle, IconCheck, IconRobot } from '@tabler/icons-react';
import { FC } from 'react';

import { useTranslations } from 'next-intl';

import { OpenAIModels } from '@/types/openai';

import {
  ClaudeAIIcon,
  DeepSeekIcon,
  MetaIcon,
  OpenAIIcon,
  XAIIcon,
} from '@/components/Icons/providers';

import { CustomAgent } from '@/client/stores/settingsStore';

interface CustomAgentListProps {
  agents: CustomAgent[];
  onSelect: (agent: CustomAgent) => void;
  selectedModelId?: string;
  defunctAgentIds: Set<string>;
}

/**
 * Simple list of custom agents for the left sidebar.
 * Shows just the agent name and icon (like OrganizationAgentList).
 * Full details are shown in the details panel on the right.
 */
export const CustomAgentList: FC<CustomAgentListProps> = ({
  agents,
  onSelect,
  selectedModelId,
  defunctAgentIds,
}) => {
  const t = useTranslations('agents');
  // Helper function to get provider icon
  const getProviderIcon = (provider?: string) => {
    const iconProps = { className: 'w-4 h-4 flex-shrink-0' };
    switch (provider) {
      case 'openai':
        return <OpenAIIcon {...iconProps} />;
      case 'deepseek':
        return <DeepSeekIcon {...iconProps} />;
      case 'xai':
        return <XAIIcon {...iconProps} />;
      case 'meta':
        return <MetaIcon {...iconProps} />;
      case 'anthropic':
        return <ClaudeAIIcon {...iconProps} />;
      default:
        return null;
    }
  };

  if (agents.length === 0) {
    return (
      <div className="p-6 text-center">
        <IconRobot
          size={36}
          className="mx-auto mb-2 text-gray-400 dark:text-gray-600"
        />
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('noCustomAgentsYet')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {agents.map((agent) => {
        const baseModel = OpenAIModels[agent.baseModelId];
        const isSelected = selectedModelId === `custom-${agent.id}`;
        const isDefunct = defunctAgentIds.has(agent.id);

        return (
          <button
            key={agent.id}
            type="button"
            onClick={() => !isDefunct && onSelect(agent)}
            disabled={isDefunct}
            className={`
              w-full text-left p-3 rounded-lg transition-all duration-150 flex items-center justify-between gap-2
              ${
                isDefunct
                  ? 'border-2 border-amber-300 dark:border-amber-700 opacity-60 cursor-not-allowed bg-amber-50 dark:bg-amber-900/10'
                  : isSelected
                    ? 'bg-blue-50 dark:bg-blue-900/20 border-2 border-blue-300 dark:border-blue-600'
                    : 'bg-white dark:bg-[#212121] border-2 border-transparent hover:border-gray-200 dark:hover:border-gray-700'
              }
            `}
          >
            <div className="flex items-center gap-2">
              {getProviderIcon(baseModel?.provider)}
              <span className="font-medium text-sm text-gray-900 dark:text-white">
                {agent.name}
              </span>
              {isDefunct && (
                <IconAlertTriangle
                  size={14}
                  className="text-amber-500 dark:text-amber-400"
                />
              )}
            </div>
            {isSelected && (
              <IconCheck
                size={16}
                className="text-blue-600 dark:text-blue-400"
              />
            )}
          </button>
        );
      })}
    </div>
  );
};
