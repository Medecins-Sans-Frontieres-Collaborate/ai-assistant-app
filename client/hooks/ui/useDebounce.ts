import { useEffect, useState } from 'react';

/**
 * Debounces a value to reduce re-renders during rapid updates
 * Particularly useful for streaming content where updates happen very frequently
 *
 * @param value The value to debounce
 * @param delay The delay in milliseconds (default: 100ms)
 * @returns The debounced value
 */
export function useDebounce<T>(value: T, delay: number = 100): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    // Set up the timeout
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    // Clean up the timeout if value changes before delay expires
    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
}
