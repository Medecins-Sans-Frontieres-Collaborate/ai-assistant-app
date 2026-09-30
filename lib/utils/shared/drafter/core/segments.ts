/**
 * Segment operations. A version is always an array of segments; a thread is
 * just more than one. Editing a thread behaves like editing paragraphs:
 * split at the caret, merge into the previous one, move an overflow on.
 *
 * All functions are pure and return the same array when nothing changes, so
 * callers can hand the result straight to `updateWorkflowState`.
 */
import { Segment } from '@/types/drafter';

import { CountingRule, countText, overflowIndex } from './counting';

/** " 2/3". Generated, counted against the limit, never typed by hand. */
export function numberingSuffix(index: number, total: number): string {
  return total > 1 ? ` ${index + 1}/${total}` : '';
}

/** The text as it is counted and copied: the body plus its numbering. */
export function renderedSegmentText(
  segments: Segment[],
  index: number,
  numbered: boolean,
): string {
  const text = segments[index]?.text ?? '';
  return numbered ? `${text}${numberingSuffix(index, segments.length)}` : text;
}

export function splitSegment(
  segments: Segment[],
  segmentId: string,
  caret: number,
  newId: string,
): Segment[] {
  const index = segments.findIndex((segment) => segment.id === segmentId);
  if (index < 0) return segments;
  const current = segments[index];
  const at = Math.max(0, Math.min(caret, current.text.length));
  const head = current.text.slice(0, at).trimEnd();
  const tail = current.text.slice(at).trimStart();
  if (!head || !tail) return segments;
  return [
    ...segments.slice(0, index),
    { ...current, text: head },
    { id: newId, text: tail, usedItemIds: current.usedItemIds },
    ...segments.slice(index + 1),
  ];
}

export function mergeWithPrevious(
  segments: Segment[],
  segmentId: string,
): Segment[] {
  const index = segments.findIndex((segment) => segment.id === segmentId);
  if (index <= 0) return segments;
  const previous = segments[index - 1];
  const current = segments[index];
  const joined = [previous.text.trimEnd(), current.text.trimStart()]
    .filter(Boolean)
    .join(' ');
  return [
    ...segments.slice(0, index - 1),
    {
      ...previous,
      text: joined,
      usedItemIds: [
        ...new Set([...previous.usedItemIds, ...current.usedItemIds]),
      ],
      // Merging two posts keeps both posts' images.
      ...((previous.media ?? []).length + (current.media ?? []).length > 0
        ? { media: [...(previous.media ?? []), ...(current.media ?? [])] }
        : {}),
    },
    ...segments.slice(index + 1),
  ];
}

