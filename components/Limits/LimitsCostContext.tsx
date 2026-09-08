'use client';

import { FC, ReactNode, createContext, useContext, useMemo } from 'react';

import { useLimitsCostFlags } from '@/client/hooks/settings/useLimitsAdmin';

import { PricingIndex, buildPricingIndex } from '@/lib/utils/app/limitsPricing';
import type { RequestProfile } from '@/lib/utils/shared/costEstimator';

import { useSettingsStore } from '@/client/stores/settingsStore';

/**
 * What the cost surfaces read (docs/LIMITS_COST_INSIGHTS_DESIGN.md §1).
 * `pricing` is `null` whenever both flags are off — the index is not even
 * built then, which is the "hidden means nothing runs" guarantee.
 */
export interface LimitsCostValue {
  /** `limitsCostInsights`: per-row annotations + the preview spend card. */
  insights: boolean;
  /** `limitsCostCalculator` (requires insights): the estimator. */
  calculator: boolean;
  /** Case-insensitive id → pricing over the served list; `null` when off. */
  pricing: PricingIndex | null;
  /** The request profile every insight surface prices at. */
  profile: RequestProfile;
}

/**
 * The default — and the value a flags-off deployment sees. Every row and
 * editor test that renders without a provider gets exactly this, so nothing
 * cost-related can leak into an existing surface.
 */
export const LIMITS_COST_OFF: LimitsCostValue = Object.freeze({
  insights: false,
  calculator: false,
  pricing: null,
  profile: 'typical',
});

const LimitsCostContext = createContext<LimitsCostValue>(LIMITS_COST_OFF);

/**
 * Mounted once in LimitsPanel around both modes. Reads the two flags and the
 * model list the admin already holds (`settingsStore.models` — pricing rides
 * on those objects, there is no fetch) and builds the pricing index inside a
 * memo ONLY when a flag is on; otherwise the value is the OFF constant.
 */
export const LimitsCostProvider: FC<{ children: ReactNode }> = ({
  children,
}) => {
  const { insights, calculator } = useLimitsCostFlags();
  const models = useSettingsStore((s) => s.models);

  const value = useMemo<LimitsCostValue>(() => {
    if (!insights && !calculator) return LIMITS_COST_OFF;
    return {
      insights,
      calculator,
      pricing: buildPricingIndex(models),
      profile: 'typical',
    };
  }, [insights, calculator, models]);

  return (
    <LimitsCostContext.Provider value={value}>
      {children}
    </LimitsCostContext.Provider>
  );
};

/** The cost gates + pricing index; `LIMITS_COST_OFF` outside a provider. */
export function useLimitsCost(): LimitsCostValue {
  return useContext(LimitsCostContext);
}
