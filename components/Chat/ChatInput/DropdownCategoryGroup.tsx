import React from 'react';

import { DropdownMenuItem, MenuItem } from './DropdownMenuItem';

interface DropdownCategoryGroupProps {
  /** Translated section heading */
  label: string;
  items: MenuItem[];
  /** Full list in render order, for resolving each item's highlight index */
  flattenedItems: MenuItem[];
  selectedIndex: number;
  pinnedToolIds: string[];
  onTogglePin: (toolId: string) => void;
}

/**
 * Renders a labeled section of the dropdown (a category, Pinned, or
 * Frequently used). Header markup mirrors ModelSelect's section titles.
 */
export const DropdownCategoryGroup: React.FC<DropdownCategoryGroupProps> = ({
  label,
  items,
  flattenedItems,
  selectedIndex,
  pinnedToolIds,
  onTogglePin,
}) => {
  if (items.length === 0) return null;

  return (
    <div role="group" aria-label={label}>
      <h4 className="px-3 pt-2 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {label}
      </h4>
      {items.map((item) => {
        const itemIndex = flattenedItems.findIndex((i) => i.id === item.id);
        return (
          <DropdownMenuItem
            key={item.id}
            item={item}
            isSelected={itemIndex === selectedIndex}
            pinnable
            pinned={pinnedToolIds.includes(item.id)}
            onTogglePin={() => onTogglePin(item.id)}
          />
        );
      })}
    </div>
  );
};
