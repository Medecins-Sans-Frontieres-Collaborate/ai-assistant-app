import { useMemo, useState } from 'react';

export interface UseItemSearchOptions<T> {
  items: T[];
  searchFields?: (keyof T)[];
  customMatcher?: (item: T, query: string) => boolean;
}

export interface UseItemSearchReturn<T> {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  filteredItems: T[];
}

/**
 * Generic hook for searching/filtering items across multiple fields
 *
 * @example
 * // Simple field-based search
 * const search = useItemSearch({
 *   items: prompts,
 *   searchFields: ['name']
 * });
 *
 * @example
 * // Multi-field search with arrays
 * const search = useItemSearch({
 *   items: tones,
 *   searchFields: ['name', 'description', 'tags']
 * });
 *
 * @example
 * // Custom matcher for complex logic
 * const search = useItemSearch({
 *   items: conversations,
 *   customMatcher: (item, query) => {
 *     return item.name.includes(query) || item.messages.some(m => m.content.includes(query));
 *   }
 * });
 */
export function useItemSearch<T>({
  items,
  searchFields,
  customMatcher,
}: UseItemSearchOptions<T>): UseItemSearchReturn<T> {
  const [searchQuery, setSearchQuery] = useState('');

  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return items;

    const lowerQuery = searchQuery.toLowerCase();

    return items.filter((item) => {
      // If custom matcher provided, use it
      if (customMatcher) {
        return customMatcher(item, lowerQuery);
      }

      // Otherwise search in specified fields
      if (searchFields) {
        return searchFields.some((field) => {
          const value = item[field];
          if (value == null) return false;

          // Handle arrays (e.g., tags)
          if (Array.isArray(value)) {
            return value.some((v) =>
              String(v).toLowerCase().includes(lowerQuery),
            );
          }

          // Handle strings and other types
          return String(value).toLowerCase().includes(lowerQuery);
        });
      }

      return false;
    });
  }, [items, searchQuery, searchFields, customMatcher]);

  return {
    searchQuery,
    setSearchQuery,
    filteredItems,
  };
}
