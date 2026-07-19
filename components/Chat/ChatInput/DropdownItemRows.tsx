import React from 'react';

import { DropdownMenuItem, MenuItem } from './DropdownMenuItem';

export interface NestingProps {
  /** Nested children keyed by parent id, in render order. */
  childrenByParent?: Record<string, MenuItem[]>;
  expandedParentIds?: string[];
  onToggleParentExpanded?: (parentId: string) => void;
}

interface DropdownItemRowsProps extends NestingProps {
  items: MenuItem[];
  /** Full list in render order, for resolving each row's highlight index. */
  flattenedItems: MenuItem[];
  selectedIndex: number;
  pinnedToolIds: string[];
  onTogglePin: (toolId: string) => void;
  onToggleHidden?: (toolId: string) => void;
  /** Rows in the "More" section report themselves as already hidden. */
  hidden?: boolean;
}

/**
 * Renders a run of menu rows, expanding any row that owns nested children into
 * parent + indented children. Shared by every section of the dropdown so the
 * nesting behaves identically in Pinned, a category, or More.
 *
 * Children are kept in the same flat `flattenedItems` list as their parent, so
 * keyboard navigation stays linear — arrowing down off a parent walks into its
 * children exactly as the "More" section already works.
 */
export const DropdownItemRows: React.FC<DropdownItemRowsProps> = ({
  items,
  flattenedItems,
  selectedIndex,
  pinnedToolIds,
  onTogglePin,
  onToggleHidden,
  hidden = false,
  childrenByParent,
  expandedParentIds,
  onToggleParentExpanded,
}) => {
  const indexOf = (id: string) => flattenedItems.findIndex((i) => i.id === id);

  return (
    <>
      {items.map((item) => {
        const children = childrenByParent?.[item.id] ?? [];
        const expandable =
          children.length > 0 && Boolean(onToggleParentExpanded);
        const expanded = Boolean(expandedParentIds?.includes(item.id));

        return (
          <React.Fragment key={item.id}>
            <DropdownMenuItem
              item={item}
              isSelected={indexOf(item.id) === selectedIndex}
              pinnable
              pinned={pinnedToolIds.includes(item.id)}
              onTogglePin={() => onTogglePin(item.id)}
              hideable={Boolean(onToggleHidden)}
              hidden={hidden}
              onToggleHidden={
                onToggleHidden ? () => onToggleHidden(item.id) : undefined
              }
              expandable={expandable}
              expanded={expanded}
              onToggleExpanded={
                expandable && onToggleParentExpanded
                  ? () => onToggleParentExpanded(item.id)
                  : undefined
              }
            />

            {expandable && (
              <div
                id={`dropdown-children-${item.id}`}
                role="group"
                aria-label={item.label}
              >
                {expanded &&
                  children.map((child) => (
                    <DropdownMenuItem
                      key={child.id}
                      item={child}
                      nested
                      isSelected={indexOf(child.id) === selectedIndex}
                      pinnable
                      pinned={pinnedToolIds.includes(child.id)}
                      onTogglePin={() => onTogglePin(child.id)}
                      hideable={Boolean(onToggleHidden)}
                      hidden={hidden}
                      onToggleHidden={
                        onToggleHidden
                          ? () => onToggleHidden(child.id)
                          : undefined
                      }
                    />
                  ))}
              </div>
            )}
          </React.Fragment>
        );
      })}
    </>
  );
};
