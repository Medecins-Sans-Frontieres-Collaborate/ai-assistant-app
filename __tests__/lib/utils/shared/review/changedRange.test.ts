/**
 * Locating what a textarea change touched from its before/after values alone
 * (docs/REVIEW_EDIT_UNFREEZE_DESIGN.md §5).
 */
import { changedRange } from '@/lib/utils/shared/review/editLocation';

import { describe, expect, it } from 'vitest';

describe('changedRange', () => {
  it('reports an insertion as an empty range at the caret', () => {
    expect(changedRange('Hello world', 'Hello brave world')).toEqual({
      from: 6,
      to: 6,
    });
  });

  it('reports a deletion as the removed run', () => {
    expect(changedRange('Hello brave world', 'Hello world')).toEqual({
      from: 6,
      to: 12,
    });
  });

  it('reports a replacement as the replaced run', () => {
    expect(changedRange('The cat sat', 'The dog sat')).toEqual({
      from: 4,
      to: 7,
    });
  });

  it('does not let prefix and suffix overlap on repeated text', () => {
    // Typing an extra "a" into "aaa": the change is one insertion somewhere
    // in the run, never a negative-width range.
    const range = changedRange('aaa', 'aaaa');
    expect(range).not.toBeNull();
    expect(range!.from).toBeLessThanOrEqual(range!.to);
  });

  it('returns null for no change', () => {
    expect(changedRange('same', 'same')).toBeNull();
  });

  it('covers a whole-text replacement', () => {
    expect(changedRange('abc', 'xyz')).toEqual({ from: 0, to: 3 });
  });
});
