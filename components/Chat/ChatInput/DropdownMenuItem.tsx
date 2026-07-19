import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconEye,
  IconEyeOff,
  IconInfoCircle,
  IconPinned,
  IconPinnedFilled,
  IconPinnedOff,
} from '@tabler/icons-react';
import React, { useState } from 'react';
import { createPortal } from 'react-dom';

import { useTranslations } from 'next-intl';

export interface MenuItem {
  id: string;
  icon: React.ReactNode;
  label: string;
  tooltip?: string;
  infoTooltip?: string;
  onClick: () => void;
  category: 'web' | 'media' | 'transform';
  disabled?: boolean;
  toggle?: boolean;
  checked?: boolean;
  /** Clicking opens a dialog / picker / capture flow (shows a trailing chevron) */
  opensDialog?: boolean;
  /**
   * Groups this item under another tool as an alternate way of doing the same
   * job (e.g. `attach-link` under `attach`). The parent keeps its own action —
   * the child is an additional source, not a replacement. Nesting is one level
   * deep and purely presentational: the child keeps its own id, pin state, and
   * usage count, and renders as a normal flat row whenever it is pinned,
   * frequently used, or matched by a search query.
   */
  parentId?: string;
}

interface DropdownMenuItemProps {
  item: MenuItem;
  isSelected: boolean;
  pinnable?: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
  /** Whether this row offers a "move to More" (hide) control. */
  hideable?: boolean;
  /** Whether this tool currently lives in the "More" section. */
  hidden?: boolean;
  onToggleHidden?: () => void;
  /** This row owns nested children and renders an expand/collapse control. */
  expandable?: boolean;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  /** This row is a nested child; indents it under its parent. */
  nested?: boolean;
}

/**
 * Individual menu item in the dropdown.
 *
 * The row is a flex container rather than a single <button> so the pin control
 * can be a real (nested-button-free) button alongside the activating area.
 */
