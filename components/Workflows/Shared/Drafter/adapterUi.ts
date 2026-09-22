import {
  Brief,
  BriefLink,
  Segment,
  Version,
  VersionSpec,
} from '@/types/drafter';

/** What a kind of spec shows beside one segment: its budget and overflow. */
export interface SegmentMeta {
  /** "241 / 280", already formatted with the spec's counting rule. */
  count: number;
  limit: number;
  over: number;
  /** Offset in the segment text where it stops fitting; null = fits. */
  overflowAt: number | null;
  /** "2/3" when the spec numbers its segments. */
  numbering?: string;
}

/** A slot drawn in the text, e.g. the opening line before a "see more" fold. */
export interface SlotMeta {
  labelKey: string;
  foldLabelKey?: string;
  count: number;
  max: number;
}

/** One run of a previewed segment: plain text, or something shown as a link. */
export interface PreviewTokenModel {
  kind: 'text' | 'link' | 'hashtag' | 'mention';
  /** What the reader sees. */
  display: string;
  /** Offset in the segment's own text, to put the caret back there. */
  start: number;
}

/** One segment as its target will roughly show it. */
export interface PreviewSegmentModel {
  id: string;
  /** Attached images, in order. */
  media: Array<{ id: string; ref: string; alt: string }>;
  /** Cards for links the brief carries: title and host, nothing invented. */
  linkCards: Array<{ title: string; host: string }>;
  visible: PreviewTokenModel[];
  /** Behind the fold; empty when nothing is hidden. */
  hidden: PreviewTokenModel[];
  /** Key under the kind's `slots.*` messages ("see more"). */
  foldLabelKey?: string;
  numbering?: string;
  count: number;
  limit: number;
  over: number;
}

/** One press of Copy: a whole version, or one post of a thread. */
export interface CopyStep {
  segmentId: string;
  text: string;
}

/**
 * The client half of a spec adapter. Plain functions, so the shared
 * components stay free of any import from a kind's own folder.
 */
export interface SpecAdapterUi<S extends VersionSpec = VersionSpec> {
  /** Messages namespace for this kind's own strings (slot labels). */
  namespace: string;
  segmentMeta(spec: S, segments: Segment[], index: number): SegmentMeta | null;
  firstSegmentSlot(spec: S, segments: Segment[]): SlotMeta | null;
  copyPlan(spec: S, version: Version): CopyStep[];
  /**
   * How a version will roughly look on its target. Absent = this kind has
   * no preview, and no Edit | Preview toggle is shown.
   */
  preview?(
    spec: S,
    segments: Segment[],
    links: BriefLink[],
  ): PreviewSegmentModel[];
  /**
   * Makes a version fit by MOVING text between segments, rewording nothing:
   * into the next segment where it has room, otherwise into a new one,
   * repeated until everything fits or nothing more can be done. Never cuts
   * through a quotation or a link. Returns the SAME array when it can do
   * nothing (a single-segment spec, the maximum reached, one unbreakable
   * span), which is how the button knows not to show.
   */
  fit?(
    spec: S,
    segments: Segment[],
    brief: Brief,
    mintId: () => string,
  ): Segment[];
  /**
   * Drops hashtags from the end of one segment until it fits. Returns the
   * same array when there is none to drop.
   */
  dropHashtags?(
    spec: S,
    segments: Segment[],
    segmentId: string,
    brief: Brief,
  ): Segment[];
}
