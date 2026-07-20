import { act, renderHook } from '@testing-library/react';

import { useEditPreview } from '@/client/hooks/workflows/useEditPreview';

import { describe, expect, it } from 'vitest';

describe('useEditPreview', () => {
  it('starts with nothing previewed', () => {
    const { result } = renderHook(() => useEditPreview(['a', 'b']));
    expect(result.current.activeId).toBeNull();
    expect(result.current.pinnedId).toBeNull();
  });

  it('lets hover win over the pin, so cards always preview what you point at', () => {
    const { result } = renderHook(() => useEditPreview(['a', 'b']));
    act(() => result.current.setPinned('a'));
    expect(result.current.activeId).toBe('a');

    act(() => result.current.setHovered('b'));
    expect(result.current.activeId).toBe('b');
    expect(result.current.pinnedId).toBe('a');

    // Pointer leaves: the pin is what we fall back to.
    act(() => result.current.setHovered(null));
    expect(result.current.activeId).toBe('a');
  });

  it('drops an edit from the preview once it is no longer pending', () => {
    const { result, rerender } = renderHook(({ ids }) => useEditPreview(ids), {
      initialProps: { ids: ['a', 'b'] },
    });
    act(() => result.current.setPinned('a'));
    act(() => result.current.setHovered('a'));
    expect(result.current.activeId).toBe('a');

    // 'a' was accepted — the bar must not linger over changed text.
    rerender({ ids: ['b'] });
    expect(result.current.pinnedId).toBeNull();
    expect(result.current.activeId).toBeNull();
  });

  it('keeps the pin when an unrelated edit resolves', () => {
    const { result, rerender } = renderHook(({ ids }) => useEditPreview(ids), {
      initialProps: { ids: ['a', 'b'] },
    });
    act(() => result.current.setPinned('a'));
    rerender({ ids: ['a'] });
    expect(result.current.pinnedId).toBe('a');
  });

  it('dismisses the pin on Escape', () => {
    const { result } = renderHook(() => useEditPreview(['a']));
    act(() => result.current.setPinned('a'));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(result.current.pinnedId).toBeNull();
  });

  it('clear() resets both hover and pin', () => {
    const { result } = renderHook(() => useEditPreview(['a']));
    act(() => {
      result.current.setPinned('a');
      result.current.setHovered('a');
    });
    act(() => result.current.clear());
    expect(result.current.activeId).toBeNull();
    expect(result.current.pinnedId).toBeNull();
  });
});
