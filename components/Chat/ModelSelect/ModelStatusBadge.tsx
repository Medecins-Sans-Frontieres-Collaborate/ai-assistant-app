import { FC } from 'react';

interface ModelStatusBadgeProps {
  label: string;
  /**
   * Plain-prose explanation shown as a tooltip. Required: a badge without
   * prose context is decoration, not information (DESIGN.md badge rule).
   */
  tooltip: string;
}

/**
 * Neutral slate status badge for model cards (region hosting, external
 * hosting). Follows the design system's badge vocabulary: micro type, tinted
 * background, mandatory tooltip. Informative, never a warning — warning
 * semantics belong to the amber/red variants elsewhere.
 */
export const ModelStatusBadge: FC<ModelStatusBadgeProps> = ({
  label,
  tooltip,
}) => (
  <span
    title={tooltip}
    aria-label={tooltip}
    className="shrink-0 rounded-sm bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium leading-tight text-gray-700 dark:bg-gray-800 dark:text-gray-300"
  >
    {label}
  </span>
);
