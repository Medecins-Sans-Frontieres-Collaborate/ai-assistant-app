/**
 * Making a version FIT. A per-post character limit is a hard limit: the
 * platform rejects the post, so "a bit over" is not a style problem.
 *
 * Everything here is deterministic and never rewords. Rewording is a
 * model's job and arrives as reviewable suggestions ("Tighten"); what code
 * may do by itself is move words to another post and drop trailing hashtags.
 * What it must NEVER do: truncate silently, cut through a quotation, or drop
 * a link the brief carries.
 */
import { Segment } from '@/types/drafter';

import {
  OverflowOptions,
  moveOverflow,
  pushOverflowForward,
  segmentOverflow,
} from './segments';

export interface FitReport {
  segments: Segment[];
  /** True when every segment now fits. */
  fits: boolean;
  /** Characters still over, per segment id, for what could not be fixed. */
  remaining: Record<string, number>;
}

/** How far over each segment is, by id; empty when everything fits. */
export function overages(
  segments: Segment[],
  options: Pick<OverflowOptions, 'rule' | 'limit' | 'numbered' | 'reserve'>,
): Record<string, number> {
  const result: Record<string, number> = {};
  segments.forEach((segment, index) => {
    const { count } = segmentOverflow(segments, index, options);
    const over =
      count + (options.reserve?.(index, segments.length) ?? 0) - options.limit;
    if (over > 0) result[segment.id] = over;
  });
  return result;
}

/**
 * Moves overflow on until everything fits: into the next segment when that
 * one has room, otherwise into a new one. Stops when the spec's maximum is
 * reached or a pass makes no progress (one unbreakable span longer than a
 * post), and says what is still over. Bounded, so it cannot loop: growing
 * numbering (" 9/9" to " 9/10") can push a fitting post over again, but only
 * while segments are still being added.
 */
export function fitByMoving(
  segments: Segment[],
  options: OverflowOptions,
  mintId: () => string,
): FitReport {
  let current = segments;
  let spare: string | null = null;
  const bound = 4 * (options.maxSegments + segments.length) + 4;
  for (let guard = 0; guard < bound; guard += 1) {
    const over = Object.keys(overages(current, options));
    if (over.length === 0) break;
    let next = current;
    // The first one that can be helped; an unbreakable one must not stop
    // the others from being fixed. An id is only spent on a real split.
    for (const id of over) {
      next = pushOverflowForward(current, id, options);
      if (next === current) {
        spare ??= mintId();
        next = moveOverflow(current, id, spare, options);
        if (next !== current) spare = null;
      }
      if (next !== current) break;
    }
    if (next === current) break;
    current = next;
  }
  const remaining = overages(current, options);
  return {
    segments: current,
    fits: Object.keys(remaining).length === 0,
    remaining,
  };
}

const TRAILING_HASHTAG = /(?:^|\s)#[\p{L}\p{N}_]+\s*$/u;

/**
 * Drops hashtags from the END of a segment, one at a time, until it fits or
 * none are left. Hashtags are discovery aids, never content, so removing
 * one changes nothing a reader was told. Returns the same text when there is
 * nothing to drop; `protectedTail` (a link placed by code) is kept in place.
 */
export function dropTrailingHashtags(
  text: string,
  fits: (candidate: string) => boolean,
  protectedTail = '',
): string {
  const tail =
    protectedTail && text.endsWith(protectedTail) ? protectedTail : '';
  let body = tail ? text.slice(0, text.length - tail.length) : text;
  let changed = false;
  while (!fits(`${body.trimEnd()}${tail}`) && TRAILING_HASHTAG.test(body)) {
    body = body.replace(TRAILING_HASHTAG, '');
    changed = true;
  }
  return changed ? `${body.trimEnd()}${tail}` : text;
}
