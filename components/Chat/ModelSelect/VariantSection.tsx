import { useFlags } from 'launchdarkly-react-client-sdk';
import { FC, useMemo } from 'react';

import { useTranslations } from 'next-intl';

import { useSettings } from '@/client/hooks/settings/useSettings';

import {
  getFamilyVariants,
  getSeriesVersions,
  pickVariantTarget,
} from '@/lib/utils/app/modelSeries';
import {
  ASSUMPTIONS_VERSION,
  getEmissionsTier,
} from '@/lib/utils/shared/emissions';

import {
  OpenAIModel,
  OpenAIModelID,
  OpenAIModels,
  getModelSizeClass,
} from '@/types/openai';

import { EmissionsTierIcon } from './EmissionsTierIcon';

import { useSettingsStore } from '@/client/stores/settingsStore';

interface VariantSectionProps {
  selectedModel: OpenAIModel;
  /** Selects a model from another variant of the same family (ModelSelect's handleModelSelect). */
  onSelectVariant: (model: OpenAIModel) => void;
  /**
   * Family pool override for custom-source (byom) models, whose families
   * live outside the catalog list. When absent, the pool is the same
   * useSettings().models list the picker renders from.
   */
  familyModels?: OpenAIModel[];
}

/**
 * Variant switcher for family models — the second in-row axis next to the
 * Version chips (e.g. Standard/Mini/Nano for GPT, Opus/Sonnet/Haiku for
 * Claude, Standard/Reasoning for DeepSeek). Switching keeps the current
 * version when the target variant has it, else jumps to that variant's
 * representative.
 */
export const VariantSection: FC<VariantSectionProps> = ({
  selectedModel,
  onSelectVariant,
  familyModels,
}) => {
  const t = useTranslations('modelSelect');
  const tEmissions = useTranslations('emissions');
  const { showUsageImpact } = useFlags();
  // Same source the picker list renders from (the useSettings hook), so the
  // Variant section always matches what the list shows. byom families come in
  // via familyModels instead.
  const { models } = useSettings();
  const pool = familyModels ?? models;
  const hiddenModelIds = useSettingsStore((s) => s.hiddenModelIds);

  const meta = useMemo(
    // byom ids never exist in the static catalog — the model object itself
    // is authoritative (namespaced series, variant/version metadata).
    () =>
      selectedModel.isCustomSourceModel
        ? selectedModel
        : (OpenAIModels[selectedModel.id as OpenAIModelID] ?? selectedModel),
    [selectedModel],
  );

  const variants = useMemo(() => {
    const hidden = new Set(hiddenModelIds);
    const members = getSeriesVersions(pool, meta).filter(
      (m) => !hidden.has(m.id) || m.id === selectedModel.id,
    );
    // Keep the selected model's own variant present even when all its
    // versions are hidden, so the control never renders without an active
    // segment.
    if (!members.some((m) => m.id === selectedModel.id) && meta.series) {
      members.push(meta as OpenAIModel);
    }
    return getFamilyVariants(members);
  }, [pool, hiddenModelIds, meta, selectedModel.id]);

  if (variants.length < 2) return null;

  const activeVariant = meta.variant ?? '';

  // Emissions tier of each segment's click target. Icons render only when
  // the choice actually differs in tier (fail-open flag gate, matching the
  // Usage & Impact section) — a uniform row of leaves would be noise.
  const variantTiers = variants.map((variant) => {
    const target =
      pickVariantTarget(variant.members, meta.versionLabel) ??
      variant.members[0];
    return getEmissionsTier(
      getModelSizeClass(target),
      target.modelType === 'reasoning',
    );
  });
  const showTiers = showUsageImpact !== false && new Set(variantTiers).size > 1;
  const tierTooltip = (tier: (typeof variantTiers)[number]) =>
    `${tEmissions(`tier.${tier}`)} — ${tEmissions('tierTooltip', {
      version: ASSUMPTIONS_VERSION,
    })}`;

  return (
    <div>
      <h4 className="text-sm font-medium text-gray-900 dark:text-white mb-1.5">
        {t('variant.label')}
      </h4>
      <div
        role="group"
        aria-label={t('variant.label')}
        className="flex flex-wrap items-center gap-1"
      >
        {variants.map((variant, index) => {
          const isActive = activeVariant === variant.key;
          return (
            <button
              key={variant.key}
              type="button"
              onClick={() => {
                if (isActive) return;
                const target = pickVariantTarget(
                  variant.members,
                  meta.versionLabel,
                );
                if (target) onSelectVariant(target);
              }}
              aria-pressed={isActive}
              title={variant.members[0]?.name}
              className={`rounded-lg border px-2.5 py-1.5 min-h-[36px] text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                isActive
                  ? 'border-blue-600 bg-blue-600 text-white dark:border-blue-500 dark:bg-blue-500'
                  : 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
              }`}
            >
              {variant.label || variant.members[0]?.name}
              {showTiers && (
                <EmissionsTierIcon
                  tier={variantTiers[index]}
                  tooltip={tierTooltip(variantTiers[index])}
                  muted={isActive}
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};
