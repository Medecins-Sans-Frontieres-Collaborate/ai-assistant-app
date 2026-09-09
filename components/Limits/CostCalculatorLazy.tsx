'use client';

import dynamic from 'next/dynamic';

/**
 * The estimator, loaded on demand. A flags-off deployment (the default and
 * prod's posture, docs/LIMITS_COST_INSIGHTS_DESIGN.md §1) never imports the
 * calculator bundle: both mounting points render this only when
 * `useLimitsCost().calculator` is true, and the scoped card additionally
 * waits until it is expanded.
 */
export const CostCalculatorLazy = dynamic(
  () =>
    import('@/components/Limits/CostCalculator').then((mod) => ({
      default: mod.CostCalculator,
    })),
  { ssr: false },
);
