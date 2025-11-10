import React from 'react';

import { MenuItem } from './DropdownMenuItem';
import { DropdownMenuItem } from './DropdownMenuItem';

interface DropdownCategoryGroupProps {
  category: string;
  items: MenuItem[];
  flattenedItems: MenuItem[];
  selectedIndex: number;
}

/**
 * Renders a category section in the dropdown
 */
export const DropdownCategoryGroup: React.FC<DropdownCategoryGroupProps> = ({
  category,
  items,
  flattenedItems,
  selectedIndex,
}) => {
  return (
    <div className="px-1 -my-0.5" role="group" aria-label={category}>
      {items.map((item) => {
        const itemIndex = flattenedItems.findIndex((i) => i.id === item.id);
        const isSelected = itemIndex === selectedIndex;

        return (
          <DropdownMenuItem key={item.id} item={item} isSelected={isSelected} />
        );
      })}
    </div>
  );
};
