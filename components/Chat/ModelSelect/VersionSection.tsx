import { useFlags } from 'launchdarkly-react-client-sdk';
import { FC, useMemo } from 'react';

import { useTranslations } from 'next-intl';

import { useSettings } from '@/client/hooks/settings/useSettings';

import { getVariantVersions } from '@/lib/utils/app/modelSeries';
import {
  ASSUMPTIONS_VERSION,
  getEmissionsTier,
} from '@/lib/utils/shared/emissions';

import {
  OpenAIModel,
  OpenAIModelID,
  OpenAIModels,
  getModelSizeClass,
  getModelTier,
} from '@/types/openai';

import { EmissionsTierIcon } from './EmissionsTierIcon';
import { SHOW_RECOMMENDED_TAG } from './showRecommendedTag';

import { useSettingsStore } from '@/client/stores/settingsStore';

interface VersionSectionProps {
  selectedModel: OpenAIModel;
  /** Selects a different version of the same series (ModelSelect's handleModelSelect). */
  onSelectVersion: (model: OpenAIModel) => void;
  /**
   * Family pool override for custom-source (byom) models, whose families
   * live outside the catalog list. When absent, the pool is the same
   * useSettings().models list the picker renders from.
   */
  familyModels?: OpenAIModel[];
}

/**
 * Version switcher for series models, shown in the details panel. The list
 * keeps one quiet row per series; this is where the versions live. Chips run
 * newest → oldest; the recommended (featured) version is marked only when
 * SHOW_RECOMMENDED_TAG is on.
 */
export const VersionSection: FC<VersionSectionProps> = ({
  selectedModel,
  onSelectVersion,
  familyModels,
}) => {
  const t = useTranslations('modelSelect');
  const tEmissions = useTranslations('emissions');
  const { showUsageImpact } = useFlags();
  // Same source the picker list renders from (the useSettings hook), so the
  // Version section always matches what the list shows. byom families come in
  // via familyModels instead.
  const { models } = useSettings();
  const pool = familyModels ?? models;
  const hiddenModelIds = useSettingsStore((s) => s.hiddenModelIds);

  const versions = useMemo(() => {
    // byom ids never exist in the static catalog — the model object itself
    // is authoritative (namespaced series, variant/version metadata).
    const meta = selectedModel.isCustomSourceModel
      ? selectedModel
      : (OpenAIModels[selectedModel.id as OpenAIModelID] ?? selectedModel);
    const hidden = new Set(hiddenModelIds);
    // Chips cover the ACTIVE variant only; other variants live in the
    // VariantSection control above.
    return getVariantVersions(pool, {
      series: meta.series ?? selectedModel.series,
      variant: meta.variant ?? selectedModel.variant,
    }).filter((m) => !hidden.has(m.id));
  }, [pool, hiddenModelIds, selectedModel]);

  if (versions.length < 2) return null;

  // Emissions tier per version chip. Same-variant versions usually share a
  // size class, but not always (e.g. GPT standard 5.2 is 'standard' while
  // 5.4 is 'large') — icons render only when the choice actually differs in
  // tier (fail-open flag gate, matching the Usage & Impact section).
  const versionTiers = versions.map((version) =>
    getEmissionsTier(
      getModelSizeClass(version),
      version.modelType === 'reasoning',
    ),
  );
  const showTiers = showUsageImpact !== false && new Set(versionTiers).size > 1;
  const tierTooltip = (tier: (typeof versionTiers)[number]) =>
    `${tEmissions(`tier.${tier}`)} — ${tEmissions('tierTooltip', {
      version: ASSUMPTIONS_VERSION,
    })}`;

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
        {versions.map((version, index) => {
          const isActive = selectedModel.id === version.id;
          const isFeatured =
            SHOW_RECOMMENDED_TAG && getModelTier(version) === 'featured';
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
              {showTiers && (
                <EmissionsTierIcon
                  tier={versionTiers[index]}
                  tooltip={tierTooltip(versionTiers[index])}
                  muted={isActive}
                />
              )}
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
