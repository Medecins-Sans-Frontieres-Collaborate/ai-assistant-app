/**
 * Pure edit-application and diff helpers, shared by the translation and
 * document review flows. Edits locate their `before` substring AT APPLY
 * TIME (first occurrence) against the current working text — locating
 * earlier would go stale as other edits land. No text normalization
 * anywhere: matching runs on the exact persisted string.
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
}

export interface ApplyOutcome {
  text: string;
  applied: boolean;
}

/** First-occurrence apply; `applied: false` when `before` is empty/absent. */
export function applyEdit(text: string, patch: EditPatch): ApplyOutcome {
  if (!patch.before) return { text, applied: false };
  const index = text.indexOf(patch.before);
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
      if (!patch.before) continue;
      const position = current.indexOf(patch.before);
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
