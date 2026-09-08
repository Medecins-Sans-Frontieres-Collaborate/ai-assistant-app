import {
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconStar,
  IconStarFilled,
  IconTrash,
} from '@tabler/icons-react';
import { FC, ReactNode, useState } from 'react';

import { ModelAvailabilityView } from '@/client/hooks/settings/useMyLimits';

import {
  LowRemainingPill,
  ModelLimitBadge,
  useModelLimitCopy,
} from './ModelSelect/ModelLimitBadge';

interface ModelCardProps {
  id: string;
  name: string;
  isSelected: boolean;
  onClick: () => void;
  icon?: ReactNode;
  badge?: ReactNode;
  /** One-liner shown under the name to help users decide. */
  tagline?: string;
  /** Show up/down reorder controls */
  showReorderControls?: boolean;
  /** Whether the model can be moved up */
  canMoveUp?: boolean;
  /** Whether the model can be moved down */
  canMoveDown?: boolean;
  /** Callback when move up is clicked */
  onMoveUp?: () => void;
  /** Callback when move down is clicked */
  onMoveDown?: () => void;
  /** When provided, renders a hover/focus-revealed trash button to hide this item. */
  onHide?: () => void;
  /** Accessible label for the hide (trash) button. */
  hideLabel?: string;
  /** Whether this model is starred (filled star, always visible). */
  starred?: boolean;
  /** When provided, renders a star toggle (hover-revealed unless starred). */
  onToggleStar?: () => void;
  /** Accessible label for the star toggle in its current state. */
  starLabel?: string;
  /**
   * The caller's usage-limit verdict for this model. Anything but
   * `available` renders the row dimmed and `aria-disabled` with a clock
   * badge; a click then only reveals the explanation (inline, so touch
   * users get it too) and never fires `onClick`. Omitted = today's row.
   */
  limit?: ModelAvailabilityView;
  /** Fired when the limit's reset time passes while the row is mounted. */
  onLimitExpired?: () => void;
  /**
   * Fired (in addition to the inline note toggle) when a limited row is
   * tapped. `ModelSelect` wires this to open the mobile details view for a
   * row fronting the CURRENT model — the family's Version/Variant switchers
   * live there and are otherwise unreachable on mobile once the row itself
   * is grayed (docs/LIMITS_USER_FACING_UX.md §7.4).
   */
  onLimitedTap?: () => void;
}

/**
 * Reusable model card component
 * Used in ModelSelect for both base models and custom agents
 */
export const ModelCard: FC<ModelCardProps> = ({
  id,
  name,
  isSelected,
  onClick,
  icon,
  badge,
  tagline,
  showReorderControls = false,
  canMoveUp = false,
  canMoveDown = false,
  onMoveUp,
  onMoveDown,
  onHide,
  hideLabel,
  starred = false,
  onToggleStar,
  starLabel,
  limit,
  onLimitExpired,
  onLimitedTap,
}) => {
  const limitView: ModelAvailabilityView = limit ?? { state: 'available' };
  const isLimited = limitView.state !== 'available';
  const limitCopy = useModelLimitCopy(limitView, { onExpired: onLimitExpired });
  // Touch has no hover, so the first tap on a grayed row prints the tooltip
  // text under the name; a second tap folds it away again.
  const [showLimitNote, setShowLimitNote] = useState(false);

  return (
    <div
      key={id}
      className={`
        group w-full text-left px-3 py-1.5 rounded-lg transition-all duration-150 flex items-center gap-2
        ${
          isSelected
            ? 'bg-blue-50 dark:bg-blue-900/20 border-2 border-blue-300 dark:border-blue-600'
            : 'bg-white dark:bg-surface-dark border-2 border-transparent hover:border-gray-200 dark:hover:border-gray-700'
        }
        ${isLimited ? 'opacity-60' : ''}
      `}
    >
      {/* Reorder controls */}
      {showReorderControls && (
        <div className="flex flex-col -my-1">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onMoveUp?.();
            }}
            disabled={!canMoveUp}
            className={`p-1.5 rounded transition-colors ${
              canMoveUp
                ? 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700'
                : 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
            }`}
            aria-label="Move up"
          >
            <IconChevronUp size={16} />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onMoveDown?.();
            }}
            disabled={!canMoveDown}
            className={`p-1.5 rounded transition-colors ${
              canMoveDown
                ? 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700'
                : 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
            }`}
            aria-label="Move down"
          >
            <IconChevronDown size={16} />
          </button>
        </div>
      )}

      {/* Main clickable area. A limited row keeps a real button (it stays
          focusable and readable) but is aria-disabled: the click reveals
          the reason instead of selecting. */}
      <button
        type="button"
        onClick={
          isLimited
            ? () => {
                setShowLimitNote((v) => !v);
                onLimitedTap?.();
              }
            : onClick
        }
        aria-disabled={isLimited || undefined}
        title={isLimited ? (limitCopy ?? undefined) : undefined}
        className={`flex-1 flex items-center justify-between text-left min-h-[40px] gap-2 ${
          isLimited ? 'cursor-not-allowed' : ''
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          {icon}
          <div className="flex flex-col min-w-0 leading-tight">
            <div className="flex items-center gap-1.5">
              <span className="font-medium text-sm text-gray-900 dark:text-white truncate">
                {name}
              </span>
              {badge}
              {/* onExpired lives on the copy hook above, not here — two
                  countdowns would refetch twice per boundary. */}
              <ModelLimitBadge view={limitView} />
              <LowRemainingPill view={limitView} />
            </div>
            {tagline && (
              <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
                {tagline}
              </span>
            )}
            {isLimited && showLimitNote && limitCopy && (
              <span
                role="note"
                data-testid="model-limit-note"
                className="text-xs text-amber-700 dark:text-amber-400"
              >
                {limitCopy}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isSelected && (
            <IconCheck size={16} className="text-blue-600 dark:text-blue-400" />
          )}
        </div>
      </button>

      {/* Star toggle — always visible when starred, hover/focus-revealed when
          not, so the list stays quiet but starred state is never hidden. */}
      {onToggleStar && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleStar();
          }}
          aria-label={starLabel}
          aria-pressed={starred}
          title={starLabel}
          className={`shrink-0 p-1.5 rounded transition-opacity hover:bg-gray-100 dark:hover:bg-gray-700 ${
            starred
              ? 'text-blue-600 dark:text-blue-400'
              : 'text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100'
          }`}
        >
          {starred ? <IconStarFilled size={16} /> : <IconStar size={16} />}
        </button>
      )}

      {/* Hide (trash) — revealed on row hover/focus; tap-reachable on touch */}
      {onHide && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onHide();
          }}
          aria-label={hideLabel}
          title={hideLabel}
          className="shrink-0 p-1.5 rounded text-gray-400 hover:text-red-600 dark:text-gray-500 dark:hover:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-700 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100 transition-opacity"
        >
          <IconTrash size={16} />
        </button>
      )}
    </div>
  );
};
