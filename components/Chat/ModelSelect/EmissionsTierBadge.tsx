import { IconLeaf } from '@tabler/icons-react';
import { FC } from 'react';

import { EmissionsTier } from '@/lib/utils/shared/emissions';

interface EmissionsTierBadgeProps {
  tier: EmissionsTier;
  /** Localized tier label ("Lower impact" …). */
  label: string;
  /**
   * Plain-prose explanation shown as a tooltip. Required: a badge without
   * prose context is decoration, not information (DESIGN.md badge rule) —
   * and doubly so here, where the value is an estimate from assumptions.
   */
  tooltip: string;
}

const TIER_CLASSES: Record<EmissionsTier, string> = {
  low: 'bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-300',
  moderate:
    'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  high: 'bg-orange-100 text-orange-800 dark:bg-orange-500/15 dark:text-orange-300',
};

/**
 * Relative environmental-impact badge for model cards. Tier is derived from
 * the model's size class (see getEmissionsTier) — an estimate, which the
 * mandatory tooltip states explicitly.
 */
export const EmissionsTierBadge: FC<EmissionsTierBadgeProps> = ({
  tier,
  label,
  tooltip,
}) => (
  <span
    title={tooltip}
    aria-label={tooltip}
    className={`shrink-0 inline-flex items-center gap-0.5 rounded-sm px-1.5 py-0.5 text-[10px] font-medium leading-tight cursor-help ${TIER_CLASSES[tier]}`}
  >
    <IconLeaf size={11} aria-hidden="true" />
    {label}
  </span>
);
