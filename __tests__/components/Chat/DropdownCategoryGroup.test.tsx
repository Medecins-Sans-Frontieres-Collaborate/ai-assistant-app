import { render, screen } from '@testing-library/react';
import React from 'react';

import { DropdownCategoryGroup } from '@/components/Chat/ChatInput/DropdownCategoryGroup';
import { MenuItem } from '@/components/Chat/ChatInput/DropdownMenuItem';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

// Mock DropdownMenuItem to isolate testing
vi.mock('@/components/Chat/ChatInput/DropdownMenuItem', () => ({
  DropdownMenuItem: ({ item, isSelected, pinned }: any) => (
    <div
      data-testid={`menu-item-${item.id}`}
      data-selected={isSelected}
      data-pinned={pinned}
    >
      {item.label}
    </div>
  ),
  MenuItem: {} as any, // Export type mock
}));

describe('DropdownCategoryGroup', () => {
  const TestIcon = () => <svg data-testid="test-icon">Icon</svg>;

  const createMenuItem = (
    id: string,
    label: string,
    category: 'web' | 'media' | 'transform' = 'web',
  ): MenuItem => ({
    id,
    icon: <TestIcon />,
    label,
    tooltip: `${label} tooltip`,
    onClick: vi.fn(),
    category,
  });

  const renderGroup = (
    props: Partial<React.ComponentProps<typeof DropdownCategoryGroup>> & {
      label: string;
      items: MenuItem[];
      flattenedItems: MenuItem[];
      selectedIndex: number;
    },
  ) =>
    render(
      <DropdownCategoryGroup
        pinnedToolIds={[]}
        onTogglePin={vi.fn()}
        {...props}
      />,
    );

  describe('Rendering', () => {
    it('renders all items in category', () => {
      const items = [
        createMenuItem('item1', 'Item 1'),
        createMenuItem('item2', 'Item 2'),
        createMenuItem('item3', 'Item 3'),
      ];

      renderGroup({
        label: 'Media & files',
        items,
        flattenedItems: items,
        selectedIndex: 0,
      });

      expect(screen.getByTestId('menu-item-item1')).toBeInTheDocument();
      expect(screen.getByTestId('menu-item-item2')).toBeInTheDocument();
      expect(screen.getByTestId('menu-item-item3')).toBeInTheDocument();
    });

    it('renders the section header label', () => {
      const items = [createMenuItem('item1', 'Item 1')];
      renderGroup({
        label: 'Frequently used',
        items,
        flattenedItems: items,
        selectedIndex: 0,
      });

      expect(
        screen.getByRole('heading', { name: 'Frequently used' }),
      ).toBeInTheDocument();
    });

    it('renders nothing for an empty group', () => {
      const { container } = renderGroup({
        label: 'Transform',
        items: [],
        flattenedItems: [],
        selectedIndex: 0,
      });

      expect(screen.queryByTestId(/menu-item-/)).not.toBeInTheDocument();
      expect(container.firstChild).toBeNull();
    });
  });

  describe('Selection State', () => {
    it('marks first item as selected when selectedIndex is 0', () => {
      const items = [
        createMenuItem('item1', 'Item 1'),
        createMenuItem('item2', 'Item 2'),
      ];

      renderGroup({
        label: 'Web',
        items,
        flattenedItems: items,
        selectedIndex: 0,
      });

      expect(screen.getByTestId('menu-item-item1')).toHaveAttribute(
        'data-selected',
        'true',
      );
      expect(screen.getByTestId('menu-item-item2')).toHaveAttribute(
        'data-selected',
        'false',
      );
    });

    it('marks correct item as selected based on flattenedItems index', () => {
      const items = [
        createMenuItem('item1', 'Item 1'),
        createMenuItem('item2', 'Item 2'),
      ];

      renderGroup({
        label: 'Web',
        items,
        flattenedItems: items,
        selectedIndex: 1,
      });

      expect(screen.getByTestId('menu-item-item1')).toHaveAttribute(
        'data-selected',
        'false',
      );
      expect(screen.getByTestId('menu-item-item2')).toHaveAttribute(
        'data-selected',
        'true',
      );
    });

    it('handles selection across multiple categories', () => {
      const categoryItems = [createMenuItem('media1', 'Media Item')];
      const allItems = [
        createMenuItem('web1', 'Web Item'),
        createMenuItem('web2', 'Web Item 2'),
        createMenuItem('media1', 'Media Item'), // index 2 in flattened
      ];

      renderGroup({
        label: 'Media & files',
        items: categoryItems,
        flattenedItems: allItems,
        selectedIndex: 2,
      });

      expect(screen.getByTestId('menu-item-media1')).toHaveAttribute(
        'data-selected',
        'true',
      );
    });

    it('handles no selection when selectedIndex is out of bounds', () => {
      const items = [createMenuItem('item1', 'Item 1')];

      renderGroup({
        label: 'Web',
        items,
        flattenedItems: items,
        selectedIndex: 10,
      });

      expect(screen.getByTestId('menu-item-item1')).toHaveAttribute(
        'data-selected',
        'false',
      );
    });
  });

  describe('Accessibility', () => {
    it('has group role', () => {
      const items = [createMenuItem('item1', 'Item 1')];
      const { container } = renderGroup({
        label: 'Web',
        items,
        flattenedItems: items,
        selectedIndex: 0,
      });

      const group = container.firstChild as HTMLElement;
      expect(group).toHaveAttribute('role', 'group');
    });

    it('has aria-label matching the section label', () => {
      const items = [createMenuItem('item1', 'Item 1')];
      const { container } = renderGroup({
        label: 'Media & files',
        items,
        flattenedItems: items,
        selectedIndex: 0,
      });

      const group = container.firstChild as HTMLElement;
      expect(group).toHaveAttribute('aria-label', 'Media & files');
    });
  });

  describe('Pinning', () => {
    it('marks items that are in pinnedToolIds as pinned', () => {
      const items = [
        createMenuItem('item1', 'Item 1'),
        createMenuItem('item2', 'Item 2'),
      ];

      renderGroup({
        label: 'Web',
        items,
        flattenedItems: items,
        selectedIndex: 0,
        pinnedToolIds: ['item2'],
      });

      expect(screen.getByTestId('menu-item-item1')).toHaveAttribute(
        'data-pinned',
        'false',
      );
      expect(screen.getByTestId('menu-item-item2')).toHaveAttribute(
        'data-pinned',
        'true',
      );
    });
  });

  describe('Item Ordering', () => {
    it('renders items in provided order', () => {
      const items = [
        createMenuItem('item1', 'First'),
        createMenuItem('item2', 'Second'),
        createMenuItem('item3', 'Third'),
      ];

      const { container } = renderGroup({
        label: 'Web',
        items,
        flattenedItems: items,
        selectedIndex: 0,
      });

      const renderedItems = container.querySelectorAll(
        '[data-testid^="menu-item-"]',
      );
      expect(renderedItems).toHaveLength(3);
      expect(renderedItems[0]).toHaveAttribute(
        'data-testid',
        'menu-item-item1',
      );
      expect(renderedItems[1]).toHaveAttribute(
        'data-testid',
        'menu-item-item2',
      );
      expect(renderedItems[2]).toHaveAttribute(
        'data-testid',
        'menu-item-item3',
      );
    });
  });

  describe('Edge Cases', () => {
    it('handles single item category', () => {
      const items = [createMenuItem('only', 'Only Item')];
      renderGroup({
        label: 'Web',
        items,
        flattenedItems: items,
        selectedIndex: 0,
      });

      expect(screen.getByTestId('menu-item-only')).toBeInTheDocument();
    });

    it('handles large number of items', () => {
      const items = Array.from({ length: 50 }, (_, i) =>
        createMenuItem(`item${i}`, `Item ${i}`),
      );

      renderGroup({
        label: 'Web',
        items,
        flattenedItems: items,
        selectedIndex: 25,
      });

      expect(screen.getAllByTestId(/menu-item-/)).toHaveLength(50);
    });

    it('handles negative selectedIndex', () => {
      const items = [createMenuItem('item1', 'Item 1')];
      renderGroup({
        label: 'Web',
        items,
        flattenedItems: items,
        selectedIndex: -1,
      });

      expect(screen.getByTestId('menu-item-item1')).toHaveAttribute(
        'data-selected',
        'false',
      );
    });
  });
});
