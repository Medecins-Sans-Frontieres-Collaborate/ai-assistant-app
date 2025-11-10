import { render, screen } from '@testing-library/react';
import React from 'react';

import { DropdownCategoryGroup } from '@/components/Chat/ChatInput/DropdownCategoryGroup';
import { MenuItem } from '@/components/Chat/ChatInput/DropdownMenuItem';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

// Mock DropdownMenuItem to isolate testing
vi.mock('@/components/Chat/ChatInput/DropdownMenuItem', () => ({
  DropdownMenuItem: ({ item, isSelected }: any) => (
    <div data-testid={`menu-item-${item.id}`} data-selected={isSelected}>
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

  describe('Rendering', () => {
    it('renders all items in category', () => {
      const items = [
        createMenuItem('item1', 'Item 1'),
        createMenuItem('item2', 'Item 2'),
        createMenuItem('item3', 'Item 3'),
      ];

      render(
        <DropdownCategoryGroup
          category="media"
          items={items}
          flattenedItems={items}
          selectedIndex={0}
        />,
      );

      expect(screen.getByTestId('menu-item-item1')).toBeInTheDocument();
      expect(screen.getByTestId('menu-item-item2')).toBeInTheDocument();
      expect(screen.getByTestId('menu-item-item3')).toBeInTheDocument();
    });

    it('renders empty category with no items', () => {
      const { container } = render(
        <DropdownCategoryGroup
          category="transform"
          items={[]}
          flattenedItems={[]}
          selectedIndex={0}
        />,
      );

      expect(screen.queryByTestId(/menu-item-/)).not.toBeInTheDocument();
      expect(container.firstChild).toBeInTheDocument(); // Container still exists
    });
  });

  describe('Selection State', () => {
    it('marks first item as selected when selectedIndex is 0', () => {
      const items = [
        createMenuItem('item1', 'Item 1'),
        createMenuItem('item2', 'Item 2'),
      ];

      render(
        <DropdownCategoryGroup
          category="web"
          items={items}
          flattenedItems={items}
          selectedIndex={0}
        />,
      );

      const item1 = screen.getByTestId('menu-item-item1');
      const item2 = screen.getByTestId('menu-item-item2');

      expect(item1).toHaveAttribute('data-selected', 'true');
      expect(item2).toHaveAttribute('data-selected', 'false');
    });

    it('marks correct item as selected based on flattenedItems index', () => {
      const items = [
        createMenuItem('item1', 'Item 1'),
        createMenuItem('item2', 'Item 2'),
      ];

      render(
        <DropdownCategoryGroup
          category="web"
          items={items}
          flattenedItems={items}
          selectedIndex={1}
        />,
      );

      const item1 = screen.getByTestId('menu-item-item1');
      const item2 = screen.getByTestId('menu-item-item2');

      expect(item1).toHaveAttribute('data-selected', 'false');
      expect(item2).toHaveAttribute('data-selected', 'true');
    });

    it('handles selection across multiple categories', () => {
      // Simulate scenario where flattenedItems includes items from other categories
      const categoryItems = [createMenuItem('media1', 'Media Item')];
      const allItems = [
        createMenuItem('web1', 'Web Item'),
        createMenuItem('web2', 'Web Item 2'),
        createMenuItem('media1', 'Media Item'), // This category
      ];

      render(
        <DropdownCategoryGroup
          category="media"
          items={categoryItems}
          flattenedItems={allItems}
          selectedIndex={2} // Points to media1 in flattened list
        />,
      );

      const mediaItem = screen.getByTestId('menu-item-media1');
      expect(mediaItem).toHaveAttribute('data-selected', 'true');
    });

    it('handles no selection when selectedIndex is out of bounds', () => {
      const items = [createMenuItem('item1', 'Item 1')];

      render(
        <DropdownCategoryGroup
          category="web"
          items={items}
          flattenedItems={items}
          selectedIndex={10}
        />,
      );

      const item1 = screen.getByTestId('menu-item-item1');
      expect(item1).toHaveAttribute('data-selected', 'false');
    });
  });

  describe('Styling', () => {
    it('has correct container classes', () => {
      const items = [createMenuItem('item1', 'Item 1')];
      const { container } = render(
        <DropdownCategoryGroup
          category="web"
          items={items}
          flattenedItems={items}
          selectedIndex={0}
        />,
      );

      const groupContainer = container.firstChild as HTMLElement;
      expect(groupContainer).toHaveClass('px-1');
      expect(groupContainer).toHaveClass('-my-0.5');
    });
  });

  describe('Accessibility', () => {
    it('has group role', () => {
      const items = [createMenuItem('item1', 'Item 1')];
      const { container } = render(
        <DropdownCategoryGroup
          category="web"
          items={items}
          flattenedItems={items}
          selectedIndex={0}
        />,
      );

      const group = container.firstChild as HTMLElement;
      expect(group).toHaveAttribute('role', 'group');
    });

    it('has aria-label matching category', () => {
      const items = [createMenuItem('item1', 'Item 1')];
      const { container } = render(
        <DropdownCategoryGroup
          category="media"
          items={items}
          flattenedItems={items}
          selectedIndex={0}
        />,
      );

      const group = container.firstChild as HTMLElement;
      expect(group).toHaveAttribute('aria-label', 'media');
    });
  });

  describe('Different Categories', () => {
    it('handles web category', () => {
      const items = [createMenuItem('search', 'Web Search', 'web')];
      render(
        <DropdownCategoryGroup
          category="web"
          items={items}
          flattenedItems={items}
          selectedIndex={0}
        />,
      );

      expect(screen.getByText('Web Search')).toBeInTheDocument();
    });

    it('handles media category', () => {
      const items = [
        createMenuItem('image', 'Upload Image', 'media'),
        createMenuItem('file', 'Upload File', 'media'),
      ];
      render(
        <DropdownCategoryGroup
          category="media"
          items={items}
          flattenedItems={items}
          selectedIndex={0}
        />,
      );

      expect(screen.getByText('Upload Image')).toBeInTheDocument();
      expect(screen.getByText('Upload File')).toBeInTheDocument();
    });

    it('handles transform category', () => {
      const items = [
        createMenuItem('translate', 'Translate Text', 'transform'),
      ];
      render(
        <DropdownCategoryGroup
          category="transform"
          items={items}
          flattenedItems={items}
          selectedIndex={0}
        />,
      );

      expect(screen.getByText('Translate Text')).toBeInTheDocument();
    });
  });

  describe('Item Ordering', () => {
    it('renders items in provided order', () => {
      const items = [
        createMenuItem('item1', 'First'),
        createMenuItem('item2', 'Second'),
        createMenuItem('item3', 'Third'),
      ];

      const { container } = render(
        <DropdownCategoryGroup
          category="web"
          items={items}
          flattenedItems={items}
          selectedIndex={0}
        />,
      );

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
      render(
        <DropdownCategoryGroup
          category="web"
          items={items}
          flattenedItems={items}
          selectedIndex={0}
        />,
      );

      expect(screen.getByTestId('menu-item-only')).toBeInTheDocument();
    });

    it('handles large number of items', () => {
      const items = Array.from({ length: 50 }, (_, i) =>
        createMenuItem(`item${i}`, `Item ${i}`),
      );

      render(
        <DropdownCategoryGroup
          category="web"
          items={items}
          flattenedItems={items}
          selectedIndex={25}
        />,
      );

      expect(screen.getAllByTestId(/menu-item-/)).toHaveLength(50);
    });

    it('handles negative selectedIndex', () => {
      const items = [createMenuItem('item1', 'Item 1')];
      render(
        <DropdownCategoryGroup
          category="web"
          items={items}
          flattenedItems={items}
          selectedIndex={-1}
        />,
      );

      const item1 = screen.getByTestId('menu-item-item1');
      expect(item1).toHaveAttribute('data-selected', 'false');
    });
  });
});
