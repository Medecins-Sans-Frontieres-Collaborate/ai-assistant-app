import { useEffect } from 'react';

/**
 * Custom hook that automatically dismisses an error after a specified timeout
 * Extracted from Chat.tsx to improve reusability
 *
 * @param error - The error message (or null if no error)
 * @param clearError - Function to call to clear the error
 * @param timeout - Time in milliseconds before auto-dismissing (default: 10000ms / 10 seconds)
 *
 * @example
 * const { error, clearError } = useChat();
 * useAutoDismissError(error, clearError, 10000);
 */
export const useAutoDismissError = (
  error: string | null,
  clearError: () => void,
  timeout: number = 10000,
): void => {
  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => {
        clearError();
      }, timeout);

      // Cleanup timer on unmount or when error changes
      return () => clearTimeout(timer);
    }
  }, [error, clearError, timeout]);
};
