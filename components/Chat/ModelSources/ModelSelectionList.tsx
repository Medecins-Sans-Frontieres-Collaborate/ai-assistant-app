'use client';

import { FC } from 'react';

import { useTranslations } from 'next-intl';

import { OpenAIModel } from '@/types/openai';

interface ModelSelectionListProps {
  models: OpenAIModel[];
  /** Deployment names currently checked. */
  checkedNames: Set<string>;
  onToggle: (deploymentName: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  autoAdd: boolean;
  onAutoAddChange: (value: boolean) => void;
}

/** Selection lists key on the ARM deployment name (the stable join key). */
export const deploymentNameOf = (model: OpenAIModel): string =>
  model.deploymentName ?? model.id;

/**
 * Step-2 model picker for a BYO Foundry model source: choose which discovered
 * deployments appear in the model picker, plus the per-source auto-add policy
 * for deployments added to the account later. Mirrors AgentSelectionList.
 */
export const ModelSelectionList: FC<ModelSelectionListProps> = ({
  models,
  checkedNames,
  onToggle,
  onSelectAll,
  onDeselectAll,
  autoAdd,
  onAutoAddChange,
}) => {
  const t = useTranslations('modelSources');

  return (
    <div className="space-y-3">
      {models.length > 0 && (
        <>
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {t('modelsSelectedCount', {
                selected: checkedNames.size,
                total: models.length,
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
            {models.map((model) => {
              const deploymentName = deploymentNameOf(model);
              // Deployment name + publisher as the secondary line; the primary
              // line is the known-metadata name when the join succeeded.
              const detail = [
                deploymentName !== model.name ? deploymentName : null,
                model.provider,
              ]
                .filter(Boolean)
                .join(' · ');
              return (
                <label
                  key={deploymentName}
                  className="flex cursor-pointer items-start gap-2.5 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800/60"
                >
                  <input
                    type="checkbox"
                    checked={checkedNames.has(deploymentName)}
                    onChange={() => onToggle(deploymentName)}
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-blue-600"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-gray-900 dark:text-white">
                      {model.name}
                    </span>
                    {detail && (
                      <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                        {detail}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
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
