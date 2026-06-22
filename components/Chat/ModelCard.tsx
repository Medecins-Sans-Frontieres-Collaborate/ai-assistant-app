import {
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconTrash,
} from '@tabler/icons-react';
import { FC, ReactNode } from 'react';

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
}) => {
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

      {/* Main clickable area */}
      <button
        type="button"
        onClick={onClick}
        className="flex-1 flex items-center justify-between text-left min-h-[40px] gap-2"
      >
        <div className="flex items-center gap-2 min-w-0">
          {icon}
          <div className="flex flex-col min-w-0 leading-tight">
            <div className="flex items-center gap-1.5">
              <span className="font-medium text-sm text-gray-900 dark:text-white truncate">
                {name}
              </span>
              {badge}
            </div>
            {tagline && (
              <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
                {tagline}
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
