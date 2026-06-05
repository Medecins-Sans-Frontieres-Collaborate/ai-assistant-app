'use client';

import {
  IconArrowsSort,
  IconCheck,
  IconChevronDown,
  IconPencil,
  IconRefresh,
} from '@tabler/icons-react';
import { FC, useEffect, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { Tooltip } from '@/components/UI/Tooltip';

import { ModelOrderMode } from '@/client/stores/settingsStore';

interface ModelOrderControlsProps {
  /** Current order mode */
  orderMode: ModelOrderMode;
  /** Callback when order mode changes */
  onOrderModeChange: (mode: ModelOrderMode) => void;
  /** Callback when reset is clicked */
  onReset: () => void;
  /** Whether edit mode is active */
  isEditing: boolean;
  /** Callback to toggle edit mode */
  onToggleEdit: () => void;
}

/**
 * Controls for selecting model order mode in the model selection UI.
 * Provides a dropdown for sort selection, an edit button for custom ordering,
 * and a reset button visible only when editing.
 */
export const ModelOrderControls: FC<ModelOrderControlsProps> = ({
  orderMode,
  onOrderModeChange,
  onReset,
  isEditing,
  onToggleEdit,
}) => {
  const t = useTranslations('modelSelect.orderMode');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsDropdownOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const modes: { id: ModelOrderMode; label: string }[] = [
    { id: 'usage', label: t('usage') },
    { id: 'name', label: t('name') },
    { id: 'cutoff', label: t('cutoff') },
    { id: 'custom', label: t('custom') },
  ];

  const currentModeLabel =
    modes.find((m) => m.id === orderMode)?.label ?? t('usage');

  const handleModeSelect = (mode: ModelOrderMode) => {
    onOrderModeChange(mode);
    setIsDropdownOpen(false);
  };

  return (
    <div className="flex items-center gap-1">
      {/* Sort Dropdown */}
      <Tooltip content={t('label')} position="bottom">
        <div className="relative" ref={dropdownRef}>
          <button
            type="button"
            onClick={() => setIsDropdownOpen(!isDropdownOpen)}
            className="flex items-center gap-1 px-1.5 py-1 text-xs font-medium rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-750 transition-colors"
          >
            <IconArrowsSort size={14} className="flex-shrink-0" />
            <span className="hidden sm:inline">{currentModeLabel}</span>
            <IconChevronDown
              size={12}
              className={`transition-transform ${isDropdownOpen ? 'rotate-180' : ''}`}
            />
          </button>

          {isDropdownOpen && (
            <div className="absolute right-0 z-10 mt-1 w-36 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg">
              {modes.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  onClick={() => handleModeSelect(mode.id)}
                  className={`
                    w-full px-3 py-1.5 text-xs text-left transition-colors
                    ${
                      orderMode === mode.id
                        ? 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white'
                        : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-750'
                    }
                  `}
                >
                  {mode.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </Tooltip>

      {/* Edit/Done button - icon only */}
      <Tooltip content={isEditing ? t('done') : t('edit')} position="bottom">
        <button
          type="button"
          onClick={onToggleEdit}
          className={`
            p-1.5 rounded transition-colors
            ${
              isEditing
                ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700'
            }
          `}
        >
          {isEditing ? <IconCheck size={14} /> : <IconPencil size={14} />}
        </button>
      </Tooltip>

      {/* Reset button - icon only, visible when editing */}
      {isEditing && (
        <Tooltip content={t('resetTooltip')} position="bottom">
          <button
            type="button"
            onClick={onReset}
            className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
          >
            <IconRefresh size={14} />
          </button>
        </Tooltip>
      )}
    </div>
  );
};
