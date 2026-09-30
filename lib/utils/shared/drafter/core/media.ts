/**
 * Images on a version. An image is part of what a post SAYS, so it is part
 * of what the user approves: every stamp that remembers "the text as it was"
 * (approved, copied, sent) remembers the images and their alt text too, and
 * lapses when either changes.
 *
 * Pure. Only references and alt text are handled here; bytes never are.
 */
import {
  DRAFTER_LIMITS,
  MediaAttachment,
  Segment,
  Version,
} from '@/types/drafter';

/** One string per segment that changes when its images or alt text do. */
export function mediaSignatures(segments: Segment[]): string[] {
  return segments.map((segment) =>
    (segment.media ?? [])
      .map((item) => `${item.ref}\u0000${item.alt}`)
      .join('\u0001'),
  );
}

/**
 * Whether stamped signatures still describe these segments. A stamp made
 * before images existed has none, which means "no images then".
 */
export function sameMedia(
  stamped: string[] | undefined,
  segments: Segment[],
): boolean {
  const now = mediaSignatures(segments);
  const then = stamped ?? now.map(() => '');
  return then.length === now.length && then.every((sig, i) => sig === now[i]);
}

export function hasMedia(
  version: Pick<Version, 'segments'> | undefined,
): boolean {
  return !!version?.segments.some(
    (segment) => (segment.media ?? []).length > 0,
  );
}

function withMedia(
  segments: Segment[],
  segmentId: string,
  update: (media: MediaAttachment[]) => MediaAttachment[],
): Segment[] {
  const target = segments.find((segment) => segment.id === segmentId);
  if (!target) return segments;
  const current = target.media ?? [];
  const next = update(current);
  if (next === current) return segments;
  return segments.map((segment) => {
    if (segment.id !== segmentId) return segment;
    if (next.length > 0) return { ...segment, media: next };
    const { media: _media, ...rest } = segment;
    return rest;
  });
}

export function addMedia(
  segments: Segment[],
  segmentId: string,
  attachment: MediaAttachment,
): Segment[] {
  return withMedia(segments, segmentId, (media) =>
    media.length >= DRAFTER_LIMITS.MAX_MEDIA_PER_SEGMENT ||
    media.some((item) => item.id === attachment.id)
      ? media
      : [
          ...media,
          {
            ...attachment,
            alt: attachment.alt.slice(0, DRAFTER_LIMITS.MAX_ALT_CHARS),
          },
        ],
  );
}

export function removeMedia(
  segments: Segment[],
  segmentId: string,
  mediaId: string,
): Segment[] {
  return withMedia(segments, segmentId, (media) =>
    media.some((item) => item.id === mediaId)
      ? media.filter((item) => item.id !== mediaId)
      : media,
  );
}

export function setMediaAlt(
  segments: Segment[],
  segmentId: string,
  mediaId: string,
  alt: string,
): Segment[] {
  const capped = alt.slice(0, DRAFTER_LIMITS.MAX_ALT_CHARS);
  return withMedia(segments, segmentId, (media) => {
    const item = media.find((entry) => entry.id === mediaId);
    return !item || item.alt === capped
      ? media
      : media.map((entry) =>
          entry.id === mediaId ? { ...entry, alt: capped } : entry,
        );
  });
}

/**
 * Carries the user's images onto a rewrite. A model writes words, never
 * images, so accepting a new version must not throw the images away: each
 * new segment inherits those of the segment it replaces, and any left over
 * (the rewrite has fewer posts) land on the last one.
 */
export function carryMedia(previous: Segment[], next: Segment[]): Segment[] {
  if (next.length === 0 || !previous.some((s) => (s.media ?? []).length > 0)) {
    return next;
  }
  const leftover = previous
    .slice(next.length)
    .flatMap((segment) => segment.media ?? []);
  const max = DRAFTER_LIMITS.MAX_MEDIA_PER_SEGMENT;
  const buckets = next.map((_, index) => [
    ...(previous[index]?.media ?? []),
    ...(index === next.length - 1 ? leftover : []),
  ]);
  // An image is never dropped to make a number come out: history keeps
  // words only, so a dropped image is gone. What one segment cannot hold
  // goes to the nearest earlier one with room; if there is none it stays,
  // and the image check says so.
  for (let index = buckets.length - 1; index > 0; index -= 1) {
    while (buckets[index].length > max) {
      let room = index - 1;
      while (room >= 0 && buckets[room].length >= max) room -= 1;
      if (room < 0) break;
      buckets[room].push(buckets[index].splice(max, 1)[0]);
    }
  }
  return next.map((segment, index) =>
    buckets[index].length > 0 ? { ...segment, media: buckets[index] } : segment,
  );
}
