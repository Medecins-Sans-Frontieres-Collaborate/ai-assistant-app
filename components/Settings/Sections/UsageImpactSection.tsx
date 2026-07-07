'use client';

import { IconLeaf, IconTrash } from '@tabler/icons-react';
import { FC, useMemo } from 'react';

import { useTranslations } from 'next-intl';

import { useSettings } from '@/client/hooks/settings/useSettings';

import {
  ASSUMPTIONS_VERSION,
  SMARTPHONE_CHARGE_GRAMS,
  estimateCO2Grams,
} from '@/lib/utils/shared/emissions';

import { OpenAIModelID, OpenAIModels, getModelSizeClass } from '@/types/openai';

import { useSettingsStore } from '@/client/stores/settingsStore';

/** Splits a `modelId|region|effort` bucket key back into its parts. */
function parseKey(key: string): {
  modelId: string;
  region: 'US' | 'EU' | 'default';
  effort: 'none' | 'minimal' | 'low' | 'medium' | 'high';
} {
  const [modelId, region, effort] = key.split('|');
  return {
    modelId,
    region: region as 'US' | 'EU' | 'default',
    effort: effort as 'none' | 'minimal' | 'low' | 'medium' | 'high',
  };
}

const numberFmt = new Intl.NumberFormat();

export const UsageImpactSection: FC = () => {
  const t = useTranslations();
  const tokenUsageStats = useSettingsStore((s) => s.tokenUsageStats);
  const firstTrackedAt = useSettingsStore((s) => s.tokenUsageFirstTrackedAt);
  const resetTokenUsageStats = useSettingsStore((s) => s.resetTokenUsageStats);
  // The live model list (discovery-aware) is the best source of size class /
  // reasoning flags; fall back to the static registry, then to defaults, for
  // retired ids no longer in either.
  const { models } = useSettings();

  const summary = useMemo(() => {
    const entries = Object.entries(tokenUsageStats);
    let totalRequests = 0;
    let totalPrompt = 0;
    let totalCompletion = 0;
    let totalCO2 = 0;
    const byModel = new Map<string, { requests: number; gCO2e: number }>();
    const byRegion = new Map<string, { requests: number; gCO2e: number }>();

    for (const [key, bucket] of entries) {
      const { modelId, region, effort } = parseKey(key);
      const model =
        models.find((m) => m.id === modelId) ??
        OpenAIModels[modelId as OpenAIModelID];
      const { gCO2e } = estimateCO2Grams({
        promptTokens: bucket.promptTokens,
        completionTokens: bucket.completionTokens,
        sizeClass: getModelSizeClass(model ?? {}),
        isDedicatedReasoner: model?.modelType === 'reasoning',
        reasoningEffort: effort === 'none' ? undefined : effort,
        region: region === 'default' ? null : region,
      });

      totalRequests += bucket.requests;
      totalPrompt += bucket.promptTokens;
      totalCompletion += bucket.completionTokens;
      totalCO2 += gCO2e;

      const displayName = model?.name ?? modelId;
      const m = byModel.get(displayName) ?? { requests: 0, gCO2e: 0 };
      m.requests += bucket.requests;
      m.gCO2e += gCO2e;
      byModel.set(displayName, m);

      const r = byRegion.get(region) ?? { requests: 0, gCO2e: 0 };
      r.requests += bucket.requests;
      r.gCO2e += gCO2e;
      byRegion.set(region, r);
    }

    const topModels = [...byModel.entries()]
      .sort((a, b) => b[1].gCO2e - a[1].gCO2e)
      .slice(0, 5);
    const regions = [...byRegion.entries()].sort(
      (a, b) => b[1].gCO2e - a[1].gCO2e,
    );

    return {
      totalRequests,
      totalPrompt,
      totalCompletion,
      totalCO2,
      topModels,
      regions,
      isEmpty: entries.length === 0,
    };
  }, [tokenUsageStats, models]);

  const smartphoneCharges =
    summary.totalCO2 > 0 ? summary.totalCO2 / SMARTPHONE_CHARGE_GRAMS : 0;

  const regionLabel = (region: string) =>
    region === 'default' ? t('usageImpact.regionDefault') : region;

  return (
    <div className="p-4">
      <div className="flex items-center gap-2 mb-6">
        <IconLeaf size={24} className="text-black dark:text-white" />
        <h2 className="text-xl font-bold text-black dark:text-white">
          {t('settings.Usage & Impact')}
        </h2>
      </div>

      {summary.isEmpty ? (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {t('usageImpact.empty')}
        </p>
      ) : (
        <div className="space-y-6">
          {/* Headline estimate */}
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-surface-dark p-4">
            <p className="text-3xl font-bold text-black dark:text-white">
              {t('usageImpact.co2Value', {
                grams: numberFmt.format(Math.round(summary.totalCO2)),
              })}
            </p>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              {t('usageImpact.equivalence', {
                count: Math.round(smartphoneCharges),
              })}
            </p>
          </div>

          {/* Totals */}
          <div className="grid grid-cols-3 gap-3">
            {[
              {
                label: t('usageImpact.requests'),
                value: numberFmt.format(summary.totalRequests),
              },
              {
                label: t('usageImpact.promptTokens'),
                value: numberFmt.format(summary.totalPrompt),
              },
              {
                label: t('usageImpact.completionTokens'),
                value: numberFmt.format(summary.totalCompletion),
              },
            ].map((stat) => (
              <div
                key={stat.label}
                className="rounded-lg border border-gray-200 dark:border-gray-700 p-3"
              >
                <p className="text-lg font-semibold text-black dark:text-white">
                  {stat.value}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {stat.label}
                </p>
              </div>
            ))}
          </div>

          {/* Per-model breakdown */}
          <div>
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
              {t('usageImpact.topModels')}
            </h3>
            <div className="space-y-1">
              {summary.topModels.map(([name, m]) => (
                <div
                  key={name}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="text-gray-800 dark:text-gray-200 truncate">
                    {name}
                  </span>
                  <span className="text-gray-500 dark:text-gray-400 shrink-0 ps-3">
                    {t('usageImpact.modelRow', {
                      requests: numberFmt.format(m.requests),
                      grams: numberFmt.format(Math.round(m.gCO2e)),
                    })}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Per-region split */}
          <div>
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
              {t('usageImpact.byRegion')}
            </h3>
            <div className="space-y-1">
              {summary.regions.map(([region, r]) => (
                <div
                  key={region}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="text-gray-800 dark:text-gray-200">
                    {regionLabel(region)}
                  </span>
                  <span className="text-gray-500 dark:text-gray-400">
                    {t('usageImpact.modelRow', {
                      requests: numberFmt.format(r.requests),
                      grams: numberFmt.format(Math.round(r.gCO2e)),
                    })}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Disclosure + reset */}
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t('usageImpact.disclosure', {
              version: ASSUMPTIONS_VERSION,
              since: firstTrackedAt
                ? new Date(firstTrackedAt).toLocaleDateString()
                : '—',
            })}
          </p>
          <button
            type="button"
            onClick={resetTokenUsageStats}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20 transition-colors"
          >
            <IconTrash size={16} />
            {t('usageImpact.reset')}
          </button>
        </div>
      )}
    </div>
  );
};
