import {
  IconCheck,
  IconChevronRight,
  IconInfoCircle,
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
}

interface DropdownMenuItemProps {
  item: MenuItem;
  isSelected: boolean;
  pinnable?: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
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
}) => {
  const t = useTranslations();
  const [showInfo, setShowInfo] = useState(false);
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
        className={`flex items-center gap-2.5 flex-1 min-w-0 px-3 py-2 text-left text-sm focus:outline-none ${
          item.disabled ? 'cursor-not-allowed' : ''
        }`}
        onClick={item.disabled ? undefined : item.onClick}
        role={item.toggle ? 'menuitemcheckbox' : 'menuitem'}
        aria-current={isSelected ? 'true' : undefined}
        aria-checked={item.toggle ? Boolean(item.checked) : undefined}
        aria-disabled={item.disabled ? 'true' : undefined}
        tabIndex={isSelected ? 0 : -1}
        disabled={item.disabled}
      >
        {item.icon}
        <span className="truncate">{item.label}</span>
      </button>

      <div className="flex items-center gap-0.5 flex-shrink-0 pr-2">
        {/* Intent affordance: on-state mark for toggles, chevron for dialogs */}
        {item.toggle && item.checked && (
          <IconCheck size={16} className="text-blue-500" aria-hidden="true" />
        )}
        {item.opensDialog && !item.toggle && (
          <IconChevronRight
            size={16}
            className="text-gray-400 dark:text-gray-500"
            aria-hidden="true"
          />
        )}

        {pinnable && onTogglePin && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin();
            }}
            aria-label={pinned ? t('dropdown.unpin') : t('dropdown.pin')}
            aria-pressed={pinned}
            className={`p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-opacity ${
              pinned
                ? 'opacity-100 text-blue-500'
                : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100'
            }`}
          >
            {pinned ? (
              <IconPinnedFilled size={16} />
            ) : (
              <IconPinnedOff size={16} />
            )}
          </button>
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
