/**
 * Turns a whole-document rewrite into individually reviewable edits.
 *
 * The revise pipeline asks the model for the COMPLETE revised document, while
 * the review queue needs `{before, after}` patches whose `before` is an exact,
 * uniquely-locatable substring of the original (see `applyEdit`, which is a
 * bare `indexOf` with no normalization). This module bridges the two by
 * diffing locally rather than asking the model to self-report its changes —
 * the same "honest by construction" approach the translation orchestrator
 * takes with `computeSegmentChanges`.
 *
 * The difference from `computeSegmentChanges` is that its output is display
 * chips: trimmed and ellipsized, so it reads well but would never survive
 * `indexOf`. Everything here preserves bytes exactly.
 */

/** A reviewable change. `before` is verbatim and unique within the source. */
export interface RevisionChange {
  before: string;
  after: string;
}

/** Why a revision was written straight into the document. */
export type DirectApplyReason =
  | 'disabled' // the user unticked "Suggest changes"
  | 'generate' // blank document — there is nothing to suggest against
  | 'automatic' // not a user-requested revision
  | 'selection' // the selection already scoped the review
  | 'largeRewrite' // too much changed to review as discrete suggestions
  | 'reorder' // sections moved; half a move is not reviewable
  | 'unanchorable' // changes could not be pinned to unique spans
  | 'noChanges'; // the rewrite came back identical

export type RevisionPlan =
  | { kind: 'suggest'; changes: RevisionChange[] }
  | { kind: 'direct'; reason: DirectApplyReason };

export interface RevisionPlanInput {
  /** The "Suggest changes" checkbox for this run. */
  enabled: boolean;
  mode: 'generate' | 'revise';
  /** True when the run was triggered by the system, not the user. */
  automatic?: boolean;
  /** True when the user had text selected and scoped the revision to it. */
  scoped: boolean;
  oldMarkdown: string;
  newMarkdown: string;
  exceptions: {
    selectionScoped: boolean;
    largeRewrites: boolean;
    structuralReorders: boolean;
  };
  largeRewriteRatio: number;
}

/**
 * Decides whether a completed revision becomes a review queue or is written
 * straight in. Pure, so the policy is testable without a running editor.
 *
 * Every `direct` outcome is a case where a suggestion queue would be worse
 * than no queue — not a failure. The caller reports the reason rather than
 * silently differing from what the checkbox implied.
 */
export function planRevision(input: RevisionPlanInput): RevisionPlan {
  const direct = (reason: DirectApplyReason): RevisionPlan => ({
    kind: 'direct',
    reason,
  });

  if (!input.enabled) return direct('disabled');
  if (input.automatic) return direct('automatic');
  if (input.mode === 'generate') return direct('generate');
  if (input.scoped && input.exceptions.selectionScoped) {
    return direct('selection');
  }

  const diff = computeRevisionEdits(input.oldMarkdown, input.newMarkdown);
  if (!diff.fullyAnchored) return direct('unanchorable');
  if (diff.changes.length === 0) return direct('noChanges');
  if (
    input.exceptions.largeRewrites &&
    diff.changeRatio >= input.largeRewriteRatio
  ) {
    return direct('largeRewrite');
  }
  if (input.exceptions.structuralReorders && diff.hasReorder) {
    return direct('reorder');
  }

  return { kind: 'suggest', changes: diff.changes };
}

export interface RevisionDiffResult {
  changes: RevisionChange[];
  /**
   * How much of the document moved, 0–1, counting both sides. Near 0 is a
   * touch-up; near 1 is a rewrite whose "suggestions" would be one giant
   * before/after block that nobody can review meaningfully.
   */
  changeRatio: number;
  /**
   * A block was moved rather than edited — deleted in one place and
   * reinserted verbatim in another. Split across two suggestions each half
   * reads as nonsense, so callers generally bypass suggestion mode.
   */
  hasReorder: boolean;
  /**
   * Every change was anchored to a unique verbatim span. False means at least
   * one could not be, and the caller should apply the rewrite directly rather
   * than present a queue that would partly fail on accept.
   */
  fullyAnchored: boolean;
}

