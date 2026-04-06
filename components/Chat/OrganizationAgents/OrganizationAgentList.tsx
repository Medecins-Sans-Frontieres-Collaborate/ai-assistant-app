'use client';

import { IconCheck, IconHexagon, IconRobot } from '@tabler/icons-react';
import { FC } from 'react';

import { useTranslations } from 'next-intl';

import { OrganizationAgent } from '@/types/organizationAgent';

import {
  getIconComponent,
  getOrganizationAgents,
} from '@/lib/organizationAgents';

interface FoundryAgentDisplay {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  color?: string;
}

interface OrganizationAgentListProps {
  onSelect: (agent: OrganizationAgent | FoundryAgentDisplay) => void;
  selectedAgentId?: string;
  discoveredAgents?: FoundryAgentDisplay[];
}

/**
 * Simple list of organization agents for the left sidebar.
 * Shows just the agent name and icon (like ModelCard).
 * Full details are shown in the details panel on the right.
 */
export const OrganizationAgentList: FC<OrganizationAgentListProps> = ({
  onSelect,
  selectedAgentId,
  discoveredAgents = [],
}) => {
  const t = useTranslations('agents');
  const staticAgents = getOrganizationAgents();

  // Merge static + discovered, deduplicate by name
  const staticNames = new Set(staticAgents.map((a) => a.name));
  const uniqueDiscovered = discoveredAgents.filter(
    (a) => !staticNames.has(a.name),
  );

  const allAgents: (OrganizationAgent | FoundryAgentDisplay)[] = [
    ...staticAgents,
    ...uniqueDiscovered,
  ];

  if (allAgents.length === 0) {
    return (
      <div className="p-8 text-center">
        <IconRobot
          size={48}
          className="mx-auto mb-3 text-gray-400 dark:text-gray-600"
        />
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('noOrgAgentsConfigured')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {allAgents.map((agent) => {
        const agentIcon = 'icon' in agent ? agent.icon : undefined;
        const agentColor = ('color' in agent ? agent.color : null) || '#60a5fa';
        const IconComp = agentIcon ? getIconComponent(agentIcon) : IconHexagon;
        const isSelected =
          selectedAgentId === `org-${agent.id}` ||
          selectedAgentId === `foundry-${agent.id}`;

        return (
          <button
            key={agent.id}
            type="button"
            onClick={() => onSelect(agent)}
            className={`
              w-full text-left px-3 py-2 rounded-lg transition-all duration-150 flex items-center justify-between gap-2
              ${
                isSelected
                  ? 'bg-blue-50 dark:bg-blue-900/20 border-2 border-blue-300 dark:border-blue-600'
                  : 'bg-white dark:bg-surface-dark border-2 border-transparent hover:border-gray-200 dark:hover:border-gray-700'
              }
            `}
          >
            <div className="flex items-center gap-2.5">
              <IconComp
                size={agentIcon ? 22 : 18}
                className="flex-shrink-0"
                style={{ color: agentColor }}
              />
              <span className="font-medium text-sm text-gray-900 dark:text-white">
                {agent.name}
              </span>
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
