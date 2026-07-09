import { IconChevronDown } from '@tabler/icons-react';
import React from 'react';

import { useTranslations } from 'next-intl';

import { DropdownMenuItem, MenuItem } from './DropdownMenuItem';

interface DropdownMoreSectionProps {
  items: MenuItem[];
  /** Full list in render order, for resolving each item's highlight index */
  flattenedItems: MenuItem[];
  selectedIndex: number;
  pinnedToolIds: string[];
  onTogglePin: (toolId: string) => void;
  /** Restore a tool from "More" back into the main menu. */
  onToggleHidden: (toolId: string) => void;
  expanded: boolean;
  onToggleExpanded: () => void;
}

/**
 * The terminal "More" section: a collapsible group holding the tools that are
 * hidden by default (camera, tones-with-no-tones, extract-with-no-recipes) or
 * that the user explicitly moved out of the main menu. Collapsed by default so
 * the menu stays calm; expands in place to reveal and manage those tools.
 */
export const DropdownMoreSection: React.FC<DropdownMoreSectionProps> = ({
  items,
  flattenedItems,
  selectedIndex,
  pinnedToolIds,
  onTogglePin,
  onToggleHidden,
  expanded,
  onToggleExpanded,
}) => {
  const t = useTranslations();

  if (items.length === 0) return null;

  return (
    <div
      role="group"
      aria-label={t('dropdown.sectionMore')}
      className="mt-1 pt-1 border-t border-gray-200/70 dark:border-gray-700/60"
    >
      <button
        type="button"
        onClick={onToggleExpanded}
        aria-expanded={expanded}
        className="flex items-center gap-1.5 w-full min-h-11 px-3 py-2 text-left text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 focus:outline-none rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors duration-150"
      >
        <IconChevronDown
          size={16}
          className={`flex-shrink-0 transition-transform duration-150 ${
            expanded ? 'rotate-180' : ''
          }`}
          aria-hidden="true"
        />
        <span className="truncate">{t('dropdown.sectionMore')}</span>
        <span className="ml-auto text-xs text-gray-400 dark:text-gray-500">
          {items.length}
        </span>
      </button>

      {expanded &&
        items.map((item) => {
          const itemIndex = flattenedItems.findIndex((i) => i.id === item.id);
          return (
            <DropdownMenuItem
              key={item.id}
              item={item}
              isSelected={itemIndex === selectedIndex}
              pinnable
              pinned={pinnedToolIds.includes(item.id)}
              onTogglePin={() => onTogglePin(item.id)}
              hideable
              hidden
              onToggleHidden={() => onToggleHidden(item.id)}
            />
          );
        })}
    </div>
  );
};
