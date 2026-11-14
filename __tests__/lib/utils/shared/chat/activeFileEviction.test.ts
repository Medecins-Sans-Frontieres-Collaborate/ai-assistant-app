import { evictActiveFilesOverCap } from '@/lib/utils/shared/chat/activeFileEviction';

import { ActiveFile } from '@/types/chat';

import { describe, expect, it } from 'vitest';

const file = (
  id: string,
  addedAt: string,
  over: Partial<ActiveFile> = {},
): ActiveFile => ({
  id,
  url: `/api/file/${id}`,
  originalFilename: `${id}.docx`,
  addedAt,
  sourceMessageId: `m-${id}`,
  status: 'ready',
  ...over,
});

const autoPinned = { pinned: true, autoPinned: true };
const userPinned = { pinned: true };
const ids = (files: ActiveFile[]) => files.map((f) => f.id);

describe('evictActiveFilesOverCap', () => {
  it('leaves a list at the cap untouched', () => {
    const incoming = file('b', '2026-11-02');
    const files = [file('a', '2026-11-01'), incoming];
    expect(ids(evictActiveFilesOverCap(files, 2, incoming))).toEqual([
      'a',
      'b',
    ]);
  });

  it('evicts the oldest unpinned file first', () => {
    const incoming = file('c', '2026-11-03');
    const files = [file('a', '2026-11-01'), file('b', '2026-11-02'), incoming];
    expect(ids(evictActiveFilesOverCap(files, 2, incoming))).toEqual([
      'b',
      'c',
    ]);
  });

  it('evicts auto-pinned files once no unpinned file is left, so auto-pin cannot defeat the cap', () => {
    const incoming = file('c', '2026-11-03', autoPinned);
    const files = [
      file('a', '2026-11-01', autoPinned),
      file('b', '2026-11-02', autoPinned),
      incoming,
    ];
    expect(ids(evictActiveFilesOverCap(files, 2, incoming))).toEqual([
      'b',
      'c',
    ]);
  });

  it('evicts an unpinned file before an older auto-pinned one', () => {
    const incoming = file('c', '2026-11-03', autoPinned);
    const files = [
      file('a', '2026-11-01', autoPinned),
      file('b', '2026-11-02'),
      incoming,
    ];
    expect(ids(evictActiveFilesOverCap(files, 2, incoming))).toEqual([
      'a',
      'c',
    ]);
  });

  it('never evicts files the user pinned, even over the cap', () => {
    const incoming = file('c', '2026-11-03', userPinned);
    const files = [
      file('a', '2026-11-01', userPinned),
      file('b', '2026-11-02', userPinned),
      incoming,
    ];
    expect(ids(evictActiveFilesOverCap(files, 2, incoming))).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('never evicts the incoming file, even when it is the oldest candidate', () => {
    const incoming = file('old', '2026-10-01');
    const files = [file('a', '2026-11-01', userPinned), incoming];
    expect(ids(evictActiveFilesOverCap(files, 1, incoming))).toEqual([
      'a',
      'old',
    ]);
  });
});
