import { useCallback, useEffect, useState } from 'react';

/**
 * Custom hook for controlled/uncontrolled modal state pattern
 * Implements a cleaner "controlled with default" pattern instead of bidirectional sync
 *
 * The pattern works as follows:
 * - If external value is provided, component is CONTROLLED (external state is source of truth)
 * - If external value is undefined, component is UNCONTROLLED (internal state is source of truth)
 * - onChange is always called when state changes, allowing parent to stay in sync
 *
 * This is a common React pattern used by libraries like Radix UI, Headless UI, etc.
 *
 * @param externalValue - Optional controlled value from props
 * @param defaultValue - Default value when uncontrolled (default: false)
 * @param onChange - Callback when value changes
 * @returns Tuple of [value, setValue]
 *
 * @example
 * // Controlled usage (parent manages state)
 * const [isOpen, setIsOpen] = useControlledState(props.isOpen, false, props.onOpenChange);
 *
 * @example
 * // Uncontrolled usage (component manages its own state)
 * const [isOpen, setIsOpen] = useControlledState(undefined, false, (open) => {
 *   console.log('Modal opened:', open);
 * });
 */
export const useControlledState = <T>(
  externalValue: T | undefined,
  defaultValue: T,
  onChange?: (value: T) => void,
): [T, (value: T | ((prev: T) => T)) => void] => {
  // Internal state used only when component is uncontrolled
  const [internalValue, setInternalValue] = useState<T>(defaultValue);

  // Determine if component is controlled
  const isControlled = externalValue !== undefined;

  // The actual value used (controlled takes precedence)
  const value = isControlled ? externalValue : internalValue;

  // Setter that handles both controlled and uncontrolled cases
  const setValue = useCallback(
    (nextValue: T | ((prev: T) => T)) => {
      // Resolve the next value (handle function updates)
      const resolvedValue =
        typeof nextValue === 'function'
          ? (nextValue as (prev: T) => T)(value)
          : nextValue;

      // If uncontrolled, update internal state
      if (!isControlled) {
        setInternalValue(resolvedValue);
      }

      // Always call onChange to notify parent
      onChange?.(resolvedValue);
    },
    [isControlled, onChange, value],
  );

  return [value, setValue];
};

/**
 * Specialized hook for boolean modal state (most common use case)
 * A convenience wrapper around useControlledState
 *
 * @param isOpen - Optional controlled open state
 * @param defaultOpen - Default open state when uncontrolled
 * @param onOpenChange - Callback when open state changes
 * @returns Tuple of [isOpen, setIsOpen]
 *
 * @example
 * const [isOpen, setIsOpen] = useModalState(props.isOpen, false, props.onOpenChange);
 */
export const useModalState = (
  isOpen: boolean | undefined,
  defaultOpen: boolean = false,
  onOpenChange?: (open: boolean) => void,
): [boolean, (open: boolean | ((prev: boolean) => boolean)) => void] => {
  return useControlledState(isOpen, defaultOpen, onOpenChange);
};
