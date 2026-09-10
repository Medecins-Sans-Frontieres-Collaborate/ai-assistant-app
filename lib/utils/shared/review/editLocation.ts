/**
 * Locating pending edits in the working text.
 *
 * Two consumers, and the distinction matters:
 *
 *  - PREVIEW — the highlighters recompute these offsets against the CURRENT
 *    text on every change, so a highlight always points at where the text
 *    stands now. (The document's ProseMirror plugin rebuilds on
 *    `tr.docChanged`; the translation pane recomputes on render.)
 *  - ANCHORING — {@link stampEditAnchors} records ONCE, when the assessment is
 *    minted, where each edit's target sat and what preceded it. Application
 *    then scores occurrences on that context (and only then on distance)
 *    instead of taking the first, which is what keeps a suggestion pointing
 *    at the passage the reviewer actually read once the text is no longer
 *    frozen (docs/REVIEW_EDIT_UNFREEZE_DESIGN.md §2-3).
 *
 * Both use the same greedy assignment below, so an edit's stored anchor and
 * its highlight always mean the same occurrence.
 */
import { ANCHOR_CONTEXT_CHARS } from './editApplication';

export interface LocatableEdit {
  id: string;
  before: string;
}

export interface EditLocation {
  id: string;
  /** Inclusive start offset into the searched text. */
  start: number;
  /** Exclusive end offset. */
  end: number;
}

/**
 * Assigns each edit a distinct, non-overlapping span in `text`.
 *
 * Greedy leftmost-first, mirroring `applyEditsInOrder`: repeatedly take the
 * edit whose earliest unclaimed occurrence comes first. Two cards proposing
 * the same `before` therefore highlight the first two occurrences rather
 * than fighting over one, and an edit whose only occurrence is already
 * claimed is simply left unlocated (returned spans are the located subset).
 */
export function locateEdits(
  text: string,
  edits: readonly LocatableEdit[],
): EditLocation[] {
  const remaining = edits.filter((edit) => edit.before);
  const located: EditLocation[] = [];
  const claimed: EditLocation[] = [];

  /** First occurrence of `before` that overlaps nothing already claimed. */
  const findFree = (before: string): number => {
    let index = text.indexOf(before);
    while (index !== -1) {
      const end = index + before.length;
      const clash = claimed.find((c) => index < c.end && end > c.start);
      if (!clash) return index;
      // Overlap implies index < clash.end, so this always advances.
      index = text.indexOf(before, clash.end);
    }
    return -1;
  };

  while (remaining.length > 0) {
    let bestIndex = -1;
    let bestPosition = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const position = findFree(remaining[i].before);
      if (position !== -1 && position < bestPosition) {
        bestPosition = position;
        bestIndex = i;
      }
    }
    // Nothing left is locatable; the rest stay unhighlighted.
    if (bestIndex === -1) break;

    const [edit] = remaining.splice(bestIndex, 1);
    const location: EditLocation = {
      id: edit.id,
      start: bestPosition,
      end: bestPosition + edit.before.length,
    };
    located.push(location);
    claimed.push(location);
  }

  return located.sort((a, b) => a.start - b.start);
}

/**
 * Markdown markers the document workflow's `before` strings may carry that
 * the rendered editor no longer shows as literal text.
 */
const INLINE_MARKERS = /(\*\*|__|\*|_|`|~~)/g;
const BLOCK_PREFIX =
  /^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+\.[ \t]+)/gm;

/** Best-effort markdown → visible-text for locating spans in a rendered view. */
export function stripMarkdownMarkers(text: string): string {
  return text.replace(BLOCK_PREFIX, '').replace(INLINE_MARKERS, '');
}

/**
 * Puts an edit into terms the rendered text can be searched with.
 *
 * The document workflow's edits are written against markdown while the
 * editor shows rendered HTML, so `**Total**` never matches the visible
 * `Total`. Raw wins when present (it is exact); otherwise both sides fall
 * back to the stripped form — stripping only `before` would diff visible
 * text against markdown and show phantom `**` insertions.
 *
 * Returns null when neither form is findable. The caller then shows no
 * highlight, which is the honest outcome: we could not say where it lands.
 */
export function resolvePreviewText(
  text: string,
  before: string,
  after: string,
): { before: string; after: string } | null {
  if (!before) return null;
  if (text.includes(before)) return { before, after };

  const strippedBefore = stripMarkdownMarkers(before);
  if (
    strippedBefore &&
    strippedBefore !== before &&
    text.includes(strippedBefore)
  ) {
    return { before: strippedBefore, after: stripMarkdownMarkers(after) };
  }
  return null;
}

/**
 * Records where each edit's target sits in the text it was assessed against,
 * and what immediately precedes it.
 *
 * Called once, where an assessment's edits are minted. Edits whose `before`
 * cannot be found are returned unchanged and simply carry no anchor: they
 * fall back to first-occurrence matching, which is no worse than the
 * behaviour they would have had anyway.
 *
 * The `id` must already be assigned — anchoring is per-edit, and two edits
 * proposing the same `before` must get the two different occurrences that
 * {@link locateEdits} assigns them, not the same one twice.
 */
export function stampEditAnchors<T extends LocatableEdit>(
  text: string,
  edits: readonly T[],
): Array<T & { anchorStart?: number; anchorContext?: string }> {
  if (!text) return [...edits];
  const starts = new Map(
    locateEdits(text, edits).map((location) => [location.id, location.start]),
  );
  return edits.map((edit) => {
    const anchorStart = starts.get(edit.id);
    if (anchorStart === undefined) return edit;
    return {
      ...edit,
      anchorStart,
      anchorContext: text.slice(
        Math.max(0, anchorStart - ANCHOR_CONTEXT_CHARS),
        anchorStart,
      ),
    };
  });
}

/** A located suggestion in whatever coordinate space the caller uses. */
export interface SpanRange {
  id: string;
  from: number;
  to: number;
}

/**
 * Does a change to `[from, to)` alter the text INSIDE a suggestion's span?
 * (docs/REVIEW_EDIT_UNFREEZE_DESIGN.md §4, boundary rule)
 *
 * Strict interior only. Typing immediately before or after a suggestion, or
 * deleting the character that abuts it, leaves the suggested text itself
 * intact — and leaves `before` findable — so it must not count. A pure
 * insertion (`from === to`) therefore has to land strictly between the
 * span's ends; a replacement has to overlap its interior.
 */
export function rangeTouchesSpan(
  span: Pick<SpanRange, 'from' | 'to'>,
  from: number,
  to: number,
): boolean {
  if (from === to) return span.from < from && from < span.to;
  return from < span.to && to > span.from;
}

/**
 * Ids of the spans any of `ranges` alters, in span order, each at most once —
 * a selection dragged across two suggestions and deleted names both.
 */
export function touchedSpanIds(
  spans: readonly SpanRange[],
  ranges: readonly { from: number; to: number }[],
): string[] {
  const touched: string[] = [];
  for (const span of spans) {
    if (ranges.some((range) => rangeTouchesSpan(span, range.from, range.to))) {
      touched.push(span.id);
    }
  }
  return touched;
}