const SENTENCE_END = /[.!?…。！？]["'”’»)\]]*\s+/gu;

/**
 * Last offset at or before `limitIndex` where the text may be cut cleanly:
 * a sentence end if there is one, else a space, else the limit itself.
 */
export function cleanCutBefore(text: string, limitIndex: number): number {
  let sentence = -1;
  for (const match of text.matchAll(SENTENCE_END)) {
    const end = (match.index ?? 0) + match[0].length;
    if (end > limitIndex) break;
    sentence = end;
  }
  if (sentence > 0) return sentence;
  const space = text.lastIndexOf(' ', limitIndex);
  return space > 0 ? space + 1 : limitIndex;
}

export interface OverflowOptions {
  rule: CountingRule;
  limit: number;
  numbered: boolean;
  maxSegments: number;
  /**
   * Spans of the segment's text that must never be cut through: a verbatim
   * quotation, a link. A cut that would land inside one moves to its start,
   * so the whole span goes to the next post intact.
   */
  protectedRanges?: (segment: Segment) => Array<{ start: number; end: number }>;
  /**
   * Room to keep free in segment `index` of `total`, for something code
   * appends afterwards (the brief's links, which are stripped before a fit
   * and placed again after it).
   */
  reserve?: (index: number, total: number) => number;
}

/**
 * Where segment `index` has to be cut to fit in a version of `total`
 * segments: at a sentence or word, never inside a protected span. Null when
 * it fits or cannot be cut.
 */
export function overflowCut(
  segments: Segment[],
  index: number,
  total: number,
  options: OverflowOptions,
): number | null {
  const current = segments[index];
  if (!current) return null;
  const suffix = options.numbered ? numberingSuffix(index, total) : '';
  const budget =
    options.limit -
    countText(options.rule, suffix) -
    (options.reserve?.(index, total) ?? 0);
  const limitIndex = overflowIndex(options.rule, current.text, budget);
  if (limitIndex === null || limitIndex <= 0) return null;
  let cut = cleanCutBefore(current.text, limitIndex);
  // Never through a quotation or a link: those move whole, or not at all.
  for (const range of options.protectedRanges?.(current) ?? []) {
    if (cut > range.start && cut < range.end) cut = range.start;
  }
  // Back over the opening quotation mark and any space before the span.
  while (cut > 0 && /[\s"“«„‘‹]/u.test(current.text[cut - 1])) cut -= 1;
  return cut > 0 ? cut : null;
}

/**
 * Moves what does not fit in a segment to a new segment after it. The
 * deterministic fix offered before any model call: nothing is reworded.
 * Returns the same array when the segment fits, cannot be cut, or the spec
 * allows no further segment.
 */
export function moveOverflow(
  segments: Segment[],
  segmentId: string,
  newId: string,
  options: OverflowOptions,
): Segment[] {
  const index = segments.findIndex((segment) => segment.id === segmentId);
  if (index < 0 || segments.length >= options.maxSegments) return segments;
  // The numbering grows with the thread, so budget for the thread as it
  // will be after the split.
  const cut = overflowCut(segments, index, segments.length + 1, options);
  if (cut === null) return segments;
  return splitSegment(segments, segmentId, cut, newId);
}

/**
 * Moves what does not fit in a segment to the START of the next one, when
 * the next one has room for it. Kinder than a new post: a thread that is one
 * sentence over does not grow a one-sentence post. Returns the same array
 * when there is no next segment, nothing to move, or no room there.
 */
export function pushOverflowForward(
  segments: Segment[],
  segmentId: string,
  options: OverflowOptions,
): Segment[] {
  const index = segments.findIndex((segment) => segment.id === segmentId);
  const next = segments[index + 1];
  if (index < 0 || !next) return segments;
  const cut = overflowCut(segments, index, segments.length, options);
  if (cut === null) return segments;
  const current = segments[index];
  const head = current.text.slice(0, cut).trimEnd();
  const tail = current.text.slice(cut).trimStart();
  if (!head || !tail) return segments;
  const moved: Segment = {
    ...next,
    text: `${tail} ${next.text}`,
    usedItemIds: [...new Set([...current.usedItemIds, ...next.usedItemIds])],
  };
  const result = segments.map((segment, at) =>
    at === index
      ? { ...current, text: head }
      : at === index + 1
        ? moved
        : segment,
  );
  const room =
    options.limit -
    (options.reserve?.(index + 1, segments.length) ?? 0) -
    countText(
      options.rule,
      renderedSegmentText(result, index + 1, options.numbered),
    );
  return room >= 0 ? result : segments;
}

/** Where a segment's text stops fitting, numbering included; null = fits. */
export function segmentOverflow(
  segments: Segment[],
  index: number,
  options: Pick<OverflowOptions, 'rule' | 'limit' | 'numbered'>,
): { count: number; over: number; overflowAt: number | null } {
  const suffix = options.numbered
    ? numberingSuffix(index, segments.length)
    : '';
  const body = segments[index]?.text ?? '';
  const count = countText(options.rule, `${body}${suffix}`);
  const budget = options.limit - countText(options.rule, suffix);
  return {
    count,
    over: Math.max(0, count - options.limit),
    overflowAt: overflowIndex(options.rule, body, budget),
  };
}
