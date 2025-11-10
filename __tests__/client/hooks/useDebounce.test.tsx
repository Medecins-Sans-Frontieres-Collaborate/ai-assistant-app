import { renderHook, waitFor } from '@testing-library/react';

import { useDebounce } from '@/client/hooks/ui/useDebounce';

import { describe, expect, it, vi } from 'vitest';

describe('useDebounce', () => {
  it('returns initial value immediately', () => {
    const { result } = renderHook(() => useDebounce('initial', 500));
    expect(result.current).toBe('initial');
  });

  it('debounces value changes with default delay', async () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebounce(value, 100),
      { initialProps: { value: 'initial' } },
    );

    expect(result.current).toBe('initial');

    // Update value
    rerender({ value: 'updated' });
    expect(result.current).toBe('initial'); // Still old value immediately

    // Wait for debounce to complete
    await waitFor(
      () => {
        expect(result.current).toBe('updated');
      },
      { timeout: 200 },
    );
  });

  it('debounces value changes with custom delay', async () => {
    const { result, rerender } = renderHook(
      ({ value, delay }) => useDebounce(value, delay),
      { initialProps: { value: 'initial', delay: 300 } },
    );

    expect(result.current).toBe('initial');

    // Update value
    rerender({ value: 'updated', delay: 300 });
    expect(result.current).toBe('initial');

    // Wait for debounce to complete
    await waitFor(
      () => {
        expect(result.current).toBe('updated');
      },
      { timeout: 400 },
    );
  });

  it('cancels previous timeout when value changes rapidly', async () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebounce(value, 200),
      { initialProps: { value: 'first' } },
    );

    // Rapidly update values
    rerender({ value: 'second' });
    rerender({ value: 'third' });
    rerender({ value: 'final' });

    // Should still be initial value immediately
    expect(result.current).toBe('first');

    // After delay, should have only the final value
    await waitFor(
      () => {
        expect(result.current).toBe('final');
      },
      { timeout: 300 },
    );
  });

  it('handles numeric values', async () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebounce(value, 100),
      { initialProps: { value: 0 } },
    );

    expect(result.current).toBe(0);

    rerender({ value: 42 });

    await waitFor(
      () => {
        expect(result.current).toBe(42);
      },
      { timeout: 200 },
    );
  });

  it('handles boolean values', async () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebounce(value, 100),
      { initialProps: { value: false } },
    );

    expect(result.current).toBe(false);

    rerender({ value: true });

    await waitFor(
      () => {
        expect(result.current).toBe(true);
      },
      { timeout: 200 },
    );
  });

  it('handles object values', async () => {
    const initialObj = { id: 1, name: 'test' };
    const updatedObj = { id: 2, name: 'updated' };

    const { result, rerender } = renderHook(
      ({ value }) => useDebounce(value, 100),
      { initialProps: { value: initialObj } },
    );

    expect(result.current).toBe(initialObj);

    rerender({ value: updatedObj });

    await waitFor(
      () => {
        expect(result.current).toBe(updatedObj);
      },
      { timeout: 200 },
    );
  });

  it('handles array values', async () => {
    const initialArray = [1, 2, 3];
    const updatedArray = [4, 5, 6];

    const { result, rerender } = renderHook(
      ({ value }) => useDebounce(value, 100),
      { initialProps: { value: initialArray } },
    );

    expect(result.current).toBe(initialArray);

    rerender({ value: updatedArray });

    await waitFor(
      () => {
        expect(result.current).toBe(updatedArray);
      },
      { timeout: 200 },
    );
  });

  it('handles delay of 0 (immediate update)', async () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebounce(value, 0),
      { initialProps: { value: 'initial' } },
    );

    rerender({ value: 'updated' });

    // Even with 0 delay, setTimeout is still async, so we need to wait
    await waitFor(
      () => {
        expect(result.current).toBe('updated');
      },
      { timeout: 100 },
    );
  });

  it('uses default delay when not specified', async () => {
    const { result, rerender } = renderHook(({ value }) => useDebounce(value), {
      initialProps: { value: 'initial' },
    });

    rerender({ value: 'updated' });

    // Default delay is 100ms
    await waitFor(
      () => {
        expect(result.current).toBe('updated');
      },
      { timeout: 200 },
    );
  });

  it('handles empty string', async () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebounce(value, 100),
      { initialProps: { value: 'initial' } },
    );

    rerender({ value: '' });

    await waitFor(
      () => {
        expect(result.current).toBe('');
      },
      { timeout: 200 },
    );
  });

  it('handles null values', async () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebounce(value, 100),
      { initialProps: { value: 'initial' as string | null } },
    );

    rerender({ value: null });

    await waitFor(
      () => {
        expect(result.current).toBe(null);
      },
      { timeout: 200 },
    );
  });

  it('handles undefined values', async () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebounce(value, 100),
      { initialProps: { value: 'initial' as string | undefined } },
    );

    rerender({ value: undefined });

    await waitFor(
      () => {
        expect(result.current).toBe(undefined);
      },
      { timeout: 200 },
    );
  });
});
