/**
 * How a post will roughly LOOK on its channel, as a model a component can
 * draw (docs/CHANNEL_DRAFTER_DESIGN.md §9.14). Text fidelity only.
 *
 * It reads the same profile table as the checks and the counters, so a
 * preview can never disagree with them: the fold is the channel's
 * opening-line slot, the verdict is the same overflow computation, the
 * numbering is the same suffix. Nothing here knows a platform by name.
 *
 * Every token keeps its offset in the segment's own text, so pressing a
 * word in the preview can put the caret at that word in the editor.
 */
import { countText } from '@/lib/utils/shared/drafter/core/counting';
import {
  numberingSuffix,
  segmentOverflow,
} from '@/lib/utils/shared/drafter/core/segments';

import { BriefLink, ChannelProfile, Segment } from '@/types/drafter';

import { isNumbered } from './channelProfiles';

export type PreviewTokenKind = 'text' | 'link' | 'hashtag' | 'mention';

export interface PreviewToken {
  kind: PreviewTokenKind;
  /** What the reader sees (a link is shown shortened). */
  display: string;
  /** Offset of the token in the segment's text. */
  start: number;
}

/** A link shown as a card. Title and host only: that is all that is known. */
export interface PreviewLinkCard {
  title: string;
  host: string;
}

export interface PreviewMedia {
  id: string;
  ref: string;
  alt: string;
}

export interface PreviewSegment {
  id: string;
  /** Attached images, in order. */
  media: PreviewMedia[];
  /** Cards for the brief's links that this segment carries. */
  linkCards: PreviewLinkCard[];
  /** Shown before the fold. */
  visible: PreviewToken[];
  /** Behind "see more"; empty when the channel does not fold this post. */
  hidden: PreviewToken[];
  /** Label key of the fold ("seeMore"), when there is something behind it. */
  foldLabelKey?: string;
  /** "2/3", generated, when the channel numbers a thread. */
  numbering?: string;
  count: number;
  limit: number;
  over: number;
}

/** Longest link text shown before it is cut, as most platforms do. */
const LINK_DISPLAY_CHARS = 32;

const TOKEN_PATTERN =
  /(?<link>\b(?:https?:\/\/|www\.)[^\s<>"']+)|(?<hashtag>(?<![\p{L}\p{N}_])#[\p{L}\p{N}_]+)|(?<mention>(?<![\p{L}\p{N}_.])@[\p{L}\p{N}_.]+)/giu;

/** A link as platforms show it: no scheme, no "www.", cut with an ellipsis. */
export function displayLink(url: string): string {
  const bare = url.replace(/^https?:\/\//iu, '').replace(/^www\./iu, '');
  const trimmed = bare.replace(/\/$/u, '');
  return trimmed.length > LINK_DISPLAY_CHARS
    ? `${trimmed.slice(0, LINK_DISPLAY_CHARS - 1)}…`
    : trimmed;
}

/** Trailing punctuation belongs to the sentence, not to the link. */
function trimLinkEnd(url: string): string {
  return url.replace(/[.,;:!?)\]}'"»”]+$/u, '');
}

export function tokenize(text: string, offset = 0): PreviewToken[] {
  const tokens: PreviewToken[] = [];
  let cursor = 0;
  const pushText = (from: number, to: number): void => {
    if (to > from) {
      tokens.push({
        kind: 'text',
        display: text.slice(from, to),
        start: offset + from,
      });
    }
  };
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const start = match.index ?? 0;
    const groups = match.groups ?? {};
    const raw = groups.link ? trimLinkEnd(match[0]) : match[0];
    if (!raw) continue;
    pushText(cursor, start);
    tokens.push({
      kind: groups.link ? 'link' : groups.hashtag ? 'hashtag' : 'mention',
      display: groups.link ? displayLink(raw) : raw,
      start: offset + start,
    });
    cursor = start + raw.length;
  }
  pushText(cursor, text.length);
  return tokens;
}

/** Platforms collapse runs of blank lines to one. */
function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/gu, '\n\n');
}

/**
 * Where the first post folds: at the end of its first line when that line
 * fits the opening-line slot, otherwise at the slot's limit, cut at a word.
 * Null when the channel has no fold or nothing would be hidden.
 */
export function foldIndex(
  profile: ChannelProfile,
  text: string,
): number | null {
  const slot = profile.slots.find(
    (entry) =>
      entry.appliesTo === 'first-segment-first-line' && !!entry.foldLabelKey,
  );
  if (!slot) return null;
  const lineEnd = text.indexOf('\n');
  const firstLine = lineEnd < 0 ? text : text.slice(0, lineEnd);
  if (countText(profile.counting, firstLine) <= slot.maxChars) {
    // The whole first line shows; fold only if something follows it.
    return lineEnd < 0 || !text.slice(lineEnd).trim() ? null : lineEnd;
  }
  // The line itself is too long: the platform cuts inside it.
  let cut = 0;
  let total = 0;
  for (const char of firstLine) {
    total += countText(profile.counting, char);
    if (total > slot.maxChars) break;
    cut += char.length;
  }
  const space = firstLine.lastIndexOf(' ', cut);
  return space > 0 ? space : cut;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./iu, '');
  } catch {
    return '';
  }
}

export function buildChannelPreview(
  profile: ChannelProfile,
  segments: Segment[],
  links: BriefLink[] = [],
): PreviewSegment[] {
  const numbered = isNumbered(profile);
  return segments.map((segment, index) => {
    const text = collapseBlankLines(segment.text);
    // Offsets stay true to the editor's text only when nothing was
    // collapsed before them; after a collapse they are approximate, which
    // is fine for "put the caret near here".
    const fold = index === 0 ? foldIndex(profile, text) : null;
    const { count, over } = segmentOverflow(segments, index, {
      rule: profile.counting,
      limit: profile.segmentLimit,
      numbered,
    });
    const slot = profile.slots.find((entry) => !!entry.foldLabelKey);
    return {
      id: segment.id,
      media: (segment.media ?? []).map(({ id, ref, alt }) => ({
        id,
        ref,
        alt,
      })),
      // Only links the brief carries get a card: their title is known. A
      // channel that cannot carry links shows none.
      linkCards: profile.links.allowed
        ? links
            .filter((link) => segment.text.includes(link.url))
            .map((link) => ({ title: link.label, host: hostOf(link.url) }))
        : [],
      visible: tokenize(fold === null ? text : text.slice(0, fold)),
      hidden: fold === null ? [] : tokenize(text.slice(fold), fold),
      foldLabelKey: fold === null ? undefined : slot?.foldLabelKey,
      numbering: numbered
        ? numberingSuffix(index, segments.length).trim() || undefined
        : undefined,
      count,
      limit: profile.segmentLimit,
      over,
    };
  });
}
