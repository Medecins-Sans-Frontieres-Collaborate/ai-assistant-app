import { useFlags } from 'launchdarkly-react-client-sdk';
import { FC, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import { formatResetIn } from '@/client/hooks/settings/useMyLimits';
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
import { ModelLimitBadge, modelLimitCopy } from './ModelLimitBadge';
import { useModelAvailabilityMap } from './modelLimits';

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
 * Variant switcher for family models — the FIRST narrowing axis inside a
 * family row, above the Version chips (Foundational/Chat/Mini/Nano/o-series
 * for GPT, Fable/Opus/Sonnet/Haiku for Claude, Standard/Reasoning for
 * DeepSeek). Switching keeps as much of the user's position as the target
 * variant can offer — same version, and same sub-variant within it — else
 * jumps to that variant's representative.
 */
export const VariantSection: FC<VariantSectionProps> = ({
  selectedModel,
  onSelectVariant,
  familyModels,
}) => {
  const t = useTranslations('modelSelect');
  const tLimits = useTranslations('limitsUx.picker');
  const tEmissions = useTranslations('emissions');
  // A snapshot, not a live tick: this only feeds a static hover tooltip
  // (the badge itself carries the live countdown via useResetCountdown).
  // Calling Date.now() directly in render is impure; the lazy initializer
  // form runs once, on mount, like useResetCountdown's own `now` state.
  const [now] = useState(() => Date.now());
  const { showUsageImpact } = useFlags();
  // Same source the picker list renders from (the useSettings hook), so the
  // Variant section always matches what the list shows. byom families come in
  // via familyModels instead.
  const { models } = useSettings();
  const pool = familyModels ?? models;
  const hiddenModelIds = useSettingsStore((s) => s.hiddenModelIds);
  // Usage-limit verdicts: a segment lands on a still-usable version of its
  // variant when one exists, and is disabled only when the whole variant is
  // spent.
  const {
    lookup: limitFor,
    isSelectable: isNotExhausted,
    refetch: refetchLimits,
  } = useModelAvailabilityMap();

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

  // Each segment's click target (see pickVariantTarget), resolved once so
  // the tier icon, the limit badge and the click agree on the same model.
  const variantTargets = variants.map(
    (variant) =>
      pickVariantTarget(
        variant.members,
        meta.versionLabel,
        isNotExhausted,
        // Carry the size tier across too, so Terra → o-series lands on the
        // o-series mini rather than resetting to its flagship.
        meta.subVariant,
      ) ?? variant.members[0],
  );

  // Emissions tier of each segment's click target. Icons render only when
  // the choice actually differs in tier (fail-open flag gate, matching the
  // Usage & Impact section) — a uniform row of leaves would be noise.
  const variantTiers = variantTargets.map((target) =>
    getEmissionsTier(
      getModelSizeClass(target),
      target.modelType === 'reasoning',
    ),
  );
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
          const target = variantTargets[index];
          const targetLimit = limitFor(target.id);
          // Disabled only when NO version of the variant is usable — the
          // target is then the natural pick, and its verdict is the reason.
          const isLimited = !isActive && targetLimit.state !== 'available';
          // Mouse users hover the segment body, not just the tiny clock
          // icon — the tooltip must carry the reason, not just the name.
          const limitTitle = isLimited
            ? modelLimitCopy(
                tLimits,
                targetLimit,
                targetLimit.state === 'exhausted' && targetLimit.resetAt
                  ? formatResetIn(targetLimit.resetAt, now)
                  : null,
              )
            : null;
          return (
            <button
              key={variant.key}
              type="button"
              onClick={() => {
                if (isActive || isLimited) return;
                onSelectVariant(target);
              }}
              aria-pressed={isActive}
              aria-disabled={isLimited || undefined}
              title={limitTitle ?? variant.members[0]?.name}
              className={`rounded-lg border px-2.5 py-1.5 min-h-[36px] text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                isActive
                  ? 'border-blue-600 bg-blue-600 text-white dark:border-blue-500 dark:bg-blue-500'
                  : isLimited
                    ? 'border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-500 opacity-60 cursor-not-allowed'
                    : 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
              }`}
            >
              {variant.label || variant.members[0]?.name}
              {isLimited && (
                <ModelLimitBadge
                  view={targetLimit}
                  onExpired={refetchLimits}
                  size={12}
                  className="ms-1"
                />
              )}
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
