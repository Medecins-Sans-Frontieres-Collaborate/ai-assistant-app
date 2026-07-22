import { IconLeaf } from '@tabler/icons-react';
import { FC } from 'react';

import { EmissionsTier } from '@/lib/utils/shared/emissions';

/** Tier → text color, shared with the details-panel estimate line. */
export const TIER_TEXT_CLASSES: Record<EmissionsTier, string> = {
  low: 'text-green-600 dark:text-green-400',
  moderate: 'text-amber-600 dark:text-amber-400',
  high: 'text-orange-600 dark:text-orange-400',
};

interface EmissionsTierIconProps {
  tier: EmissionsTier;
  /**
   * Localized tier label + estimate caveat, shown on hover. Required: an
   * icon without prose context is decoration, not information (DESIGN.md
   * badge rule) — and doubly so here, where the value is an estimate from
   * assumptions.
   */
  tooltip: string;
  /**
   * Inherit the surrounding text color instead of the tier color — for
   * active (solid-blue) picker segments where tier colors don't read.
   */
  muted?: boolean;
}

/**
 * Icon-only relative environmental-impact marker for the variant/version
 * pickers. Tier is derived from the model's size class (see
 * getEmissionsTier); callers should render it only where the choice at hand
 * actually differs in tier — a uniform row of leaves is noise.
 */
export const EmissionsTierIcon: FC<EmissionsTierIconProps> = ({
  tier,
  tooltip,
  muted = false,
}) => (
  <span
    title={tooltip}
    aria-label={tooltip}
    role="img"
    className={`ms-1 inline-flex cursor-help align-[-2px] ${
      muted ? 'opacity-80' : TIER_TEXT_CLASSES[tier]
    }`}
  >
    <IconLeaf size={12} aria-hidden="true" />
  </span>
);
