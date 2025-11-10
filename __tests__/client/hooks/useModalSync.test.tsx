import { act, renderHook } from '@testing-library/react';

import {
  useControlledState,
  useModalState,
} from '@/client/hooks/ui/useModalSync';

import { describe, expect, it, vi } from 'vitest';

/**
 * Tests for useModalSync hooks (useControlledState and useModalState)
 * These hooks implement the controlled/uncontrolled component pattern
 */

describe('useControlledState', () => {
  describe('Uncontrolled Mode', () => {
    it('uses default value when external value is undefined', () => {
      const { result } = renderHook(() =>
        useControlledState(undefined, 'default'),
      );

      expect(result.current[0]).toBe('default');
    });

    it('updates internal state when setValue is called', () => {
      const { result } = renderHook(() =>
        useControlledState(undefined, 'initial'),
      );

      act(() => {
        result.current[1]('updated');
      });

      expect(result.current[0]).toBe('updated');
    });

    it('calls onChange when value changes', () => {
      const onChange = vi.fn();
      const { result } = renderHook(() =>
        useControlledState<string>(undefined, 'initial', onChange),
      );

      act(() => {
        result.current[1]('new value');
      });

      expect(onChange).toHaveBeenCalledWith('new value');
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('supports function updates', () => {
      const { result } = renderHook(() => useControlledState(undefined, 5));

      act(() => {
        result.current[1]((prev) => prev + 10);
      });

      expect(result.current[0]).toBe(15);
    });

    it('maintains independence from external changes', () => {
      const { result } = renderHook(() =>
        useControlledState(undefined, 'uncontrolled'),
      );

      act(() => {
        result.current[1]('local value');
      });

      // External changes don't affect uncontrolled component
      expect(result.current[0]).toBe('local value');
    });
  });

  describe('Controlled Mode', () => {
    it('uses external value when provided', () => {
      const { result } = renderHook(() =>
        useControlledState('external', 'default'),
      );

      expect(result.current[0]).toBe('external');
    });

    it('does not update internal state when setValue is called', () => {
      const { result } = renderHook(() =>
        useControlledState<string>('controlled', 'default'),
      );

      // Internal state should not change
      const initialValue = result.current[0];

      act(() => {
        result.current[1]('attempted change' as any);
      });

      // Value remains the same (controlled by external prop)
      expect(result.current[0]).toBe(initialValue);
    });

    it('calls onChange to notify parent of state changes', () => {
      const onChange = vi.fn();
      const { result } = renderHook(() =>
        useControlledState<string>('controlled', 'default', onChange),
      );

      act(() => {
        result.current[1]('new value' as any);
      });

      expect(onChange).toHaveBeenCalledWith('new value');
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('updates when external value changes', () => {
      let externalValue = 'first';
      const { result, rerender } = renderHook(
        ({ value }) => useControlledState(value, 'default'),
        {
          initialProps: { value: externalValue },
        },
      );

      expect(result.current[0]).toBe('first');

      // Simulate prop change
      externalValue = 'second';
      rerender({ value: externalValue });

      expect(result.current[0]).toBe('second');
    });

    it('supports function updates with onChange', () => {
      const onChange = vi.fn();
      const { result } = renderHook(() =>
        useControlledState<number>(10, 0, onChange),
      );

      act(() => {
        result.current[1](((prev: number) => prev * 2) as any);
      });

      expect(onChange).toHaveBeenCalledWith(20);
    });
  });

  describe('Controlled/Uncontrolled Switching', () => {
    it('switches from uncontrolled to controlled', () => {
      let externalValue: string | undefined = undefined;
      const { result, rerender } = renderHook(
        ({ value }) => useControlledState(value, 'default'),
        {
          initialProps: { value: externalValue },
        },
      );

      // Initially uncontrolled
      expect(result.current[0]).toBe('default');

      act(() => {
        result.current[1]('internal value');
      });

      expect(result.current[0]).toBe('internal value');

      // Switch to controlled
      externalValue = 'controlled value';
      rerender({ value: externalValue as any });

      expect(result.current[0]).toBe('controlled value');
    });

    it('switches from controlled to uncontrolled', () => {
      let externalValue: string | undefined = 'controlled';
      const { result, rerender } = renderHook(
        ({ value }) => useControlledState<string>(value, 'default'),
        {
          initialProps: { value: externalValue as string },
        },
      );

      // Initially controlled
      expect(result.current[0]).toBe('controlled');

      // Switch to uncontrolled
      externalValue = undefined;
      rerender({ value: externalValue as any });

      // Uses default value
      expect(result.current[0]).toBe('default');
    });
  });

  describe('onChange Callback', () => {
    it('is optional and does not error when undefined', () => {
      const { result } = renderHook(() =>
        useControlledState(undefined, 'test'),
      );

      expect(() => {
        act(() => {
          result.current[1]('new value');
        });
      }).not.toThrow();
    });

    it('receives resolved value from function updates', () => {
      const onChange = vi.fn();
      const { result } = renderHook(() =>
        useControlledState<number>(undefined, 100, onChange),
      );

      act(() => {
        result.current[1](((prev: number) => prev / 2) as any);
      });

      expect(onChange).toHaveBeenCalledWith(50);
    });

    it('is called even when controlled', () => {
      const onChange = vi.fn();
      const { result } = renderHook(() =>
        useControlledState<string>('controlled', 'default', onChange),
      );

      act(() => {
        result.current[1]('new value' as any);
      });

      expect(onChange).toHaveBeenCalledWith('new value');
    });
  });

  describe('Generic Type Support', () => {
    it('works with string type', () => {
      const { result } = renderHook(() =>
        useControlledState<string>(undefined, 'hello'),
      );

      expect(result.current[0]).toBe('hello');
    });

    it('works with number type', () => {
      const { result } = renderHook(() =>
        useControlledState<number>(undefined, 42),
      );

      expect(result.current[0]).toBe(42);
    });

    it('works with boolean type', () => {
      const { result } = renderHook(() =>
        useControlledState<boolean>(undefined, true),
      );

      expect(result.current[0]).toBe(true);
    });

    it('works with object type', () => {
      const defaultObj = { name: 'Test', value: 123 };
      const { result } = renderHook(() =>
        useControlledState(undefined, defaultObj),
      );

      expect(result.current[0]).toEqual(defaultObj);
    });

    it('works with array type', () => {
      const defaultArray = [1, 2, 3];
      const { result } = renderHook(() =>
        useControlledState(undefined, defaultArray),
      );

      expect(result.current[0]).toEqual(defaultArray);
    });
  });
});

describe('useModalState', () => {
  describe('Uncontrolled Mode', () => {
    it('defaults to false when no arguments provided', () => {
      const { result } = renderHook(() => useModalState(undefined));

      expect(result.current[0]).toBe(false);
    });

    it('uses custom default when provided', () => {
      const { result } = renderHook(() => useModalState(undefined, true));

      expect(result.current[0]).toBe(true);
    });

    it('toggles modal state', () => {
      const { result } = renderHook(() => useModalState(undefined, false));

      expect(result.current[0]).toBe(false);

      act(() => {
        result.current[1](true);
      });

      expect(result.current[0]).toBe(true);

      act(() => {
        result.current[1](false);
      });

      expect(result.current[0]).toBe(false);
    });

    it('calls onOpenChange when state changes', () => {
      const onOpenChange = vi.fn();
      const { result } = renderHook(() =>
        useModalState(undefined, false, onOpenChange),
      );

      act(() => {
        result.current[1](true);
      });

      expect(onOpenChange).toHaveBeenCalledWith(true);
      expect(onOpenChange).toHaveBeenCalledTimes(1);
    });

    it('supports function updates', () => {
      const { result } = renderHook(() => useModalState(undefined, false));

      act(() => {
        result.current[1]((prev) => !prev);
      });

      expect(result.current[0]).toBe(true);

      act(() => {
        result.current[1]((prev) => !prev);
      });

      expect(result.current[0]).toBe(false);
    });
  });

  describe('Controlled Mode', () => {
    it('uses external isOpen value', () => {
      const { result } = renderHook(() => useModalState(true, false));

      expect(result.current[0]).toBe(true);
    });

    it('does not change internal state when controlled', () => {
      const { result } = renderHook(() => useModalState(false, false));

      act(() => {
        result.current[1](true);
      });

      // Value stays the same because it's controlled
      expect(result.current[0]).toBe(false);
    });

    it('calls onOpenChange to notify parent', () => {
      const onOpenChange = vi.fn();
      const { result } = renderHook(() =>
        useModalState(false, false, onOpenChange),
      );

      act(() => {
        result.current[1](true);
      });

      expect(onOpenChange).toHaveBeenCalledWith(true);
    });

    it('updates when external prop changes', () => {
      let isOpen = false;
      const { result, rerender } = renderHook(
        ({ open }) => useModalState(open, false),
        {
          initialProps: { open: isOpen },
        },
      );

      expect(result.current[0]).toBe(false);

      isOpen = true;
      rerender({ open: isOpen });

      expect(result.current[0]).toBe(true);
    });
  });

  describe('Integration Scenarios', () => {
    it('works for typical modal open/close flow', () => {
      const onOpenChange = vi.fn();
      const { result } = renderHook(() =>
        useModalState(undefined, false, onOpenChange),
      );

      // Modal starts closed
      expect(result.current[0]).toBe(false);

      // Open modal
      act(() => {
        result.current[1](true);
      });

      expect(result.current[0]).toBe(true);
      expect(onOpenChange).toHaveBeenCalledWith(true);

      // Close modal
      act(() => {
        result.current[1](false);
      });

      expect(result.current[0]).toBe(false);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('handles parent controlling modal state', () => {
      let parentIsOpen = false;
      const setParentIsOpen = vi.fn((value: boolean) => {
        parentIsOpen = value;
      });

      const { result, rerender } = renderHook(
        ({ open }) => useModalState(open, false, setParentIsOpen),
        {
          initialProps: { open: parentIsOpen },
        },
      );

      // Child requests to open modal
      act(() => {
        result.current[1](true);
      });

      // Parent is notified
      expect(setParentIsOpen).toHaveBeenCalledWith(true);

      // Parent updates its state
      parentIsOpen = true;
      rerender({ open: parentIsOpen });

      // Child reflects parent's state
      expect(result.current[0]).toBe(true);
    });

    it('works with toggler pattern', () => {
      const { result } = renderHook(() => useModalState(undefined, false));

      const toggle = () => result.current[1]((prev) => !prev);

      expect(result.current[0]).toBe(false);

      act(toggle);
      expect(result.current[0]).toBe(true);

      act(toggle);
      expect(result.current[0]).toBe(false);

      act(toggle);
      expect(result.current[0]).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('handles rapid state changes', () => {
      const { result } = renderHook(() => useModalState(undefined, false));

      act(() => {
        result.current[1](true);
        result.current[1](false);
        result.current[1](true);
      });

      expect(result.current[0]).toBe(true);
    });

    it('handles undefined onOpenChange gracefully', () => {
      const { result } = renderHook(() => useModalState(undefined, false));

      expect(() => {
        act(() => {
          result.current[1](true);
        });
      }).not.toThrow();

      expect(result.current[0]).toBe(true);
    });
  });
});