/**
 * Above this many sentences per side the O(n·m) LCS table is too big to build.
 * Hitting it reports `fullyAnchored: false` so the caller falls back rather
 * than silently returning a worse diff.
 */
const SENTENCE_LIMIT = 400;

/** How many sentences of context a span may absorb while chasing uniqueness. */
const MAX_CONTEXT_SENTENCES = 8;

/**
 * Sentence split that CONCATENATES BACK to the input exactly — every
 * character, including trailing whitespace and newlines, belongs to exactly
 * one segment. The verbatim guarantee downstream depends on this.
 */
function splitSentences(text: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter(undefined, {
      granularity: 'sentence',
    });
    return [...segmenter.segment(text)].map((s) => s.segment);
  }
  return text.match(/[^.!?\n]+[.!?\n]*\s*/g) ?? (text ? [text] : []);
}

/**
 * Comparison key for two sentences that "say the same thing".
 *
 * The two sides of this diff are produced by different writers and never
 * agree byte-for-byte on formatting. The old text comes from turndown, which
 * escapes markdown metacharacters (`annex\_2`) and pads list markers
 * (`-   Gloves`); the model writes plain, unescaped markdown (`annex_2`,
 * `- Gloves`). Comparing raw, almost NO sentence matches, the diff reports
 * the whole document as changed, and every revision trips the large-rewrite
 * bypass instead of ever being suggested.
 *
 * Only matching is normalized — the spans handed to the review queue are
 * still sliced from the original text, because `applyEdit` needs `before` to
 * be a verbatim substring.
 */
function matchKey(sentence: string): string {
  return sentence
    .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1') // drop turndown's escapes
    .replace(/^(\s*[-*+])\s+/, '$1 ') // normalize list-marker padding
    .replace(/\s+/g, ' ')
    .trim();
}

/** Contiguous run of deleted sentences [delStart, delEnd) replaced by `ins`. */
interface DiffRun {
  delStart: number;
  delEnd: number;
  ins: string;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
    // Two is all the caller needs to know; stop early on long documents.
    if (count > 1) return count;
  }
}

/**
 * Grows a run's span with neighbouring UNCHANGED sentences until its `before`
 * occurs exactly once in the source. A single repeated sentence ("See the
 * table above.") is otherwise ambiguous, and `applyEdit` takes the first
 * match — which could rewrite a passage the user never looked at.
 *
 * A pure insertion starts with one sentence of context by necessity: its
 * `before` would otherwise be empty, which `applyEdit` refuses outright.
 */
function anchorRun(
  run: DiffRun,
  sentences: string[],
  source: string,
): RevisionChange | null {
  const isInsertion = run.delStart === run.delEnd;
  let left = 0;
  let right = 0;
  if (isInsertion) {
    if (run.delStart > 0) left = 1;
    else if (run.delEnd < sentences.length) right = 1;
    else return null; // Inserting into an empty document; nothing to anchor to.
  }

  for (;;) {
    const from = run.delStart - left;
    const to = run.delEnd + right;
    const before = sentences.slice(from, to).join('');
    const after =
      sentences.slice(from, run.delStart).join('') +
      run.ins +
      sentences.slice(run.delEnd, to).join('');

    if (before && countOccurrences(source, before) === 1) {
      return { before, after };
    }

    // Widen: prefer left context (reads as "…and then this changed"), then
    // right, and give up once the span is more context than change.
    const canLeft = from > 0 && left < MAX_CONTEXT_SENTENCES;
    const canRight = to < sentences.length && right < MAX_CONTEXT_SENTENCES;
    if (!canLeft && !canRight) return null;
    if (canLeft) left += 1;
    else right += 1;
  }
}

/**
 * Shortest sentence that counts as evidence of a move. Below this, matching
 * text is more likely a stock phrase ("See above.") than a relocated block.
 */
const REORDER_MIN_SENTENCE_CHARS = 40;

/**
 * Detects a moved block: a sentence that is deleted in one place and inserted
 * in another. Compared sentence-by-sentence rather than run-by-run, because a
 * swap usually lands in a SINGLE run — the LCS anchors on whatever came before
 * it, then reports the whole reshuffled remainder as one delete plus one
 * insert, and neither half contains the other.
 *
 * Whitespace is collapsed before comparing, so reflowing doesn't hide a move.
 * The cost of that tolerance is that a pure whitespace change to a long
 * sentence can read as a move; the consequence is only that the revision is
 * applied directly instead of suggested, and the behaviour is user-configurable.
 */
