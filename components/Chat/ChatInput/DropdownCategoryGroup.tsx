import React from 'react';

import { DropdownItemRows, NestingProps } from './DropdownItemRows';
import { MenuItem } from './DropdownMenuItem';

interface DropdownCategoryGroupProps extends NestingProps {
  /**
   * Group name. No longer rendered as a visible heading — grouping is implicit
   * (ordering + a hairline separator). Kept as the group's `aria-label` so the
   * structure is still announced to screen readers.
   */
  label: string;
  items: MenuItem[];
  /** Full list in render order, for resolving each item's highlight index */
  flattenedItems: MenuItem[];
  selectedIndex: number;
  pinnedToolIds: string[];
  onTogglePin: (toolId: string) => void;
  /** Move a (currently visible) tool into the "More" section. */
  onToggleHidden?: (toolId: string) => void;
  /** First group renders flush; later groups get a top separator. */
  isFirst?: boolean;
}

/**
 * Renders one section of the dropdown (a category, Pinned, or Frequently
 * used). Sections are grouped implicitly: no title, just item ordering and a
 * subtle divider between adjacent groups. The name survives as `aria-label`.
 */
export const DropdownCategoryGroup: React.FC<DropdownCategoryGroupProps> = ({
  label,
  items,
  flattenedItems,
  selectedIndex,
  pinnedToolIds,
  onTogglePin,
  onToggleHidden,
  isFirst = false,
  childrenByParent,
  expandedParentIds,
  onToggleParentExpanded,
}) => {
  if (items.length === 0) return null;

  return (
    <div
      role="group"
      aria-label={label}
      className={
        isFirst
          ? undefined
          : 'mt-1 pt-1 border-t border-gray-200/70 dark:border-gray-700/60'
      }
    >
      <DropdownItemRows
        items={items}
        flattenedItems={flattenedItems}
        selectedIndex={selectedIndex}
        pinnedToolIds={pinnedToolIds}
        onTogglePin={onTogglePin}
        onToggleHidden={onToggleHidden}
        childrenByParent={childrenByParent}
        expandedParentIds={expandedParentIds}
        onToggleParentExpanded={onToggleParentExpanded}
      />
    </div>
  );
};
