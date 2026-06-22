'use client';

import {
  IconCheck,
  IconHexagon,
  IconRobot,
  IconTrash,
} from '@tabler/icons-react';
import { FC } from 'react';

import { useTranslations } from 'next-intl';

import { colorForAgent } from '@/lib/utils/app/agentColor';

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
  /** Pre-computed model ID for selection comparison — prefer this over reconstructing on every render. */
  matchId?: string;
}

interface OrganizationAgentListProps {
  onSelect: (agent: OrganizationAgent | FoundryAgentDisplay) => void;
  selectedAgentId?: string;
  discoveredAgents?: FoundryAgentDisplay[];
  /** Model IDs hidden by the user — filtered out of this list. */
  hiddenIds?: Set<string>;
  /** Hide an agent (trash icon). Receives the row's model ID and display name. */
  onHide?: (modelId: string, name: string) => void;
  /** Accessible label for the hide (trash) button. */
  hideLabel?: string;
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
  hiddenIds,
  onHide,
  hideLabel,
}) => {
  const t = useTranslations('agents');
  const staticAgents = getOrganizationAgents();

  // Merge static + discovered, deduplicate by name
  const staticNames = new Set(staticAgents.map((a) => a.name));
  const uniqueDiscovered = discoveredAgents.filter(
    (a) => !staticNames.has(a.name),
  );

  // Model ID a row selects/compares against (static: `org-{id}`, discovered:
  // a precomputed matchId from the parent).
  const modelIdFor = (agent: OrganizationAgent | FoundryAgentDisplay) =>
    ('matchId' in agent && agent.matchId) || `org-${agent.id}`;

  const mergedAgents: (OrganizationAgent | FoundryAgentDisplay)[] = [
    ...staticAgents,
    ...uniqueDiscovered,
  ];

  // Hidden agents drop out here; they resurface in the parent's "Hidden" group.
  const allAgents = hiddenIds
    ? mergedAgents.filter((a) => !hiddenIds.has(modelIdFor(a)))
    : mergedAgents;

  if (allAgents.length === 0) {
    // Everything in this section is hidden (but agents do exist) → render
    // nothing; the parent's "Hidden" group lists them. Only show the genuine
    // empty state when there were no agents to begin with.
    if (mergedAgents.length > 0) {
      return null;
    }
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
        const agentColor =
          ('color' in agent ? agent.color : null) || colorForAgent(agent.name);
        const IconComp = agentIcon ? getIconComponent(agentIcon) : IconHexagon;
        const explicitMatchId = 'matchId' in agent ? agent.matchId : undefined;
        const modelId = modelIdFor(agent);
        const isSelected = explicitMatchId
          ? selectedAgentId === explicitMatchId
          : selectedAgentId === `org-${agent.id}`;

        return (
          <div
            key={agent.id}
            className={`
              group relative w-full rounded-lg transition-all duration-150 flex items-center
              ${
                isSelected
                  ? 'bg-blue-50 dark:bg-blue-900/20 border-2 border-blue-300 dark:border-blue-600'
                  : 'bg-white dark:bg-surface-dark border-2 border-transparent hover:border-gray-200 dark:hover:border-gray-700'
              }
            `}
          >
            <button
              type="button"
              onClick={() => onSelect(agent)}
              className="flex-1 min-w-0 text-left px-3 py-2 flex items-center justify-between gap-2"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <IconComp
                  size={18}
                  className="flex-shrink-0"
                  style={{ color: agentColor }}
                />
                <span className="font-medium text-sm text-gray-900 dark:text-white truncate">
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
            {onHide && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onHide(modelId, agent.name);
                }}
                aria-label={hideLabel}
                title={hideLabel}
                className="shrink-0 me-2 p-1.5 rounded text-gray-400 hover:text-red-600 dark:text-gray-500 dark:hover:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-700 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100 transition-opacity"
              >
                <IconTrash size={16} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
};