export const DropdownMenuItem: React.FC<DropdownMenuItemProps> = ({
  item,
  isSelected,
  pinnable = false,
  pinned = false,
  onTogglePin,
  hideable = false,
  hidden = false,
  onToggleHidden,
  expandable = false,
  expanded = false,
  onToggleExpanded,
  nested = false,
}) => {
  const t = useTranslations();
  const [showInfo, setShowInfo] = useState(false);
  // Hover the pin button previews the *resulting* state so the action (pin vs.
  // unpin) is legible, not just the current state.
  const [pinHover, setPinHover] = useState(false);
  const infoIconRef = React.useRef<HTMLDivElement>(null);
  const timeoutRef = React.useRef<NodeJS.Timeout | undefined>(undefined);
  const [tooltipPos, setTooltipPos] = React.useState({ left: 0, top: 0 });

  const handleMouseEnter = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    if (infoIconRef.current) {
      const rect = infoIconRef.current.getBoundingClientRect();
      setTooltipPos({
        left: rect.right + 8,
        top: rect.top - 8,
      });
    }
    setShowInfo(true);
  };

  const handleMouseLeave = () => {
    timeoutRef.current = setTimeout(() => {
      setShowInfo(false);
    }, 150);
  };

  React.useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return (
    <div
      className={`group relative flex items-center min-h-11 rounded-md transition-colors duration-150 ${
        item.disabled
          ? 'opacity-50 text-gray-500 dark:text-gray-500'
          : isSelected
            ? 'bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200'
            : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-800 dark:text-gray-200'
      }`}
    >
      <button
        id={`dropdown-item-${item.id}`}
        data-item-id={item.id}
        className={`flex items-center gap-2.5 flex-1 min-w-0 py-2 pr-3 text-left text-sm focus:outline-none ${
          nested ? 'pl-9' : 'pl-3'
        } ${item.disabled ? 'cursor-not-allowed' : ''}`}
        onClick={item.disabled ? undefined : item.onClick}
        role={item.toggle ? 'menuitemcheckbox' : 'menuitem'}
        aria-current={isSelected ? 'true' : undefined}
        aria-checked={item.toggle ? Boolean(item.checked) : undefined}
        aria-disabled={item.disabled ? 'true' : undefined}
        tabIndex={isSelected ? 0 : -1}
        disabled={item.disabled}
      >
        {item.icon}
        <span className="truncate" title={item.label}>
          {item.label}
        </span>
      </button>

      <div className="relative self-stretch flex items-center gap-0.5 flex-shrink-0 pr-2">
        {/* Hover-revealed controls are overlaid on the label's tail rather than
            held in flow. Reserving their width permanently clipped labels on
            every row — and at 33 locales the long ones ("Audio/Video
            transkribieren") have nothing to spare. Pinned / hidden rows keep
            them visible, since there the state is the information. */}
        {((hideable && onToggleHidden) || (pinnable && onTogglePin)) && (
          <div
            className={`absolute right-full top-0 bottom-0 flex items-center gap-0.5 pl-6 rounded-md transition-opacity duration-150 motion-reduce:transition-none ${
              isSelected
                ? 'bg-gray-100 dark:bg-gray-700'
                : 'bg-white dark:bg-gray-800 group-hover:bg-gray-100 dark:group-hover:bg-gray-700'
            } ${
              pinned || hidden
                ? 'opacity-100'
                : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto'
            }`}
          >
            {hideable && onToggleHidden && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleHidden();
                }}
                title={
                  hidden
                    ? t('dropdown.moveOutOfMore')
                    : t('dropdown.moveToMore')
                }
                aria-label={
                  hidden
                    ? t('dropdown.moveOutOfMore')
                    : t('dropdown.moveToMore')
                }
                aria-pressed={hidden}
                className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
              >
                {hidden ? <IconEye size={16} /> : <IconEyeOff size={16} />}
              </button>
            )}

            {pinnable && onTogglePin && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onTogglePin();
                }}
                onMouseEnter={() => setPinHover(true)}
                onMouseLeave={() => setPinHover(false)}
                onFocus={() => setPinHover(true)}
                onBlur={() => setPinHover(false)}
                title={pinned ? t('dropdown.unpin') : t('dropdown.pin')}
                aria-label={pinned ? t('dropdown.unpin') : t('dropdown.pin')}
                aria-pressed={pinned}
                className={`p-1 rounded ${
                  pinned
                    ? 'text-blue-500'
                    : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-200'
                }`}
              >
                {/* Show the resulting state on hover: an unpinned item previews
                    the filled pin; a pinned item previews the pin-off. */}
                {pinned ? (
                  pinHover ? (
                    <IconPinnedOff size={16} />
                  ) : (
                    <IconPinnedFilled size={16} />
                  )
                ) : pinHover ? (
                  <IconPinnedFilled size={16} />
                ) : (
                  <IconPinned size={16} />
                )}
              </button>
            )}
          </div>
        )}

        {/* Intent affordance: on-state mark for toggles, chevron for dialogs */}
        {item.toggle && item.checked && (
          <IconCheck size={16} className="text-blue-500" aria-hidden="true" />
        )}
        {item.opensDialog && !item.toggle && !expandable && (
          <IconChevronRight
            size={16}
            className="text-gray-400 dark:text-gray-500"
            aria-hidden="true"
          />
        )}

        {item.infoTooltip && (
          <div
            ref={infoIconRef}
            className="relative z-10"
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            onClick={(e) => {
              e.stopPropagation();
              handleMouseEnter();
            }}
          >
            <IconInfoCircle
              size={16}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-help"
            />
          </div>
        )}

        {/* Disclosure for nested sources. Always visible (unlike pin/hide,
            which are hover-revealed) — it is the only cue that the row has
            alternatives behind it. */}
        {expandable && onToggleExpanded && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpanded();
            }}
            aria-expanded={expanded}
            aria-controls={`dropdown-children-${item.id}`}
            title={
              expanded ? t('dropdown.hideSources') : t('dropdown.showSources')
            }
            aria-label={
              expanded ? t('dropdown.hideSources') : t('dropdown.showSources')
            }
            className="px-2.5 py-3 -mr-1 rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-200/70 dark:hover:bg-gray-600/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 transition-colors duration-150"
          >
            <IconChevronDown
              size={16}
              className={`transition-transform duration-150 motion-reduce:transition-none ${
                expanded ? 'rotate-180' : ''
              }`}
              aria-hidden="true"
            />
          </button>
        )}
      </div>

      {item.infoTooltip &&
        showInfo &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed bg-gray-900 dark:bg-gray-800 text-white text-xs py-2 px-3 rounded-lg shadow-xl w-64 z-[10003] whitespace-pre-line border border-gray-700"
            style={{
              left: `${tooltipPos.left}px`,
              top: `${tooltipPos.top}px`,
            }}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
          >
            {item.infoTooltip}
          </div>,
          document.body,
        )}
    </div>
  );
};