function detectReorder(runs: DiffRun[], sentences: string[]): boolean {
  const norm = matchKey;
  const substantial = (s: string) => s.length >= REORDER_MIN_SENTENCE_CHARS;

  const deleted = new Set<string>();
  for (const run of runs) {
    for (const sentence of sentences.slice(run.delStart, run.delEnd)) {
      const text = norm(sentence);
      if (substantial(text)) deleted.add(text);
    }
  }
  if (deleted.size === 0) return false;

  for (const run of runs) {
    for (const sentence of splitSentences(run.ins)) {
      const text = norm(sentence);
      if (substantial(text) && deleted.has(text)) return true;
    }
  }
  return false;
}

/**
 * Diffs a rewrite into reviewable changes.
 *
 * Returns `fullyAnchored: false` when the result should not be offered as a
 * review queue — the document is too large to diff, or some change could not
 * be pinned to a unique span. Callers treat that as "apply directly".
 */
export function computeRevisionEdits(
  oldText: string,
  newText: string,
): RevisionDiffResult {
  const empty: RevisionDiffResult = {
    changes: [],
    changeRatio: 0,
    hasReorder: false,
    fullyAnchored: true,
  };
  if (oldText === newText) return empty;
  if (!oldText || !newText) {
    return { ...empty, changeRatio: 1, fullyAnchored: false };
  }

  const a = splitSentences(oldText);
  const b = splitSentences(newText);
  if (a.length > SENTENCE_LIMIT || b.length > SENTENCE_LIMIT) {
    return { ...empty, changeRatio: 1, fullyAnchored: false };
  }

  // Sentence-level LCS over normalized keys — see `matchKey`. Sentences that
  // differ only in escaping or whitespace count as unchanged, so a formatting
  // mismatch between turndown and the model is not reported as a rewrite.
  const keyA = a.map(matchKey);
  const keyB = b.map(matchKey);
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] =
        keyA[i] === keyB[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const runs: DiffRun[] = [];
  let i = 0;
  let j = 0;
  let delStart = 0;
  let ins = '';
  let deletedChars = 0;
  let insertedChars = 0;
  const flush = (delEnd: number) => {
    if (delStart === delEnd && !ins) return;
    runs.push({ delStart, delEnd, ins });
    ins = '';
  };

  while (i < a.length && j < b.length) {
    if (keyA[i] === keyB[j]) {
      flush(i);
      i++;
      j++;
      delStart = i;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      deletedChars += a[i].length;
      i++;
    } else {
      insertedChars += b[j].length;
      ins += b[j++];
    }
  }
  while (i < a.length) {
    deletedChars += a[i].length;
    i++;
  }
  while (j < b.length) {
    insertedChars += b[j].length;
    ins += b[j++];
  }
  flush(i);

  const changeRatio = Math.min(
    1,
    (deletedChars + insertedChars) / (oldText.length + newText.length),
  );
  const hasReorder = detectReorder(runs, a);

  const changes: RevisionChange[] = [];
  let fullyAnchored = true;
  for (const run of runs) {
    const anchored = anchorRun(run, a, oldText);
    if (!anchored) {
      fullyAnchored = false;
      continue;
    }
    changes.push(anchored);
  }

  // Overlapping spans would corrupt each other on sequential application:
  // accepting the first rewrites text the second still expects to find.
  // Context expansion can create these, so drop the later of any pair.
  const kept: RevisionChange[] = [];
  const claimed: Array<[number, number]> = [];
  for (const change of changes) {
    const at = oldText.indexOf(change.before);
    const span: [number, number] = [at, at + change.before.length];
    if (claimed.some(([s, e]) => span[0] < e && s < span[1])) {
      fullyAnchored = false;
      continue;
    }
    claimed.push(span);
    kept.push(change);
  }

  return { changes: kept, changeRatio, hasReorder, fullyAnchored };
}
