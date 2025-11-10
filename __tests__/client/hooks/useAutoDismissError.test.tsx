import { renderHook, waitFor } from '@testing-library/react';

import { useAutoDismissError } from '@/client/hooks/ui/useAutoDismissError';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('useAutoDismissError', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not call clearError when error is null', () => {
    const clearError = vi.fn();
    renderHook(() => useAutoDismissError(null, clearError, 5000));

    vi.advanceTimersByTime(6000);

    expect(clearError).not.toHaveBeenCalled();
  });

  it('calls clearError after default timeout (10 seconds)', () => {
    const clearError = vi.fn();
    renderHook(() => useAutoDismissError('Test error', clearError));

    expect(clearError).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10000);

    expect(clearError).toHaveBeenCalledTimes(1);
  });

  it('calls clearError after custom timeout', () => {
    const clearError = vi.fn();
    renderHook(() => useAutoDismissError('Test error', clearError, 5000));

    expect(clearError).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5000);

    expect(clearError).toHaveBeenCalledTimes(1);
  });

  it('does not call clearError before timeout expires', () => {
    const clearError = vi.fn();
    renderHook(() => useAutoDismissError('Test error', clearError, 5000));

    vi.advanceTimersByTime(4999);

    expect(clearError).not.toHaveBeenCalled();
  });

  it('resets timer when error changes', () => {
    const clearError = vi.fn();
    const { rerender } = renderHook(
      ({ error }) => useAutoDismissError(error, clearError, 5000),
      { initialProps: { error: 'First error' } },
    );

    vi.advanceTimersByTime(3000);

    // Change error - timer should reset
    rerender({ error: 'Second error' });

    vi.advanceTimersByTime(3000); // Only 6 seconds total, should not have called clearError yet
    expect(clearError).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000); // Now 5 seconds since the error change
    expect(clearError).toHaveBeenCalledTimes(1);
  });

  it('clears timer when error becomes null', () => {
    const clearError = vi.fn();
    const { rerender } = renderHook(
      ({ error }) => useAutoDismissError(error, clearError, 5000),
      { initialProps: { error: 'Test error' as string | null } },
    );

    vi.advanceTimersByTime(3000);

    // Clear error before timeout
    rerender({ error: null });

    vi.advanceTimersByTime(10000); // Advance well past original timeout
    expect(clearError).not.toHaveBeenCalled();
  });

  it('clears timer on unmount', () => {
    const clearError = vi.fn();
    const { unmount } = renderHook(() =>
      useAutoDismissError('Test error', clearError, 5000),
    );

    vi.advanceTimersByTime(3000);

    unmount();

    vi.advanceTimersByTime(5000); // Advance past original timeout
    expect(clearError).not.toHaveBeenCalled();
  });

  it('handles multiple error changes correctly', () => {
    const clearError = vi.fn();
    const { rerender } = renderHook(
      ({ error }) => useAutoDismissError(error, clearError, 2000),
      { initialProps: { error: 'Error 1' } },
    );

    vi.advanceTimersByTime(1000);
    rerender({ error: 'Error 2' });

    vi.advanceTimersByTime(1000);
    rerender({ error: 'Error 3' });

    vi.advanceTimersByTime(2000);

    expect(clearError).toHaveBeenCalledTimes(1);
  });

  it('handles error that is an empty string', () => {
    const clearError = vi.fn();
    renderHook(() => useAutoDismissError('', clearError, 5000));

    vi.advanceTimersByTime(5000);

    // Empty string is falsy in JavaScript, so the hook treats it like no error
    expect(clearError).not.toHaveBeenCalled();
  });

  it('handles very short timeout', () => {
    const clearError = vi.fn();
    renderHook(() => useAutoDismissError('Test error', clearError, 100));

    vi.advanceTimersByTime(100);

    expect(clearError).toHaveBeenCalledTimes(1);
  });

  it('handles very long timeout', () => {
    const clearError = vi.fn();
    renderHook(() => useAutoDismissError('Test error', clearError, 60000));

    vi.advanceTimersByTime(59999);
    expect(clearError).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(clearError).toHaveBeenCalledTimes(1);
  });

  it('clearError is called with no arguments', () => {
    const clearError = vi.fn();
    renderHook(() => useAutoDismissError('Test error', clearError, 1000));

    vi.advanceTimersByTime(1000);

    expect(clearError).toHaveBeenCalledWith();
  });
});
