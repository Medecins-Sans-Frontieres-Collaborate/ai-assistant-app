/**
 * Anchored edit application.
 *
 * The case that motivates all of this: once the working text can change while
 * edits are pending, first-occurrence matching can silently retarget a
 * suggestion at a passage the reviewer never saw. Staleness was never the
 * danger — that degrades to `unapplicable` — mis-application was.
 */
import {
  ANCHOR_CONTEXT_CHARS,
  applyEdit,
  applyEditsInOrder,
  locateEditTarget,
} from '@/lib/utils/shared/review/editApplication';
import { stampEditAnchors } from '@/lib/utils/shared/review/editLocation';
import { invertPatch } from '@/lib/utils/shared/review/reviewQueue';

import { describe, expect, it } from 'vitest';

describe('locateEditTarget', () => {
  it('falls back to first occurrence with no hints', () => {
    expect(locateEditTarget('a cat and a cat', 'cat')).toBe(2);
  });

  it('picks the occurrence nearest the anchor when that is all it has', () => {
    const text = 'a cat and a cat and a cat';
    expect(locateEditTarget(text, 'cat', { anchorStart: 0 })).toBe(2);
    expect(locateEditTarget(text, 'cat', { anchorStart: 12 })).toBe(12);
    expect(locateEditTarget(text, 'cat', { anchorStart: 25 })).toBe(22);
  });

  it('tolerates an anchor that no longer lines up exactly', () => {
    // Text grew by 7 chars before the target; the offset is stale but still
    // closest to the right occurrence.
    const text = 'PREFIX a cat and a cat';
    expect(locateEditTarget(text, 'cat', { anchorStart: 12 })).toBe(9);
  });

  it('lets context outvote distance', () => {
    // The nearer occurrence is a decoy; the surroundings name the real one.
    const text = 'the grey cat sat. the black cat sat.';
    expect(
      locateEditTarget(text, 'cat', {
        anchorStart: 9,
        anchorContext: 'the black ',
      }),
    ).toBe(28);
  });

  it('falls back to distance when no candidate matches the context', () => {
    const text = 'a cat and a cat';
    expect(
      locateEditTarget(text, 'cat', {
        anchorStart: 12,
        anchorContext: 'nothing alike ',
      }),
    ).toBe(12);
  });

  it('returns -1 for an empty or absent target', () => {
    expect(locateEditTarget('some text', '', { anchorStart: 0 })).toBe(-1);
    expect(locateEditTarget('some text', 'missing', { anchorStart: 0 })).toBe(
      -1,
    );
  });

  it('walks occurrences non-overlapping', () => {
    expect(locateEditTarget('aaaa', 'aa', { anchorStart: 3 })).toBe(2);
  });
});

describe('applyEdit with anchors', () => {
  const text = 'The amount shown is wrong. The amount shown is right.';

  it('rewrites the anchored occurrence, not the first one', () => {
    const result = applyEdit(text, {
      id: 'e1',
      before: 'The amount shown',
      after: 'The total shown',
      anchorStart: 27,
      anchorContext: 'is wrong. ',
    });
    expect(result.applied).toBe(true);
    expect(result.text).toBe(
      'The amount shown is wrong. The total shown is right.',
    );
  });

  it('does NOT retarget when the user creates an earlier copy', () => {
    // The reviewer approved the change to the SECOND sentence. The user then
    // typed a new opening line containing the same phrase. Unanchored, this
    // is exactly the silent mis-application the freeze was hiding — and the
    // decoy lands NEARER the old offset than the real target now sits, so
    // distance alone would pick it too. Only the context saves it.
    const original = 'Intro line. This needs review.';
    const stamped = stampEditAnchors(original, [
      { id: 'e1', before: 'needs review', after: 'is final' },
    ])[0];

    const edited = 'A note that needs review was added. This needs review.';
    const result = applyEdit(edited, { ...stamped, after: 'is final' });

    expect(result.text).toBe(
      'A note that needs review was added. This is final.',
    );
  });

  it('still reports unapplied when the anchored text is gone entirely', () => {
    const result = applyEdit('nothing like it here', {
      id: 'e1',
      before: 'needs review',
      after: 'is final',
      anchorStart: 5,
      anchorContext: 'This ',
    });
    expect(result.applied).toBe(false);
    expect(result.text).toBe('nothing like it here');
  });

  it('is byte-identical to first-occurrence matching without an anchor', () => {
    const patch = { id: 'e1', before: 'cat', after: 'dog' };
    expect(applyEdit('a cat and a cat', patch).text).toBe('a dog and a cat');
  });
});

