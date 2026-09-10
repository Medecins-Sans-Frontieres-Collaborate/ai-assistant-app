/**
 * Pure edit-application and diff helpers, shared by the translation and
 * document review flows. Edits locate their `before` substring AT APPLY
 * TIME against the current working text — locating earlier would go stale as
 * other edits land. No text normalization anywhere: matching runs on the
 * exact persisted string.
 *
 * ── Which occurrence? (docs/REVIEW_EDIT_UNFREEZE_DESIGN.md §3) ────────────
 * This only matters once the working text can change while edits are pending.
 * First-occurrence matching is safe under a frozen text and dangerous without
 * it: if the user's own typing introduces an EARLIER copy of `before`,
 * `indexOf` silently retargets the suggestion, and accepting it rewrites a
 * passage the reviewer never saw. Staleness was never the risk — that already
 * degrades cleanly to `unapplicable` — mis-application was.
 *
 * So a patch may carry two hints recorded when the assessment was made:
 * `anchorStart` (where its target sat) and `anchorContext` (the text
 * immediately before it). Candidates are scored on CONTEXT FIRST, distance
 * second.
 *
 * Context has to win, because offsets move and surroundings do not: a user who
 * inserts a paragraph above the target pushes it far from `anchorStart` while
 * possibly leaving a decoy copy of `before` near the old offset. Distance alone
 * picks the decoy; matching surroundings picks the passage the reviewer read.
 *
 * Patches without hints (everything assessed before this existed, and the data
 * workflow, which anchors by row id instead) behave exactly as they did: first
 * occurrence wins.
 */

/** A contiguous changed run in a whole-text diff (display chip). */
export interface SegmentChange {
  before: string;
  after: string;
}

export interface EditPatch {
  id: string;
  before: string;
  after: string;
  /**
   * Offset of this edit's target in the text it was assessed against. Absent
   * on pre-anchor edits and wherever the caller has no meaningful offset;
   * see the module header for what it buys.
   */
  anchorStart?: number;
  /**
   * The text immediately preceding the target when the assessment was made,
   * capped at {@link ANCHOR_CONTEXT_CHARS}. The stronger of the two hints —
   * surroundings survive edits elsewhere in the document, offsets do not.
   */
  anchorContext?: string;
}

export interface ApplyOutcome {
  text: string;
  applied: boolean;
}

/**
 * How much preceding text is kept as an edit's context fingerprint. Long
 * enough to be distinctive across repeated phrasing, short enough that twenty
 * of them add well under a kilobyte to a stored assessment.
 */
export const ANCHOR_CONTEXT_CHARS = 40;

/** Length of the longest common suffix of two strings. */
function commonSuffixLength(a: string, b: string): number {
  let count = 0;
  while (
    count < a.length &&
    count < b.length &&
    a[a.length - 1 - count] === b[b.length - 1 - count]
  ) {
    count += 1;
  }
  return count;
}

/** The hints an edit may carry about which occurrence it means. */
export type EditAnchor = Pick<EditPatch, 'anchorStart' | 'anchorContext'>;

/**
 * Offset of the occurrence of `before` this patch means, or -1 when the text
 * contains none.
 *
 * With no hints, the first occurrence — byte-identical to the old behaviour.
 * With hints, every occurrence is scored: how much of `anchorContext` it is
 * still preceded by, and only then how close it sits to `anchorStart`.
 *
 * Occurrences are walked non-overlapping, matching `countOccurrences` and the
 * preview highlighter.
 */
export function locateEditTarget(
  text: string,
  before: string,
  anchor: EditAnchor = {},
): number {
  if (!before) return -1;
  const { anchorStart, anchorContext } = anchor;
  const hasStart = anchorStart !== undefined && Number.isFinite(anchorStart);
  const hasContext = !!anchorContext;
  if (!hasStart && !hasContext) return text.indexOf(before);

  let best = -1;
  let bestContext = -1;
  let bestDistance = Infinity;
  let index = text.indexOf(before);
  while (index !== -1) {
    const context = hasContext
      ? commonSuffixLength(anchorContext, text.slice(0, index))
      : 0;
    const distance = hasStart
      ? Math.abs(index - (anchorStart as number))
      : index;
    if (
      context > bestContext ||
      (context === bestContext && distance < bestDistance)
    ) {
      best = index;
      bestContext = context;
      bestDistance = distance;
    }
    index = text.indexOf(before, index + before.length);
  }
  return best;
}

/**
 * Applies one patch at its anchored occurrence (see {@link locateEditTarget}).
 * `applied: false` when `before` is empty or absent from the text — the caller
 * turns that into the `unapplicable` status rather than a silent no-op.
 */
export function applyEdit(text: string, patch: EditPatch): ApplyOutcome {
  const index = locateEditTarget(text, patch.before, patch);
  if (index === -1) return { text, applied: false };
  return {
    text:
      text.slice(0, index) +
      patch.after +
      text.slice(index + patch.before.length),
    applied: true,
  };
}

