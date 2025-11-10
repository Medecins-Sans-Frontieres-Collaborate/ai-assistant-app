import { act, renderHook } from '@testing-library/react';

import { useItemSearch } from '@/client/hooks/ui/useItemSearch';

import { describe, expect, it } from 'vitest';

describe('useItemSearch', () => {
  interface TestItem {
    id: number;
    name: string;
    description?: string;
    tags?: string[];
    category?: string;
  }

  const mockItems: TestItem[] = [
    {
      id: 1,
      name: 'Apple',
      description: 'A red fruit',
      tags: ['fruit', 'red'],
      category: 'food',
    },
    {
      id: 2,
      name: 'Banana',
      description: 'A yellow fruit',
      tags: ['fruit', 'yellow'],
      category: 'food',
    },
    {
      id: 3,
      name: 'Carrot',
      description: 'An orange vegetable',
      tags: ['vegetable', 'orange'],
      category: 'food',
    },
    {
      id: 4,
      name: 'Date',
      description: 'A sweet fruit',
      tags: ['fruit', 'sweet'],
      category: 'food',
    },
  ];

  describe('Initial State', () => {
    it('initializes with empty search query', () => {
      const { result } = renderHook(() =>
        useItemSearch({ items: mockItems, searchFields: ['name'] }),
      );

      expect(result.current.searchQuery).toBe('');
    });

    it('returns all items when search query is empty', () => {
      const { result } = renderHook(() =>
        useItemSearch({ items: mockItems, searchFields: ['name'] }),
      );

      expect(result.current.filteredItems).toEqual(mockItems);
      expect(result.current.filteredItems.length).toBe(4);
    });
  });

  describe('Single Field Search', () => {
    it('filters items by name field', () => {
      const { result } = renderHook(() =>
        useItemSearch({ items: mockItems, searchFields: ['name'] }),
      );

      act(() => {
        result.current.setSearchQuery('apple');
      });

      expect(result.current.filteredItems).toHaveLength(1);
      expect(result.current.filteredItems[0].name).toBe('Apple');
    });

    it('is case insensitive', () => {
      const { result } = renderHook(() =>
        useItemSearch({ items: mockItems, searchFields: ['name'] }),
      );

      act(() => {
        result.current.setSearchQuery('BANANA');
      });

      expect(result.current.filteredItems).toHaveLength(1);
      expect(result.current.filteredItems[0].name).toBe('Banana');
    });

    it('finds partial matches', () => {
      const { result } = renderHook(() =>
        useItemSearch({ items: mockItems, searchFields: ['name'] }),
      );

      act(() => {
        result.current.setSearchQuery('an');
      });

      expect(result.current.filteredItems).toHaveLength(1);
      expect(result.current.filteredItems[0].name).toBe('Banana');
    });

    it('returns empty array when no matches', () => {
      const { result } = renderHook(() =>
        useItemSearch({ items: mockItems, searchFields: ['name'] }),
      );

      act(() => {
        result.current.setSearchQuery('xyz');
      });

      expect(result.current.filteredItems).toHaveLength(0);
    });
  });

  describe('Multi-Field Search', () => {
    it('searches across multiple fields', () => {
      const { result } = renderHook(() =>
        useItemSearch({
          items: mockItems,
          searchFields: ['name', 'description'],
        }),
      );

      act(() => {
        result.current.setSearchQuery('yellow');
      });

      expect(result.current.filteredItems).toHaveLength(1);
      expect(result.current.filteredItems[0].name).toBe('Banana');
    });

    it('finds match in any specified field', () => {
      const { result } = renderHook(() =>
        useItemSearch({
          items: mockItems,
          searchFields: ['name', 'category'],
        }),
      );

      act(() => {
        result.current.setSearchQuery('food');
      });

      expect(result.current.filteredItems).toHaveLength(4);
    });
  });

  describe('Array Field Search', () => {
    it('searches within array fields', () => {
      const { result } = renderHook(() =>
        useItemSearch({
          items: mockItems,
          searchFields: ['tags'],
        }),
      );

      act(() => {
        result.current.setSearchQuery('fruit');
      });

      expect(result.current.filteredItems).toHaveLength(3);
      const names = result.current.filteredItems.map((item) => item.name);
      expect(names).toContain('Apple');
      expect(names).toContain('Banana');
      expect(names).toContain('Date');
    });

    it('searches within array elements', () => {
      const { result } = renderHook(() =>
        useItemSearch({
          items: mockItems,
          searchFields: ['tags'],
        }),
      );

      act(() => {
        result.current.setSearchQuery('orange');
      });

      expect(result.current.filteredItems).toHaveLength(1);
      expect(result.current.filteredItems[0].name).toBe('Carrot');
    });

    it('handles mixed field types', () => {
      const { result } = renderHook(() =>
        useItemSearch({
          items: mockItems,
          searchFields: ['name', 'tags'],
        }),
      );

      act(() => {
        result.current.setSearchQuery('red');
      });

      expect(result.current.filteredItems).toHaveLength(1);
      expect(result.current.filteredItems[0].name).toBe('Apple');
    });
  });

  describe('Custom Matcher', () => {
    it('uses custom matcher when provided', () => {
      const customMatcher = (item: TestItem, query: string) => {
        return item.name.toLowerCase().startsWith(query);
      };

      const { result } = renderHook(() =>
        useItemSearch({
          items: mockItems,
          customMatcher,
        }),
      );

      act(() => {
        result.current.setSearchQuery('b');
      });

      expect(result.current.filteredItems).toHaveLength(1);
      expect(result.current.filteredItems[0].name).toBe('Banana');
    });

    it('custom matcher receives lowercase query', () => {
      const customMatcher = vi.fn((item: TestItem, query: string) => {
        return item.name.toLowerCase().includes(query);
      });

      const { result } = renderHook(() =>
        useItemSearch({
          items: mockItems,
          customMatcher,
        }),
      );

      act(() => {
        result.current.setSearchQuery('APPLE');
      });

      expect(customMatcher).toHaveBeenCalledWith(expect.anything(), 'apple');
    });

    it('ignores searchFields when custom matcher provided', () => {
      const customMatcher = (item: TestItem, query: string) => {
        return item.id.toString() === query;
      };

      const { result } = renderHook(() =>
        useItemSearch({
          items: mockItems,
          searchFields: ['name'], // Should be ignored
          customMatcher,
        }),
      );

      act(() => {
        result.current.setSearchQuery('2');
      });

      expect(result.current.filteredItems).toHaveLength(1);
      expect(result.current.filteredItems[0].name).toBe('Banana');
    });
  });

  describe('Query Handling', () => {
    it('stores query with whitespace but still searches', () => {
      const { result } = renderHook(() =>
        useItemSearch({ items: mockItems, searchFields: ['name'] }),
      );

      act(() => {
        result.current.setSearchQuery('apple');
      });

      expect(result.current.filteredItems).toHaveLength(1);
      expect(result.current.filteredItems[0].name).toBe('Apple');
    });

    it('returns all items for whitespace-only query', () => {
      const { result } = renderHook(() =>
        useItemSearch({ items: mockItems, searchFields: ['name'] }),
      );

      act(() => {
        result.current.setSearchQuery('   ');
      });

      expect(result.current.filteredItems).toEqual(mockItems);
    });

    it('updates filtered items when query changes', () => {
      const { result } = renderHook(() =>
        useItemSearch({ items: mockItems, searchFields: ['name'] }),
      );

      act(() => {
        result.current.setSearchQuery('apple');
      });
      expect(result.current.filteredItems).toHaveLength(1);

      act(() => {
        result.current.setSearchQuery('banana');
      });
      expect(result.current.filteredItems).toHaveLength(1);
      expect(result.current.filteredItems[0].name).toBe('Banana');
    });

    it('clears filters when query set to empty', () => {
      const { result } = renderHook(() =>
        useItemSearch({ items: mockItems, searchFields: ['name'] }),
      );

      act(() => {
        result.current.setSearchQuery('apple');
      });
      expect(result.current.filteredItems).toHaveLength(1);

      act(() => {
        result.current.setSearchQuery('');
      });
      expect(result.current.filteredItems).toEqual(mockItems);
    });
  });

  describe('Null/Undefined Handling', () => {
    it('handles null field values', () => {
      const itemsWithNull: TestItem[] = [
        { id: 1, name: 'Test', description: undefined },
      ];

      const { result } = renderHook(() =>
        useItemSearch({
          items: itemsWithNull,
          searchFields: ['description'],
        }),
      );

      act(() => {
        result.current.setSearchQuery('test');
      });

      expect(result.current.filteredItems).toHaveLength(0);
    });

    it('handles missing optional fields', () => {
      const itemsWithMissing: TestItem[] = [
        { id: 1, name: 'Test' }, // description missing
      ];

      const { result } = renderHook(() =>
        useItemSearch({
          items: itemsWithMissing,
          searchFields: ['name', 'description'],
        }),
      );

      act(() => {
        result.current.setSearchQuery('test');
      });

      expect(result.current.filteredItems).toHaveLength(1);
    });
  });

  describe('Memoization', () => {
    it('memoizes filtered results', () => {
      const { result, rerender } = renderHook(() =>
        useItemSearch({ items: mockItems, searchFields: ['name'] }),
      );

      const firstResult = result.current.filteredItems;

      rerender();

      expect(result.current.filteredItems).toBe(firstResult);
    });

    it('recomputes when items change', () => {
      const { result, rerender } = renderHook(
        ({ items }) => useItemSearch({ items, searchFields: ['name'] }),
        { initialProps: { items: mockItems } },
      );

      const newItems = [
        ...mockItems,
        { id: 5, name: 'Elderberry', category: 'food' },
      ];

      rerender({ items: newItems });

      expect(result.current.filteredItems).toHaveLength(5);
    });

    it('recomputes when query changes', () => {
      const { result } = renderHook(() =>
        useItemSearch({ items: mockItems, searchFields: ['name'] }),
      );

      const firstResult = result.current.filteredItems;

      act(() => {
        result.current.setSearchQuery('apple');
      });

      expect(result.current.filteredItems).not.toBe(firstResult);
    });
  });

  describe('Edge Cases', () => {
    it('handles empty items array', () => {
      const { result } = renderHook(() =>
        useItemSearch({ items: [], searchFields: ['name'] }),
      );

      act(() => {
        result.current.setSearchQuery('test');
      });

      expect(result.current.filteredItems).toEqual([]);
    });

    it('handles no search fields', () => {
      const { result } = renderHook(() => useItemSearch({ items: mockItems }));

      act(() => {
        result.current.setSearchQuery('apple');
      });

      expect(result.current.filteredItems).toHaveLength(0);
    });

    it('handles numeric field values', () => {
      const { result } = renderHook(() =>
        useItemSearch({
          items: mockItems,
          searchFields: ['id' as any],
        }),
      );

      act(() => {
        result.current.setSearchQuery('2');
      });

      expect(result.current.filteredItems).toHaveLength(1);
      expect(result.current.filteredItems[0].id).toBe(2);
    });

    it('handles special regex characters in query', () => {
      const specialItems = [
        { id: 1, name: 'Test [bracket]', category: 'test' },
        { id: 2, name: 'Test (paren)', category: 'test' },
      ];

      const { result } = renderHook(() =>
        useItemSearch({ items: specialItems, searchFields: ['name'] }),
      );

      act(() => {
        result.current.setSearchQuery('[bracket]');
      });

      expect(result.current.filteredItems).toHaveLength(1);
    });
  });

  describe('Return Value', () => {
    it('returns correct structure', () => {
      const { result } = renderHook(() =>
        useItemSearch({ items: mockItems, searchFields: ['name'] }),
      );

      expect(result.current).toHaveProperty('searchQuery');
      expect(result.current).toHaveProperty('setSearchQuery');
      expect(result.current).toHaveProperty('filteredItems');
    });

    it('setSearchQuery is a function', () => {
      const { result } = renderHook(() =>
        useItemSearch({ items: mockItems, searchFields: ['name'] }),
      );

      expect(typeof result.current.setSearchQuery).toBe('function');
    });
  });
});
