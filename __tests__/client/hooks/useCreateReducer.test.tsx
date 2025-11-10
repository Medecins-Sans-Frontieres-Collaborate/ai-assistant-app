import { act, renderHook } from '@testing-library/react';

import {
  ActionType,
  useCreateReducer,
} from '@/client/hooks/ui/useCreateReducer';

import { describe, expect, it } from 'vitest';

describe('useCreateReducer', () => {
  interface TestState {
    name: string;
    age: number;
    isActive: boolean;
  }

  const initialState: TestState = {
    name: 'John',
    age: 30,
    isActive: true,
  };

  describe('Initialization', () => {
    it('returns initial state', () => {
      const { result } = renderHook(() => useCreateReducer({ initialState }));

      expect(result.current.state).toEqual(initialState);
    });

    it('provides dispatch function', () => {
      const { result } = renderHook(() => useCreateReducer({ initialState }));

      expect(result.current.dispatch).toBeDefined();
      expect(typeof result.current.dispatch).toBe('function');
    });

    it('returns memoized values', () => {
      const { result, rerender } = renderHook(() =>
        useCreateReducer({ initialState }),
      );

      const firstState = result.current.state;
      const firstDispatch = result.current.dispatch;

      rerender();

      // If state hasn't changed, references should be the same
      expect(result.current.state).toBe(firstState);
      expect(result.current.dispatch).toBe(firstDispatch);
    });
  });

  describe('Field Changes', () => {
    it('changes a single field', () => {
      const { result } = renderHook(() => useCreateReducer({ initialState }));

      act(() => {
        result.current.dispatch({ field: 'name', value: 'Jane' });
      });

      expect(result.current.state.name).toBe('Jane');
      expect(result.current.state.age).toBe(30);
      expect(result.current.state.isActive).toBe(true);
    });

    it('changes multiple fields sequentially', () => {
      const { result } = renderHook(() => useCreateReducer({ initialState }));

      act(() => {
        result.current.dispatch({ field: 'name', value: 'Alice' });
      });

      expect(result.current.state.name).toBe('Alice');

      act(() => {
        result.current.dispatch({ field: 'age', value: 25 });
      });

      expect(result.current.state.name).toBe('Alice');
      expect(result.current.state.age).toBe(25);
    });

    it('handles boolean field changes', () => {
      const { result } = renderHook(() => useCreateReducer({ initialState }));

      act(() => {
        result.current.dispatch({ field: 'isActive', value: false });
      });

      expect(result.current.state.isActive).toBe(false);
    });

    it('handles number field changes', () => {
      const { result } = renderHook(() => useCreateReducer({ initialState }));

      act(() => {
        result.current.dispatch({ field: 'age', value: 40 });
      });

      expect(result.current.state.age).toBe(40);
    });

    it('handles string field changes', () => {
      const { result } = renderHook(() => useCreateReducer({ initialState }));

      act(() => {
        result.current.dispatch({ field: 'name', value: 'Bob' });
      });

      expect(result.current.state.name).toBe('Bob');
    });

    it('preserves other fields when changing one field', () => {
      const { result } = renderHook(() => useCreateReducer({ initialState }));

      const stateBefore = { ...result.current.state };

      act(() => {
        result.current.dispatch({ field: 'name', value: 'Updated' });
      });

      expect(result.current.state.name).toBe('Updated');
      expect(result.current.state.age).toBe(stateBefore.age);
      expect(result.current.state.isActive).toBe(stateBefore.isActive);
    });
  });

  describe('Change Action with Type', () => {
    it('handles change action with explicit type', () => {
      const { result } = renderHook(() => useCreateReducer({ initialState }));

      act(() => {
        result.current.dispatch({
          type: 'change',
          field: 'name',
          value: 'Charlie',
        });
      });

      expect(result.current.state.name).toBe('Charlie');
    });

    it('behaves same as implicit change', () => {
      const { result: result1 } = renderHook(() =>
        useCreateReducer({ initialState }),
      );
      const { result: result2 } = renderHook(() =>
        useCreateReducer({ initialState }),
      );

      act(() => {
        result1.current.dispatch({ field: 'age', value: 35 });
        result2.current.dispatch({ type: 'change', field: 'age', value: 35 });
      });

      expect(result1.current.state).toEqual(result2.current.state);
    });
  });

  describe('Reset Action', () => {
    it('resets state to initial values', () => {
      const { result } = renderHook(() => useCreateReducer({ initialState }));

      // Make changes
      act(() => {
        result.current.dispatch({ field: 'name', value: 'Modified' });
        result.current.dispatch({ field: 'age', value: 50 });
        result.current.dispatch({ field: 'isActive', value: false });
      });

      expect(result.current.state).not.toEqual(initialState);

      // Reset
      act(() => {
        result.current.dispatch({ type: 'reset' });
      });

      expect(result.current.state).toEqual(initialState);
    });

    it('can reset multiple times', () => {
      const { result } = renderHook(() => useCreateReducer({ initialState }));

      act(() => {
        result.current.dispatch({ field: 'name', value: 'Test1' });
        result.current.dispatch({ type: 'reset' });
      });

      expect(result.current.state).toEqual(initialState);

      act(() => {
        result.current.dispatch({ field: 'name', value: 'Test2' });
        result.current.dispatch({ type: 'reset' });
      });

      expect(result.current.state).toEqual(initialState);
    });

    it('resets to exact initial state', () => {
      const { result } = renderHook(() => useCreateReducer({ initialState }));

      act(() => {
        result.current.dispatch({ field: 'age', value: 99 });
        result.current.dispatch({ type: 'reset' });
      });

      // Deep equality check
      expect(result.current.state).toEqual(initialState);
      expect(JSON.stringify(result.current.state)).toBe(
        JSON.stringify(initialState),
      );
    });
  });

  describe('Complex State Objects', () => {
    interface ComplexState {
      user: {
        firstName: string;
        lastName: string;
      };
      settings: {
        theme: string;
        notifications: boolean;
      };
      count: number;
    }

    const complexInitial: ComplexState = {
      user: {
        firstName: 'John',
        lastName: 'Doe',
      },
      settings: {
        theme: 'dark',
        notifications: true,
      },
      count: 0,
    };

    it('handles nested object changes', () => {
      const { result } = renderHook(() =>
        useCreateReducer({ initialState: complexInitial }),
      );

      act(() => {
        result.current.dispatch({
          field: 'user',
          value: { firstName: 'Jane', lastName: 'Smith' },
        });
      });

      expect(result.current.state.user.firstName).toBe('Jane');
      expect(result.current.state.user.lastName).toBe('Smith');
      expect(result.current.state.settings).toEqual(complexInitial.settings);
    });

    it('resets complex state correctly', () => {
      const { result } = renderHook(() =>
        useCreateReducer({ initialState: complexInitial }),
      );

      act(() => {
        result.current.dispatch({
          field: 'settings',
          value: { theme: 'light', notifications: false },
        });
        result.current.dispatch({ field: 'count', value: 10 });
      });

      act(() => {
        result.current.dispatch({ type: 'reset' });
      });

      expect(result.current.state).toEqual(complexInitial);
    });
  });

  describe('Type Safety', () => {
    it('correctly types field names from initial state', () => {
      const { result } = renderHook(() => useCreateReducer({ initialState }));

      // These should compile without errors
      act(() => {
        result.current.dispatch({ field: 'name', value: 'Valid' });
        result.current.dispatch({ field: 'age', value: 20 });
        result.current.dispatch({ field: 'isActive', value: true });
      });

      // Verify all dispatches worked
      expect(result.current.state.name).toBe('Valid');
      expect(result.current.state.age).toBe(20);
      expect(result.current.state.isActive).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('handles empty initial state', () => {
      const emptyState = {};
      const { result } = renderHook(() =>
        useCreateReducer({ initialState: emptyState }),
      );

      expect(result.current.state).toEqual({});
    });

    it('handles state with null values', () => {
      interface NullableState {
        value: string | null;
      }

      const nullableInitial: NullableState = {
        value: null,
      };

      const { result } = renderHook(() =>
        useCreateReducer({ initialState: nullableInitial }),
      );

      expect(result.current.state.value).toBeNull();

      act(() => {
        result.current.dispatch({ field: 'value', value: 'not null' });
      });

      expect(result.current.state.value).toBe('not null');

      act(() => {
        result.current.dispatch({ field: 'value', value: null });
      });

      expect(result.current.state.value).toBeNull();
    });

    it('handles state with undefined values', () => {
      interface UndefinedState {
        value: string | undefined;
      }

      const undefinedInitial: UndefinedState = {
        value: undefined,
      };

      const { result } = renderHook(() =>
        useCreateReducer({ initialState: undefinedInitial }),
      );

      expect(result.current.state.value).toBeUndefined();

      act(() => {
        result.current.dispatch({ field: 'value', value: 'defined' });
      });

      expect(result.current.state.value).toBe('defined');
    });

    it('handles state with array values', () => {
      interface ArrayState {
        items: string[];
      }

      const arrayInitial: ArrayState = {
        items: ['a', 'b', 'c'],
      };

      const { result } = renderHook(() =>
        useCreateReducer({ initialState: arrayInitial }),
      );

      act(() => {
        result.current.dispatch({ field: 'items', value: ['x', 'y', 'z'] });
      });

      expect(result.current.state.items).toEqual(['x', 'y', 'z']);
    });

    it('handles rapid consecutive updates', () => {
      const { result } = renderHook(() => useCreateReducer({ initialState }));

      act(() => {
        result.current.dispatch({ field: 'age', value: 31 });
        result.current.dispatch({ field: 'age', value: 32 });
        result.current.dispatch({ field: 'age', value: 33 });
        result.current.dispatch({ field: 'age', value: 34 });
        result.current.dispatch({ field: 'age', value: 35 });
      });

      expect(result.current.state.age).toBe(35);
    });

    it('updates are properly batched', () => {
      const { result } = renderHook(() => useCreateReducer({ initialState }));

      act(() => {
        result.current.dispatch({ field: 'name', value: 'First' });
        result.current.dispatch({ field: 'age', value: 40 });
        result.current.dispatch({ field: 'isActive', value: false });
      });

      expect(result.current.state).toEqual({
        name: 'First',
        age: 40,
        isActive: false,
      });
    });
  });

  describe('Action Immutability', () => {
    it('does not mutate original state', () => {
      const { result } = renderHook(() => useCreateReducer({ initialState }));

      const stateBefore = result.current.state;

      act(() => {
        result.current.dispatch({ field: 'name', value: 'New Name' });
      });

      // Original reference should not be mutated
      expect(stateBefore.name).toBe('John');
      expect(result.current.state.name).toBe('New Name');
    });

    it('creates new state object on each change', () => {
      const { result } = renderHook(() => useCreateReducer({ initialState }));

      const state1 = result.current.state;

      act(() => {
        result.current.dispatch({ field: 'name', value: 'Changed' });
      });

      const state2 = result.current.state;

      // Different object references
      expect(state1).not.toBe(state2);
      // But values are as expected
      expect(state1.name).toBe('John');
      expect(state2.name).toBe('Changed');
    });
  });

  describe('Multiple Instances', () => {
    it('maintains separate state for multiple instances', () => {
      const { result: result1 } = renderHook(() =>
        useCreateReducer({ initialState }),
      );
      const { result: result2 } = renderHook(() =>
        useCreateReducer({ initialState }),
      );

      act(() => {
        result1.current.dispatch({ field: 'name', value: 'Instance 1' });
        result2.current.dispatch({ field: 'name', value: 'Instance 2' });
      });

      expect(result1.current.state.name).toBe('Instance 1');
      expect(result2.current.state.name).toBe('Instance 2');
    });

    it('does not interfere with each other', () => {
      const { result: result1 } = renderHook(() =>
        useCreateReducer({ initialState }),
      );
      const { result: result2 } = renderHook(() =>
        useCreateReducer({ initialState }),
      );

      act(() => {
        result1.current.dispatch({ field: 'age', value: 100 });
      });

      expect(result1.current.state.age).toBe(100);
      expect(result2.current.state.age).toBe(30); // Still initial value
    });
  });
});
