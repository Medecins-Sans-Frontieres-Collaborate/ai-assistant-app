/**
 * Change requests: the user describes a change to a translation in words
 * and gets back individual edits to accept or reject.
 *
 * Shared by the route (validation, sanitation) and the workspace (state,
 * anchoring), so both sides agree on the limits and on what a usable edit is.
 */
import { ANCHOR_CONTEXT_CHARS } from '@/lib/utils/shared/review/editApplication';

/** Longest instruction accepted, in characters. */
export const MAX_CHANGE_INSTRUCTION_CHARS = 2_000;

/** Most edits one request may return. */
export const MAX_CHANGE_EDITS = 20;

/**
 * Criterion id carried by every requested edit. Edits share the review
 * queue with quality-assessment edits, whose `criterion` names a rubric;
 * a requested edit answers the user's instruction instead.
 */
export const CHANGE_REQUEST_CRITERION = 'request';

/** A passage of the translation that a request is limited to. */
export interface ChangeSelection {
  /** The selected text, exactly as it appears in the translation. */
  text: string;
  /** Offset of `text` in the translation. */
  start: number;
}

/** One change proposed in answer to a request. */
export interface ChangeEdit {
  /** Exact substring of the translation. */
  before: string;
  after: string;
  reason: string;
}

/**
 * Whether a selection really is a passage of the translation.
 *
 * @param translation - The translation the request is about.
 * @param selection - The passage the client says is selected.
 * @returns True when the text sits at the given offset and is not blank.
 */
export function isValidSelection(
  translation: string,
  selection: ChangeSelection,
): boolean {
  return (
    typeof selection.text === 'string' &&
    Number.isInteger(selection.start) &&
    selection.start >= 0 &&
    selection.text.trim() !== '' &&
    translation.startsWith(selection.text, selection.start)
  );
}

/**
 * Turns what the user highlighted on screen into a passage of the
 * translation.
 *
 * The offset measured in the page is only a hint: the pane may be showing
 * marked-up text, so the passage is looked for at the hint first and
 * otherwise at its occurrence nearest the hint. Surrounding whitespace is
 * dropped, since a drag usually catches some.
 *
 * @param translation - The translation shown in the pane.
 * @param selectedText - The highlighted text as the browser reports it.
 * @param approximateStart - Where the highlight starts, as measured.
 * @returns The passage, or null when the highlight is blank or is not text
 *   of the translation (for example, it spans inserted preview text).
 */
export function locateSelection(
  translation: string,
  selectedText: string,
  approximateStart: number,
): ChangeSelection | null {
  const text = selectedText.trim();
  if (!text) return null;
  const hint =
    approximateStart + (selectedText.length - selectedText.trimStart().length);
  if (translation.startsWith(text, hint)) return { text, start: hint };
  let nearest = -1;
  for (
    let index = translation.indexOf(text);
    index !== -1;
    index = translation.indexOf(text, index + 1)
  ) {
    if (nearest === -1 || Math.abs(index - hint) < Math.abs(nearest - hint)) {
      nearest = index;
    }
  }
  return nearest === -1 ? null : { text, start: nearest };
}

/**
 * Keeps the edits that can actually be shown and applied.
 *
 * Dropped: malformed entries, edits that change nothing, edits whose
 * `before` is not in the translation, and, when the request is limited to a
 * selection, edits that reach outside it.
 *
 * @param edits - Edits as returned by the model (untrusted shape).
 * @param translation - The translation the request was made against.
 * @param selection - The passage the request is limited to, if any.
 * @returns At most {@link MAX_CHANGE_EDITS} usable edits, in model order.
 */
export function sanitizeChangeEdits(
  edits: unknown,
  translation: string,
  selection?: ChangeSelection,
): ChangeEdit[] {
  if (!Array.isArray(edits)) return [];
  const scope = selection ? selection.text : translation;
  const usable: ChangeEdit[] = [];
  for (const candidate of edits as Array<Partial<ChangeEdit> | null>) {
    if (!candidate) continue;
    const { before, after, reason } = candidate;
    if (typeof before !== 'string' || typeof after !== 'string') continue;
    if (before.trim() === '' || before === after) continue;
    if (!scope.includes(before)) continue;
    usable.push({
      before,
      after,
      reason: typeof reason === 'string' ? reason : '',
    });
    if (usable.length === MAX_CHANGE_EDITS) break;
  }
  return usable;
}

/**
 * Anchors edits made on a selection to that selection's place in the
 * translation, so a phrase that also occurs elsewhere is changed where the
 * user selected it and nowhere else.
 *
 * @param translation - The translation the request was made against.
 * @param selection - The passage the edits belong to.
 * @param edits - Edits whose `before` lies inside the selection.
 * @returns The edits with `anchorStart` and `anchorContext` set; an edit
 *   whose `before` is not in the selection is returned unchanged.
 */
export function stampSelectionAnchors<T extends { before: string }>(
  translation: string,
  selection: ChangeSelection,
  edits: readonly T[],
): Array<T & { anchorStart?: number; anchorContext?: string }> {
  // Each edit takes the first occurrence after the previous edit's, so two
  // edits with the same `before` get two different places.
  let searchFrom = 0;
  return edits.map((edit) => {
    let offset = selection.text.indexOf(edit.before, searchFrom);
    if (offset === -1) offset = selection.text.indexOf(edit.before);
    if (offset === -1) return edit;
    searchFrom = offset + edit.before.length;
    const anchorStart = selection.start + offset;
    return {
      ...edit,
      anchorStart,
      anchorContext: translation.slice(
        Math.max(0, anchorStart - ANCHOR_CONTEXT_CHARS),
        anchorStart,
      ),
    };
  });
}
