import { FC, useMemo } from 'react';

import { useTranslations } from 'next-intl';

import { useSettings } from '@/client/hooks/settings/useSettings';

import { getSeriesVersions } from '@/lib/utils/app/modelSeries';

import {
  OpenAIModel,
  OpenAIModelID,
  OpenAIModels,
  getModelTier,
} from '@/types/openai';

import { useSettingsStore } from '@/client/stores/settingsStore';

interface VersionSectionProps {
  selectedModel: OpenAIModel;
  /** Selects a different version of the same series (ModelSelect's handleModelSelect). */
  onSelectVersion: (model: OpenAIModel) => void;
}

/**
 * Version switcher for series models, shown in the details panel. The list
 * keeps one quiet row per series; this is where the versions live. Chips run
 * newest → oldest; the recommended (featured) version is marked.
 */
export const VersionSection: FC<VersionSectionProps> = ({
  selectedModel,
  onSelectVersion,
}) => {
  const t = useTranslations('modelSelect');
  // Same source the picker list renders from (the useSettings hook), so the
  // Version section always matches what the list shows.
  const { models } = useSettings();
  const hiddenModelIds = useSettingsStore((s) => s.hiddenModelIds);

  const versions = useMemo(() => {
    const series =
      OpenAIModels[selectedModel.id as OpenAIModelID]?.series ??
      selectedModel.series;
    const hidden = new Set(hiddenModelIds);
    return getSeriesVersions(models, { series }).filter(
      (m) => !hidden.has(m.id),
    );
  }, [models, hiddenModelIds, selectedModel.id, selectedModel.series]);

  if (versions.length < 2) return null;

  return (
    <div>
      <h4 className="text-sm font-medium text-gray-900 dark:text-white mb-1.5">
        {t('version.label')}
      </h4>
      <div
        role="group"
        aria-label={t('version.label')}
        className="flex flex-wrap items-center gap-1"
      >
        {versions.map((version) => {
          const isActive = selectedModel.id === version.id;
          const isFeatured = getModelTier(version) === 'featured';
          return (
            <button
              key={version.id}
              type="button"
              onClick={() => onSelectVersion(version)}
              aria-pressed={isActive}
              title={version.name}
              className={`rounded-lg border px-2.5 py-1.5 min-h-[36px] text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                isActive
                  ? 'border-blue-600 bg-blue-600 text-white dark:border-blue-500 dark:bg-blue-500'
                  : 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
              }`}
            >
              {version.versionLabel ?? version.name}
              {isFeatured && (
                <span
                  className={`ms-1 text-[10px] ${
                    isActive
                      ? 'text-blue-100'
                      : 'text-blue-700 dark:text-blue-300'
                  }`}
                >
                  {t('recommended')}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};
