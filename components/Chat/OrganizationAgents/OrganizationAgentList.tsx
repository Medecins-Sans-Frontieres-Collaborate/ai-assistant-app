'use client';

import { IconCheck, IconRobot } from '@tabler/icons-react';
import { FC } from 'react';

import { OrganizationAgent } from '@/types/organizationAgent';

import {
  getIconComponent,
  getOrganizationAgents,
} from '@/lib/organizationAgents';

interface OrganizationAgentListProps {
  onSelect: (agent: OrganizationAgent) => void;
  selectedAgentId?: string;
}

/**
 * Simple list of organization agents for the left sidebar.
 * Shows just the agent name and icon (like ModelCard).
 * Full details are shown in the details panel on the right.
 */
export const OrganizationAgentList: FC<OrganizationAgentListProps> = ({
  onSelect,
  selectedAgentId,
}) => {
  const agents = getOrganizationAgents();

  if (agents.length === 0) {
    return (
      <div className="p-8 text-center">
        <IconRobot
          size={48}
          className="mx-auto mb-3 text-gray-400 dark:text-gray-600"
        />
        <p className="text-sm text-gray-500 dark:text-gray-400">
          No organization agents configured.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {agents.map((agent) => {
        const IconComp = getIconComponent(agent.icon);
        const isSelected = selectedAgentId === `org-${agent.id}`;

        return (
          <button
            key={agent.id}
            type="button"
            onClick={() => onSelect(agent)}
            className={`
              w-full text-left p-3 rounded-lg transition-all duration-150 flex items-center justify-between gap-2
              ${
                isSelected
                  ? 'bg-blue-50 dark:bg-blue-900/20 border-2 border-blue-300 dark:border-blue-600'
                  : 'bg-white dark:bg-[#212121] border-2 border-transparent hover:border-gray-200 dark:hover:border-gray-700'
              }
            `}
          >
            <div className="flex items-center gap-2">
              <div
                className="w-6 h-6 rounded flex items-center justify-center flex-shrink-0"
                style={{ backgroundColor: agent.color + '20' }}
              >
                <IconComp size={16} style={{ color: agent.color }} />
              </div>
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
