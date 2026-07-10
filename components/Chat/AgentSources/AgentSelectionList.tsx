'use client';

import { FC } from 'react';

import { useTranslations } from 'next-intl';

import type { DiscoveredAgent } from '@/lib/services/agents/AgentDiscoveryService';

interface AgentSelectionListProps {
  agents: DiscoveredAgent[];
  checkedNames: Set<string>;
  onToggle: (agentName: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  autoAdd: boolean;
  onAutoAddChange: (value: boolean) => void;
}

/**
 * Step-2 agent picker for a Foundry source: choose which discovered agents
 * appear in the model picker, plus the per-source auto-add policy for agents
 * published to the project later.
 */
export const AgentSelectionList: FC<AgentSelectionListProps> = ({
  agents,
  checkedNames,
  onToggle,
  onSelectAll,
  onDeselectAll,
  autoAdd,
  onAutoAddChange,
}) => {
  const t = useTranslations('agents');

  return (
    <div className="space-y-3">
      {agents.length > 0 && (
        <>
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {t('agentsSelectedCount', {
                selected: checkedNames.size,
                total: agents.length,
              })}
            </span>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={onSelectAll}
                className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300"
              >
                {t('selectAll')}
              </button>
              <button
                type="button"
                onClick={onDeselectAll}
                className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300"
              >
                {t('deselectAll')}
              </button>
            </div>
          </div>
          <div className="max-h-56 divide-y divide-gray-100 dark:divide-gray-800 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700">
            {agents.map((agent) => (
              <label
                key={agent.agentName}
                className="flex cursor-pointer items-start gap-2.5 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800/60"
              >
                <input
                  type="checkbox"
                  checked={checkedNames.has(agent.agentName)}
                  onChange={() => onToggle(agent.agentName)}
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-blue-600"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-gray-900 dark:text-white">
                    {agent.name}
                  </span>
                  {agent.description && (
                    <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                      {agent.description}
                    </span>
                  )}
                </span>
              </label>
            ))}
          </div>
        </>
      )}

      <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2.5">
        <input
          type="checkbox"
          checked={autoAdd}
          onChange={(e) => onAutoAddChange(e.target.checked)}
          className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-blue-600"
        />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-gray-900 dark:text-white">
            {t('autoAddLabel')}
          </span>
          <span className="block text-xs text-gray-500 dark:text-gray-400">
            {t('autoAddDescription')}
          </span>
        </span>
      </label>
    </div>
  );
};
