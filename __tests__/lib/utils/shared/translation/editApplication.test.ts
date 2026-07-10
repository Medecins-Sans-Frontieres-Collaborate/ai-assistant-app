import {
  applyEdit,
  applyEditsInOrder,
  computeSegmentChanges,
  countOccurrences,
  diffWords,
} from '@/lib/utils/shared/translation/editApplication';

import { describe, expect, it } from 'vitest';

describe('applyEdit', () => {
  it('replaces the first occurrence only', () => {
    const outcome = applyEdit('the cat and the cat', {
      id: 'e1',
      before: 'the cat',
      after: 'a dog',
    });
    expect(outcome).toEqual({ text: 'a dog and the cat', applied: true });
  });

  it('fails when before is absent or empty', () => {
    expect(
      applyEdit('hello', { id: 'e', before: 'bye', after: 'x' }).applied,
    ).toBe(false);
    expect(
      applyEdit('hello', { id: 'e', before: '', after: 'x' }).applied,
    ).toBe(false);
  });
});

describe('countOccurrences', () => {
  it('counts non-overlapping occurrences', () => {
    expect(countOccurrences('ababab', 'ab')).toBe(3);
    expect(countOccurrences('ababab', 'zz')).toBe(0);
    expect(countOccurrences('ababab', '')).toBe(0);
  });
});

describe('applyEditsInOrder', () => {
  it('applies in document order regardless of input order', () => {
    const result = applyEditsInOrder('one two three', [
      { id: 'late', before: 'three', after: 'THREE' },
      { id: 'early', before: 'one', after: 'ONE' },
    ]);
    expect(result.text).toBe('ONE two THREE');
    expect(result.appliedIds).toEqual(['early', 'late']);
    expect(result.failedIds).toEqual([]);
  });

  it('re-locates later edits after earlier applications shift offsets', () => {
    const result = applyEditsInOrder('aaa bbb ccc', [
      { id: 'grow', before: 'aaa', after: 'aaaaaa' },
      { id: 'tail', before: 'ccc', after: 'CCC' },
    ]);
    expect(result.text).toBe('aaaaaa bbb CCC');
    expect(result.failedIds).toEqual([]);
  });

  it('marks edits destroyed by a prior application as failed', () => {
    const result = applyEditsInOrder('hello world', [
      { id: 'a', before: 'hello world', after: 'goodbye' },
      { id: 'b', before: 'world', after: 'planet' },
    ]);
    expect(result.text).toBe('goodbye');
    expect(result.appliedIds).toEqual(['a']);
    expect(result.failedIds).toEqual(['b']);
  });
});

describe('diffWords', () => {
  it('marks replacements as del + ins', () => {
    const parts = diffWords('the red cat', 'the blue cat');
    expect(parts).toEqual([
      { kind: 'same', text: 'the ' },
      { kind: 'del', text: 'red ' },
      { kind: 'ins', text: 'blue ' },
      { kind: 'same', text: 'cat' },
    ]);
  });

  it('handles pure insertion and deletion', () => {
    expect(diffWords('a b', 'a x b').some((p) => p.kind === 'ins')).toBe(true);
    expect(diffWords('a x b', 'a b').some((p) => p.kind === 'del')).toBe(true);
  });

  it('handles non-Latin scripts', () => {
    const parts = diffWords('الوضع مستقر', 'الوضع خطير');
    expect(
      parts.some((p) => p.kind === 'del' && p.text.includes('مستقر')),
    ).toBe(true);
  });
});

describe('computeSegmentChanges', () => {
  it('returns empty for identical texts', () => {
    expect(computeSegmentChanges('Same text.', 'Same text.')).toEqual([]);
  });

  it('reports the changed sentence only', () => {
    const changes = computeSegmentChanges(
      'First sentence. Second sentence. Third sentence.',
      'First sentence. Second CHANGED sentence. Third sentence.',
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].before).toContain('Second sentence');
    expect(changes[0].after).toContain('Second CHANGED sentence');
  });

  it('reports added and removed sentences', () => {
    const added = computeSegmentChanges('One. Two.', 'One. Extra. Two.');
    expect(added).toHaveLength(1);
    expect(added[0].before).toBe('');
    expect(added[0].after).toContain('Extra');

    const removed = computeSegmentChanges('One. Extra. Two.', 'One. Two.');
    expect(removed[0].after).toBe('');
  });

  it('ellipsizes long chip text', () => {
    const long = `${'x'.repeat(400)}.`;
    const changes = computeSegmentChanges(`${long} Same.`, 'Different. Same.', {
      maxChars: 100,
    });
    expect(changes[0].before.length).toBeLessThanOrEqual(100);
    expect(changes[0].before.endsWith('…')).toBe(true);
  });

  it('caps the number of chips', () => {
    const oldText = Array.from({ length: 20 }, (_, i) => `Old ${i}.`).join(' ');
    const newText = Array.from({ length: 20 }, (_, i) => `New ${i}.`).join(' ');
    const changes = computeSegmentChanges(oldText, newText, { maxChanges: 5 });
    expect(changes.length).toBeLessThanOrEqual(5);
  });
});