describe('applyEditsInOrder with anchors', () => {
  it('applies two edits sharing one `before` to their own occurrences', () => {
    const text = 'Fix this. Keep that. Fix this.';
    const edits = stampEditAnchors(text, [
      { id: 'a', before: 'Fix this.', after: 'First done.' },
      { id: 'b', before: 'Fix this.', after: 'Second done.' },
    ]).map((edit, index) => ({
      ...edit,
      after: index === 0 ? 'First done.' : 'Second done.',
    }));

    const result = applyEditsInOrder(text, edits);

    expect(result.failedIds).toEqual([]);
    expect(result.text).toBe('First done. Keep that. Second done.');
  });

  it('reports the ones it could not place', () => {
    const result = applyEditsInOrder('only this remains', [
      { id: 'a', before: 'only this', after: 'just this', anchorStart: 0 },
      { id: 'b', before: 'vanished', after: 'x', anchorStart: 40 },
    ]);
    expect(result.appliedIds).toEqual(['a']);
    expect(result.failedIds).toEqual(['b']);
  });
});

describe('stampEditAnchors', () => {
  it('gives two edits with the same target different occurrences', () => {
    const text = 'ping. pong. ping.';
    const stamped = stampEditAnchors(text, [
      { id: 'a', before: 'ping.' },
      { id: 'b', before: 'ping.' },
    ]);
    const anchors = stamped.map((edit) => edit.anchorStart).sort();
    expect(anchors).toEqual([0, 12]);
    // …and each records what precedes ITS occurrence.
    expect(stamped.find((e) => e.anchorStart === 12)?.anchorContext).toBe(
      'ping. pong. ',
    );
  });

  it('caps the stored context so an assessment stays small', () => {
    const text = `${'x'.repeat(200)}target`;
    const [stamped] = stampEditAnchors(text, [{ id: 'a', before: 'target' }]);
    expect(stamped.anchorContext).toHaveLength(ANCHOR_CONTEXT_CHARS);
  });

  it('leaves an unlocatable edit unanchored rather than guessing', () => {
    const stamped = stampEditAnchors('some text', [
      { id: 'a', before: 'absent' },
    ]);
    expect(stamped[0]).not.toHaveProperty('anchorStart');
  });

  it('is a no-op on empty text', () => {
    const edits = [{ id: 'a', before: 'x' }];
    expect(stampEditAnchors('', edits)).toEqual(edits);
  });
});

describe('invertPatch', () => {
  it('carries the anchor so an undo lands where the edit did', () => {
    const inverse = invertPatch({
      id: 'e1',
      before: 'old',
      after: 'new',
      anchorStart: 42,
      anchorContext: 'preceded by ',
    });
    expect(inverse).toEqual({
      id: 'e1',
      before: 'new',
      after: 'old',
      anchorStart: 42,
      anchorContext: 'preceded by ',
    });
  });

  it('omits the anchor when there was none', () => {
    expect(invertPatch({ id: 'e1', before: 'old', after: 'new' })).toEqual({
      id: 'e1',
      before: 'new',
      after: 'old',
    });
  });

  it('still refuses to invert a pure deletion', () => {
    expect(
      invertPatch({ id: 'e1', before: 'gone', after: '', anchorStart: 3 }),
    ).toBeNull();
  });
});
