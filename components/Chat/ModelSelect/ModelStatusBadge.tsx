import { FC } from 'react';

interface ModelStatusBadgeProps {
  label: string;
  /**
   * Plain-prose explanation shown as a tooltip. Required: a badge without
   * prose context is decoration, not information (DESIGN.md badge rule).
   */
  tooltip: string;
  /**
   * `warning` is for a state the user should act on before choosing the
   * model (it is being retired). Default `neutral`.
   */
  tone?: 'neutral' | 'warning';
}

/**
 * Status badge for model cards. Follows the design system's badge
 * vocabulary: micro type, tinted background, mandatory tooltip. Neutral
 * slate by default (region hosting, external hosting — informative, never
 * a warning); the amber `warning` tone marks a model that is being retired.
 */
export const ModelStatusBadge: FC<ModelStatusBadgeProps> = ({
  label,
  tooltip,
  tone = 'neutral',
}) => (
  <span
    title={tooltip}
    aria-label={tooltip}
    className={`shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-medium leading-tight ${
      tone === 'warning'
        ? 'bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200'
        : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
    }`}
  >
    {label}
  </span>
);
