import { emptyBrief } from '@/lib/utils/shared/drafter/core/brief';
import {
  addMedia,
  carryMedia,
  hasMedia,
  removeMedia,
  setMediaAlt,
} from '@/lib/utils/shared/drafter/core/media';
import {
  mergeWithPrevious,
  splitSegment,
} from '@/lib/utils/shared/drafter/core/segments';
import {
  applyGenerated,
  approvalStatus,
  approveVersion,
  changedSinceCopied,
  emptyVersion,
  markCopied,
  restoreSnapshot,
  setSegments,
  useProposed,
} from '@/lib/utils/shared/drafter/core/versions';

import { MediaAttachment, Segment, Version } from '@/types/drafter';

import { describe, expect, it } from 'vitest';

const NOW = '2026-09-21T10:00:00.000Z';
const REF = `/api/file/${'a'.repeat(64)}.jpg`;

function image(id: string, alt = ''): MediaAttachment {
  return { id, ref: REF, name: `${id}.jpg`, alt };
}

function seg(id: string, text: string, media?: MediaAttachment[]): Segment {
  return { id, text, usedItemIds: [], ...(media ? { media } : {}) };
}

function version(segments: Segment[]): Version {
  return { ...emptyVersion('x'), segments };
}

describe('media transitions', () => {
  const segments = [seg('a', 'First.'), seg('b', 'Second.')];

  it('adds, describes and removes an image on one segment only', () => {
    const added = addMedia(segments, 'b', image('m1'));
    expect(added[0]).toBe(segments[0]);
    expect(added[1].media).toEqual([image('m1')]);

    const described = setMediaAlt(
      added,
      'b',
      'm1',
      'A nurse fills a jerrycan.',
    );
    expect(described[1].media?.[0].alt).toBe('A nurse fills a jerrycan.');

    const removed = removeMedia(described, 'b', 'm1');
    expect(removed[1]).not.toHaveProperty('media');
  });

  it('returns the same array when nothing changes', () => {
    const added = addMedia(segments, 'a', image('m1'));
    expect(addMedia(added, 'a', image('m1'))).toBe(added);
    expect(setMediaAlt(added, 'a', 'm1', '')).toBe(added);
    expect(removeMedia(added, 'a', 'ghost')).toBe(added);
    expect(addMedia(segments, 'ghost', image('m1'))).toBe(segments);
  });

  it('knows whether a version carries any image', () => {
    expect(hasMedia(version(segments))).toBe(false);
    expect(hasMedia(version(addMedia(segments, 'a', image('m1'))))).toBe(true);
  });
});

describe('an image is part of what is approved', () => {
  const base = version([seg('a', 'The post.')]);

  it('lapses when an image is added, its alt text changes, or it is removed', () => {
    const approved = approveVersion(base, NOW);
    const withImage = setSegments(
      approved,
      addMedia(approved.segments, 'a', image('m1', 'A clinic.')),
    );
    expect(approvalStatus(withImage)).toBe('changed');

    const reapproved = approveVersion(withImage, NOW);
    expect(approvalStatus(reapproved)).toBe('approved');
    const newAlt = setSegments(
      reapproved,
      setMediaAlt(reapproved.segments, 'a', 'm1', 'A clinic at dawn.'),
    );
    expect(approvalStatus(newAlt)).toBe('changed');
    const removed = setSegments(
      reapproved,
      removeMedia(reapproved.segments, 'a', 'm1'),
    );
    expect(approvalStatus(removed)).toBe('changed');
  });

  it('still honours an approval made before images existed', () => {
    const old: Version = {
      ...base,
      approval: { at: NOW, texts: ['The post.'] },
    };
    expect(approvalStatus(old)).toBe('approved');
  });

  it('notices an image change after copying', () => {
    const copied = markCopied(base, NOW);
    expect(changedSinceCopied(copied)).toBe(false);
    expect(
      changedSinceCopied(
        setSegments(copied, addMedia(copied.segments, 'a', image('m1', 'x'))),
      ),
    ).toBe(true);
  });
});

describe('images survive what rewrites the words', () => {
  it('carries each post’s images onto the rewrite, leftovers to the last post', () => {
    const previous = [
      seg('a', 'One.', [image('m1', 'one')]),
      seg('b', 'Two.'),
      seg('c', 'Three.', [image('m3', 'three')]),
    ];
    const carried = carryMedia(previous, [
      seg('n1', 'New one.'),
      seg('n2', 'New two.'),
    ]);
    expect(carried[0].media?.map((m) => m.id)).toEqual(['m1']);
    expect(carried[1].media?.map((m) => m.id)).toEqual(['m3']);
  });

  it('keeps images when a new version from the brief is accepted', () => {
    const brief = emptyBrief();
    const current = version([seg('a', 'Old words.', [image('m1', 'alt')])]);
    const proposed = applyGenerated(
      current,
      { specId: 'x', segments: [{ text: 'New words.', usedItemIds: [] }] },
      brief,
      ['n1'],
      'brief',
    );
    const accepted = useProposed(proposed, brief, NOW);
    expect(accepted.segments[0].text).toBe('New words.');
    expect(accepted.segments[0].media?.[0].id).toBe('m1');
  });

  it('keeps images when an earlier version is restored from history', () => {
    const current = version([seg('a', 'Now.', [image('m1', 'alt')])]);
    const restored = restoreSnapshot(
      current,
      { at: NOW, reason: 'generated', texts: ['Before.'] },
      ['r1'],
      NOW,
    );
    expect(restored.segments[0].text).toBe('Before.');
    expect(restored.segments[0].media?.[0].id).toBe('m1');
  });

  it('a split leaves images with the first part; a merge keeps both posts’', () => {
    const split = splitSegment(
      [seg('a', 'First sentence. Second sentence.', [image('m1', 'alt')])],
      'a',
      16,
      'n',
    );
    expect(split[0].media?.map((m) => m.id)).toEqual(['m1']);
    expect(split[1]).not.toHaveProperty('media');

    const merged = mergeWithPrevious(
      [
        seg('a', 'One.', [image('m1', '1')]),
        seg('b', 'Two.', [image('m2', '2')]),
      ],
      'b',
    );
    expect(merged[0].media?.map((m) => m.id)).toEqual(['m1', 'm2']);
  });
});
