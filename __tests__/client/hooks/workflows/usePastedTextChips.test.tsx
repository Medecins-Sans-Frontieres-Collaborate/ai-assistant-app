/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';

import { usePastedTextChips } from '@/client/hooks/workflows/usePastedTextChips';

import { describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  // Echo the key (with its name param) so assertions can identify the string.
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values?.name ? `${key}:${String(values.name)}` : key,
}));

describe('usePastedTextChips', () => {
  it('starts empty and reports nothing held', () => {
    const { result } = renderHook(() => usePastedTextChips());
    expect(result.current.chips).toEqual([]);
    expect(result.current.hasChips).toBe(false);
  });

  it('holds a paste with a name derived from its opening line', () => {
    const { result } = renderHook(() => usePastedTextChips());

    act(() => result.current.attachPastedText('Budget notes\nthe rest'));

    expect(result.current.chips).toHaveLength(1);
    expect(result.current.chips[0].name).toBe('Budget notes');
    expect(result.current.chips[0].chars).toBe('Budget notes\nthe rest'.length);
    expect(result.current.hasChips).toBe(true);
  });

  it('ignores empty and whitespace-only pastes', () => {
    const { result } = renderHook(() => usePastedTextChips());

    act(() => result.current.attachPastedText('   \n  '));

    expect(result.current.chips).toEqual([]);
  });

  it('treats the same text pasted twice as a repeat, not a second source', () => {
    const { result } = renderHook(() => usePastedTextChips());

    act(() => result.current.attachPastedText('same content'));
    act(() => result.current.attachPastedText('same content'));

    expect(result.current.chips).toHaveLength(1);
  });

  it('holds distinct pastes separately', () => {
    const { result } = renderHook(() => usePastedTextChips());

    act(() => result.current.attachPastedText('first'));
    act(() => result.current.attachPastedText('second'));

    expect(result.current.chips).toHaveLength(2);
  });

  it('removes a chip by id', () => {
    const { result } = renderHook(() => usePastedTextChips());

    act(() => result.current.attachPastedText('first'));
    act(() => result.current.attachPastedText('second'));
    act(() => result.current.removeChip(result.current.chips[0].id));

    expect(result.current.chips).toHaveLength(1);
    expect(result.current.chips[0].name).toBe('second');
  });

  it('clears every chip', () => {
    const { result } = renderHook(() => usePastedTextChips());

    act(() => result.current.attachPastedText('first'));
    act(() => result.current.attachPastedText('second'));
    act(() => result.current.clearChips());

    expect(result.current.chips).toEqual([]);
    expect(result.current.hasChips).toBe(false);
  });

  it('returns the instruction untouched when nothing is held', () => {
    const { result } = renderHook(() => usePastedTextChips());
    expect(result.current.composeWithChips('summarize this')).toBe(
      'summarize this',
    );
  });

  it('folds held pastes in after the instruction, each labeled', () => {
    const { result } = renderHook(() => usePastedTextChips());

    act(() => result.current.attachPastedText('Notes\nalpha'));

    expect(result.current.composeWithChips('summarize this')).toBe(
      'summarize this\n\n--- blockLabel:Notes ---\nNotes\nalpha',
    );
  });

  it('composes from the chips alone when the instruction is empty', () => {
    const { result } = renderHook(() => usePastedTextChips());

    act(() => result.current.attachPastedText('Notes\nalpha'));

    // An empty instruction must not leave a leading blank line — the
    // material is a complete message on its own.
    expect(result.current.composeWithChips('')).toBe(
      '--- blockLabel:Notes ---\nNotes\nalpha',
    );
  });

  it('keeps chips in the order they were pasted', () => {
    const { result } = renderHook(() => usePastedTextChips());

    act(() => result.current.attachPastedText('Alpha\none'));
    act(() => result.current.attachPastedText('Beta\ntwo'));

    const composed = result.current.composeWithChips('go');
    expect(composed.indexOf('Alpha')).toBeLessThan(composed.indexOf('Beta'));
  });
});
