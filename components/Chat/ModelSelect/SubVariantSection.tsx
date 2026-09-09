import { useFlags } from 'launchdarkly-react-client-sdk';
import { FC, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import { formatResetIn } from '@/client/hooks/settings/useMyLimits';
import { useSettings } from '@/client/hooks/settings/useSettings';

import {
  getVersionMembers,
  getVersionSubVariants,
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
import { ModelLimitBadge, modelLimitCopy } from './ModelLimitBadge';
import { useModelAvailabilityMap } from './modelLimits';

import { useSettingsStore } from '@/client/stores/settingsStore';

interface SubVariantSectionProps {
  selectedModel: OpenAIModel;
  /** Selects another sub-variant of the same version (ModelSelect's handleModelSelect). */
  onSelectSubVariant: (model: OpenAIModel) => void;
  /**
   * Family pool override for custom-source (byom) models, whose families
   * live outside the catalog list. When absent, the pool is the same
   * useSettings().models list the picker renders from.
   */
  familyModels?: OpenAIModel[];
}

/**
 * Sub-variant switcher — the THIRD in-row axis, nested inside one version of
 * one variant, and the only place a version's size tiers are reachable
 * (GPT 5.6's Sol/Terra/Luna, o-series 3's o3/o3-mini).
 *
 * Most versions ship a single model, so this renders nothing at all; it
 * appears only where the ACTIVE version genuinely has more than one. Unlike
 * the Variant and Version controls there is no target resolution to do — a
 * sub-variant IS one model, so each chip selects itself.
 */
export const SubVariantSection: FC<SubVariantSectionProps> = ({
  selectedModel,
  onSelectSubVariant,
  familyModels,
}) => {
  const t = useTranslations('modelSelect');
  const tLimits = useTranslations('limitsUx.picker');
  const tEmissions = useTranslations('emissions');
  // A snapshot, not a live tick: this only feeds a static hover tooltip
  // (the badge itself carries the live countdown via useResetCountdown).
  const [now] = useState(() => Date.now());
  const { showUsageImpact } = useFlags();
  // Same source the picker list renders from, so this control always matches
  // what the list shows. byom families come in via familyModels instead.
  const { models } = useSettings();
  const pool = familyModels ?? models;
  const hiddenModelIds = useSettingsStore((s) => s.hiddenModelIds);
  // Usage-limit verdicts: a spent sub-variant stays listed (the user should
  // see it exists and when it comes back) but cannot be picked.
  const { lookup: limitFor, refetch: refetchLimits } =
    useModelAvailabilityMap();

  const subVariants = useMemo(() => {
    // byom ids never exist in the static catalog — the model object itself
    // is authoritative (namespaced series, variant/version metadata).
    const meta = selectedModel.isCustomSourceModel
      ? selectedModel
      : (OpenAIModels[selectedModel.id as OpenAIModelID] ?? selectedModel);
    const hidden = new Set(hiddenModelIds);
    const members = getVersionMembers(pool, {
      series: meta.series ?? selectedModel.series,
      variant: meta.variant ?? selectedModel.variant,
      versionLabel: meta.versionLabel ?? selectedModel.versionLabel,
    }).filter((m) => !hidden.has(m.id) || m.id === selectedModel.id);
    return getVersionSubVariants(members);
  }, [pool, hiddenModelIds, selectedModel]);

  if (subVariants.length < 2) return null;

  const activeSubVariant = selectedModel.subVariant ?? '';

  // Emissions tier per chip — this axis is precisely where a version's
  // choices differ in size (Sol large vs Luna mini), so the icons carry real
  // information here. Fail-open flag gate, matching the Usage & Impact
  // section.
  const subVariantTiers = subVariants.map((s) =>
    getEmissionsTier(
      getModelSizeClass(s.model),
      s.model.modelType === 'reasoning',
    ),
  );
  const showTiers =
    showUsageImpact !== false && new Set(subVariantTiers).size > 1;
  const tierTooltip = (tier: (typeof subVariantTiers)[number]) =>
    `${tEmissions(`tier.${tier}`)} — ${tEmissions('tierTooltip', {
      version: ASSUMPTIONS_VERSION,
    })}`;

  return (
    <div>
      <h4 className="text-sm font-medium text-gray-900 dark:text-white mb-1.5">
        {t('subVariant.label')}
      </h4>
      <div
        role="group"
        aria-label={t('subVariant.label')}
        className="flex flex-wrap items-center gap-1"
      >
        {subVariants.map((subVariant, index) => {
          const isActive = activeSubVariant === subVariant.key;
          const limit = limitFor(subVariant.model.id);
          // The active chip is never disabled even when spent: the badge
          // says why, and the neighbours are the way out.
          const isLimited = !isActive && limit.state !== 'available';
          // Mouse users hover the chip body, not just the tiny clock icon —
          // the tooltip must carry the reason, not just the model name.
          const limitTitle = isLimited
            ? modelLimitCopy(
                tLimits,
                limit,
                limit.state === 'exhausted' && limit.resetAt
                  ? formatResetIn(limit.resetAt, now)
                  : null,
              )
            : null;
          return (
            <button
              key={subVariant.key}
              type="button"
              onClick={() => {
                if (isActive || isLimited) return;
                onSelectSubVariant(subVariant.model);
              }}
              aria-pressed={isActive}
              aria-disabled={isLimited || undefined}
              title={limitTitle ?? subVariant.model.name}
              className={`rounded-lg border px-2.5 py-1.5 min-h-[36px] text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                isActive
                  ? 'border-blue-600 bg-blue-600 text-white dark:border-blue-500 dark:bg-blue-500'
                  : isLimited
                    ? 'border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-500 opacity-60 cursor-not-allowed'
                    : 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
              }`}
            >
              {subVariant.label || subVariant.model.name}
              {limit.state !== 'available' && (
                <ModelLimitBadge
                  view={limit}
                  onExpired={refetchLimits}
                  size={12}
                  className={isActive ? 'ms-1 text-amber-200' : 'ms-1'}
                />
              )}
              {showTiers && (
                <EmissionsTierIcon
                  tier={subVariantTiers[index]}
                  tooltip={tierTooltip(subVariantTiers[index])}
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
