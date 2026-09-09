import { useFlags } from 'launchdarkly-react-client-sdk';
import { FC, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import { formatResetIn } from '@/client/hooks/settings/useMyLimits';
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
import { ModelLimitBadge, modelLimitCopy } from './ModelLimitBadge';
import { useModelAvailabilityMap } from './modelLimits';
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
  const tLimits = useTranslations('limitsUx.picker');
  const tEmissions = useTranslations('emissions');
  // A snapshot, not a live tick: this only feeds a static hover tooltip
  // (the badge itself carries the live countdown via useResetCountdown).
  // Calling Date.now() directly in render is impure; the lazy initializer
  // form runs once, on mount, like useResetCountdown's own `now` state.
  const [now] = useState(() => Date.now());
  const { showUsageImpact } = useFlags();
  // Same source the picker list renders from (the useSettings hook), so the
  // Version section always matches what the list shows. byom families come in
  // via familyModels instead.
  const { models } = useSettings();
  const pool = familyModels ?? models;
  const hiddenModelIds = useSettingsStore((s) => s.hiddenModelIds);
  // Usage-limit verdicts: a spent version stays listed (the user should see
  // it exists and when it comes back) but cannot be picked.
  const { lookup: limitFor, refetch: refetchLimits } =
    useModelAvailabilityMap();

  const versions = useMemo(() => {
    // byom ids never exist in the static catalog — the model object itself
    // is authoritative (namespaced series, variant/version metadata).
    const meta = selectedModel.isCustomSourceModel
      ? selectedModel
      : (OpenAIModels[selectedModel.id as OpenAIModelID] ?? selectedModel);
    const hidden = new Set(hiddenModelIds);
    // Chips cover the ACTIVE variant only; other variants live in the
    // VariantSection control above. Sub-variants (GPT 5.6's Sol/Terra/Luna,
    // o-series 3's o3/o3-mini) collapse into ONE chip per version — the
    // SubVariantSection below splits the active one.
    return getVariantVersionGroups(pool, {
      series: meta.series ?? selectedModel.series,
      variant: meta.variant ?? selectedModel.variant,
    })
      .map((group) => ({
        ...group,
        members: group.members.filter((m) => !hidden.has(m.id)),
      }))
      .filter((group) => group.members.length > 0);
  }, [pool, hiddenModelIds, selectedModel]);

  // Older versions collapse behind a disclosure: consolidating the GPT
  // families put up to nine chips on one strip, and `tier: 'legacy'` already
  // means "superseded, keep reachable". A group counts as older only when
  // EVERY model in it is legacy, and the group holding the current selection
  // is always shown so the active chip can never hide itself.
  const isLegacyGroup = (group: (typeof versions)[number]) =>
    group.members.every((m) => getModelTier(m) === 'legacy') &&
    !group.members.some((m) => m.id === selectedModel.id);
  const olderCount = versions.filter(isLegacyGroup).length;
  const shownVersions = showOlder
    ? versions
    : versions.filter((group) => !isLegacyGroup(group));

  if (versions.length < 2) return null;

  // The model each chip stands for and would select: the user's current
  // sub-variant where that version ships one, else the version's
  // representative. Resolved once so the label, the tier icon, the limit
  // badge and the click all agree on the same model.
  const versionTargets = shownVersions.map(
    (group) =>
      pickVersionTarget(group.members, selectedModel.subVariant) ??
      group.members[0],
  );

  // Emissions tier per version chip. Same-variant versions usually share a
  // size class, but not always (e.g. GPT foundational 5.2 is 'standard'
  // while 5.4 is 'large') — icons render only when the choice actually
  // differs in tier (fail-open flag gate, matching the Usage & Impact
  // section).
  const versionTiers = versionTargets.map((version) =>
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
        {shownVersions.map((group, index) => {
          const version = versionTargets[index];
          // Active when the SELECTION sits anywhere in this version — a
          // sub-variant switch must not move the highlighted version chip.
          const isActive = group.members.some((m) => m.id === selectedModel.id);
          const isFeatured =
            SHOW_RECOMMENDED_TAG && getModelTier(version) === 'featured';
          const limit = limitFor(version.id);
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
              key={group.key}
              type="button"
              onClick={isLimited ? undefined : () => onSelectVersion(version)}
              aria-pressed={isActive}
              aria-disabled={isLimited || undefined}
              title={limitTitle ?? version.name}
              className={`rounded-lg border px-2.5 py-1.5 min-h-[36px] text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                isActive
                  ? 'border-blue-600 bg-blue-600 text-white dark:border-blue-500 dark:bg-blue-500'
                  : isLimited
                    ? 'border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-500 opacity-60 cursor-not-allowed'
                    : 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
              }`}
            >
              {group.label}
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