export function countOccurrences(text: string, before: string): number {
  if (!before) return 0;
  let count = 0;
  let index = text.indexOf(before);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(before, index + before.length);
  }
  return count;
}

export interface ApplyAllResult {
  text: string;
  appliedIds: string[];
  /** Edits whose `before` was absent or destroyed by a prior application. */
  failedIds: string[];
}

/**
 * Applies patches in document order with re-location: repeatedly find the
 * leftmost locatable remaining patch in the CURRENT text, apply it, and
 * repeat — so earlier applications can't silently corrupt later offsets.
 * Deterministic regardless of the input order of patches.
 *
 * "Leftmost" is measured at each patch's ANCHORED position, so ordering and
 * application agree about which occurrence a patch means.
 */
export function applyEditsInOrder(
  text: string,
  patches: EditPatch[],
): ApplyAllResult {
  let current = text;
  const remaining = [...patches];
  const appliedIds: string[] = [];
  const failedIds: string[] = [];

  while (remaining.length > 0) {
    let bestIndex = -1;
    let bestPosition = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const patch = remaining[i];
      const position = locateEditTarget(current, patch.before, patch);
      if (position !== -1 && position < bestPosition) {
        bestPosition = position;
        bestIndex = i;
      }
    }
    if (bestIndex === -1) {
      failedIds.push(...remaining.map((p) => p.id));
      break;
    }
    const [patch] = remaining.splice(bestIndex, 1);
    const outcome = applyEdit(current, patch);
    current = outcome.text;
    appliedIds.push(patch.id);
  }

  return { text: current, appliedIds, failedIds };
}

/* ------------------------------------------------------------------ */
/* Diffs                                                               */
/* ------------------------------------------------------------------ */

export interface WordDiffPart {
  kind: 'same' | 'del' | 'ins';
  text: string;
}

/** Tokenize preserving whitespace as part of tokens (word + trailing ws). */
function tokenize(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

/**
 * LCS-based word diff for inline rendering (red strikethrough deletions,
 * green insertions). Intended for edit-sized strings, not documents.
 */
export function diffWords(before: string, after: string): WordDiffPart[] {
  const a = tokenize(before);
  const b = tokenize(after);

  // LCS table (edits are short; O(n·m) is fine here).
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const parts: WordDiffPart[] = [];
  const push = (kind: WordDiffPart['kind'], text: string) => {
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('same', a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push('del', a[i]);
      i++;
    } else {
      push('ins', b[j]);
      j++;
    }
  }
  while (i < a.length) push('del', a[i++]);
  while (j < b.length) push('ins', b[j++]);

  return parts;
}

/* ------------------------------------------------------------------ */
/* Whole-text sentence diff (round transparency chips)                 */
/* ------------------------------------------------------------------ */

const DEFAULT_MAX_CHANGES = 8;
const DEFAULT_MAX_CHARS = 240;
/** Beyond this many sentences per side, fall back to one whole-text chip. */
const SENTENCE_DIFF_LIMIT = 400;

function splitSentences(text: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter(undefined, {
      granularity: 'sentence',
    });
    return [...segmenter.segment(text)].map((s) => s.segment);
  }
  // Fallback: split after sentence-ending punctuation.
  return text.match(/[^.!?\n]+[.!?\n]*\s*/g) ?? (text ? [text] : []);
}

function ellipsize(text: string, maxChars: number): string {
  const trimmed = text.trim();
  return trimmed.length > maxChars
    ? `${trimmed.slice(0, maxChars - 1)}…`
    : trimmed;
}

/**
 * Sentence-aligned diff of two whole texts, grouped into contiguous
 * {before, after} runs — display chips, not patches. Honest by
 * construction: the orchestrator uses this to report what a review round
 * actually changed rather than trusting the model's self-report.
 */
export function computeSegmentChanges(
  oldText: string,
  newText: string,
  options?: { maxChanges?: number; maxChars?: number },
): SegmentChange[] {
  const maxChanges = options?.maxChanges ?? DEFAULT_MAX_CHANGES;
  const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;

  if (oldText === newText) return [];

  const a = splitSentences(oldText);
  const b = splitSentences(newText);
  if (a.length > SENTENCE_DIFF_LIMIT || b.length > SENTENCE_DIFF_LIMIT) {
    return [
      {
        before: ellipsize(oldText, maxChars),
        after: ellipsize(newText, maxChars),
      },
    ];
  }

  // Sentence-level LCS.
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const changes: SegmentChange[] = [];
  let i = 0;
  let j = 0;
  let delRun = '';
  let insRun = '';
  const flush = () => {
    if (delRun || insRun) {
      changes.push({
        before: ellipsize(delRun, maxChars),
        after: ellipsize(insRun, maxChars),
      });
      delRun = '';
      insRun = '';
    }
  };

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      delRun += a[i++];
    } else {
      insRun += b[j++];
    }
  }
  while (i < a.length) delRun += a[i++];
  while (j < b.length) insRun += b[j++];
  flush();

  return changes.slice(0, maxChanges);
}
