import { applyEdit } from '@/lib/utils/shared/review/editApplication';
import {
  hasResolvedEdits,
  invertPatch,
  isResolved,
  withoutResolvedEdits,
} from '@/lib/utils/shared/review/reviewQueue';

import { describe, expect, it } from 'vitest';

const QUEUE = [
  { id: 'p', status: 'pending' as const },
  { id: 'a', status: 'accepted' as const },
  { id: 'r', status: 'rejected' as const },
  { id: 'u', status: 'unapplicable' as const },
];

describe('isResolved / hasResolvedEdits', () => {
  it('treats anything but pending as resolved', () => {
    expect(isResolved('pending')).toBe(false);
    expect(isResolved('accepted')).toBe(true);
    expect(isResolved('rejected')).toBe(true);
    expect(isResolved('unapplicable')).toBe(true);
  });

  it('detects a decision record to clear', () => {
    expect(hasResolvedEdits(QUEUE)).toBe(true);
    expect(hasResolvedEdits([{ status: 'pending' }])).toBe(false);
    expect(hasResolvedEdits([])).toBe(false);
  });
});

describe('withoutResolvedEdits', () => {
  it('drops every decided edit by default', () => {
    expect(withoutResolvedEdits(QUEUE).map((e) => e.id)).toEqual(['p']);
  });

  it('keeps unapplicable edits when asked (the auto-clear path)', () => {
    // An edit that silently failed to apply must not be swept away
    // without the user ever seeing it.
    expect(
      withoutResolvedEdits(QUEUE, { keepUnapplicable: true }).map((e) => e.id),
    ).toEqual(['p', 'u']);
  });

  it('leaves a queue of only pending edits untouched', () => {
    const pending = [{ id: 'p', status: 'pending' as const }];
    expect(withoutResolvedEdits(pending)).toEqual(pending);
  });
});

describe('invertPatch', () => {
  it('swaps the two sides so the change can be undone', () => {
    expect(invertPatch({ id: 'a', before: 'quick', after: 'swift' })).toEqual({
      id: 'a',
      before: 'swift',
      after: 'quick',
    });
  });

  it('round-trips an applied edit back to the original text', () => {
    const edit = { id: 'a', before: 'quick', after: 'swift' };
    const applied = applyEdit('The quick fox', edit);
    expect(applied.text).toBe('The swift fox');

    const reverted = applyEdit(applied.text, invertPatch(edit)!);
    expect(reverted.applied).toBe(true);
    expect(reverted.text).toBe('The quick fox');
  });

  it('refuses a pure deletion, whose position is unrecoverable', () => {
    expect(
      invertPatch({ id: 'd', before: 'redundant ', after: '' }),
    ).toBeNull();
  });

  it('reports failure rather than corrupting text it cannot locate', () => {
    const edit = { id: 'a', before: 'quick', after: 'swift' };
    // The user rewrote the sentence after accepting — no 'swift' left.
    const outcome = applyEdit(
      'A totally different sentence',
      invertPatch(edit)!,
    );
    expect(outcome.applied).toBe(false);
    expect(outcome.text).toBe('A totally different sentence');
  });
});
