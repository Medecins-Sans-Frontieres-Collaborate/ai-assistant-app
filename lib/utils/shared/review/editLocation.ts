/**
 * Locating pending edits in the working text — for PREVIEW ONLY.
 *
 * Application still resolves `before` at apply time (see editApplication.ts);
 * these offsets exist purely so the UI can point at the span a card refers
 * to. They are safe because both workspaces freeze the text while edits are
 * unresolved, so nothing shifts underneath a highlight.
 */

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
