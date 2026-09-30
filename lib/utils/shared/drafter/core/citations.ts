/**
 * Citations: which brief entries each sentence of a version rests on.
 *
 * Attribution is the MODEL's answer (the cite step, run after generation
 * and after edits), stored on the version as `StatementVerdict`s. This
 * module turns those stored answers into what the UI renders, one mark per
 * sentence, and decides when an answer no longer applies: the sentence was
 * reworded (its key changed), the brief entries it cites changed, or a
 * quote or number inside it is ungrounded, in which case code's verdict
 * wins whatever the model said. Nothing here blocks anything: publishing
 * is gated by the deterministic checks alone.
 */
import {
  Brief,
  CitationMark,
  GroundingMark,
  Segment,
  StatementVerdict,
  Version,
} from '@/types/drafter';

import { BRIEF_ITSELF, groundSegment } from './grounding';
import { statementKey, statementSpans } from './statements';
import { verdictDigestFor } from './versions';

/** One sentence (or clause) of a segment, as the cite step sees it. */
export interface Sentence {
  segmentId: string;
  /** Raw, trimmed offsets into the segment text. */
  start: number;
  end: number;
  text: string;
  /** statementKey(text): what a verdict on it is stored under. */
  key: string;
}

export interface CiteClaim {
  segmentId: string;
  text: string;
}

/* ------------------------------------------------------------------ */
/* Sentences                                                           */
/* ------------------------------------------------------------------ */

const SENTENCES_MEMO = new WeakMap<Segment, WeakMap<Brief, Sentence[]>>();

/**
 * The sentences of a segment. A quotation is never cut in two, so the
 * quote marks (which depend on the brief) decide the masks; memoised per
 * (segment, brief) like `groundSegment`, so a keystroke re-cuts one segment.
 */
export function sentencesOf(segment: Segment, brief: Brief): Sentence[] {
  let byBrief = SENTENCES_MEMO.get(segment);
  const cached = byBrief?.get(brief);
  if (cached) return cached;
  const masked = groundSegment(segment, brief)
    .filter((mark) => mark.kind === 'quote')
    .map((mark) => ({ start: mark.start, end: mark.end }));
  const sentences = statementSpans(segment.text, masked).map((range) => {
    const text = segment.text.slice(range.start, range.end);
    return {
      segmentId: segment.id,
      start: range.start,
      end: range.end,
      text,
      key: statementKey(text),
    };
  });
  if (!byBrief) {
    byBrief = new WeakMap();
    SENTENCES_MEMO.set(segment, byBrief);
  }
  byBrief.set(brief, sentences);
  return sentences;
}

/* ------------------------------------------------------------------ */
/* Staleness                                                           */
/* ------------------------------------------------------------------ */

/**
 * A verdict lapses when an entry it cites is no longer included or when
 * the brief it was judged against changed (its digest: the cited entries
 * for a supported/partly verdict, every included item for one citing
 * nothing, since a new item could support it). A verdict stored before
 * digests existed is stale: it cannot say what it was judged against.
 */
export function isVerdictStale(
  verdict: StatementVerdict,
  brief: Brief,
): boolean {
  if (!verdict.briefDigest) return true;
  const included = new Set(
    brief.items
      .filter((item) => item.decision === 'included')
      .map((item) => item.id),
  );
  for (const id of verdict.itemIds) {
    if (id !== BRIEF_ITSELF && !included.has(id)) return true;
  }
  return (
    verdict.briefDigest !==
    verdictDigestFor(brief, verdict.itemIds, verdict.verdict)
  );
}

/* ------------------------------------------------------------------ */
/* Marks                                                               */
/* ------------------------------------------------------------------ */

interface MarksMemoEntry {
  verdicts: StatementVerdict[] | undefined;
  marks: CitationMark[];
}

const MARKS_MEMO = new WeakMap<Segment, WeakMap<Brief, MarksMemoEntry>>();
const BY_KEY_MEMO = new WeakMap<
  StatementVerdict[],
  Map<string, StatementVerdict>
>();

function verdictKey(segmentId: string, key: string): string {
  return `${segmentId}\n${key}`;
}

/**
 * The newest verdict per (segment, sentence key), built once per array,
 * plus one per sentence key alone: a sentence that moved to another
 * segment (a split, a merge, "Move overflow") keeps its verdict, since the
 * key is the sentence and the brief entries it cites do not move with the
 * post boundary.
 */
function verdictsByKey(
  verdicts: StatementVerdict[] | undefined,
): Map<string, StatementVerdict> {
  if (!verdicts) return new Map();
  const cached = BY_KEY_MEMO.get(verdicts);
  if (cached) return cached;
  const byKey = new Map<string, StatementVerdict>();
  const put = (key: string, verdict: StatementVerdict): void => {
    const existing = byKey.get(key);
    if (!existing || existing.at.localeCompare(verdict.at) <= 0) {
      byKey.set(key, verdict);
    }
  };
  for (const verdict of verdicts) {
    put(verdictKey(verdict.segmentId, verdict.sentenceKey), verdict);
    put(verdictKey('', verdict.sentenceKey), verdict);
  }
  BY_KEY_MEMO.set(verdicts, byKey);
  return byKey;
}

function ungroundedInside(
  marks: GroundingMark[],
  start: number,
  end: number,
): boolean {
  return marks.some(
    (mark) =>
      mark.itemId === undefined && mark.start >= start && mark.end <= end,
  );
}

function segmentCitationMarks(
  segment: Segment,
  verdicts: StatementVerdict[] | undefined,
  brief: Brief,
): CitationMark[] {
  const byKey = verdictsByKey(verdicts);
  const inner = groundSegment(segment, brief);
  return sentencesOf(segment, brief).map((sentence) => {
    const base = {
      segmentId: segment.id,
      start: sentence.start,
      end: sentence.end,
      key: sentence.key,
    };
    // Code's finding about a quote or number inside the sentence stands
    // over any opinion of the model's.
    if (ungroundedInside(inner, sentence.start, sentence.end)) {
      return {
        ...base,
        itemIds: [],
        verdict: 'unsupported',
        note: 'ungrounded-inside',
      };
    }
    const verdict =
      byKey.get(verdictKey(segment.id, sentence.key)) ??
      byKey.get(verdictKey('', sentence.key));
    if (!verdict) return { ...base, itemIds: [], verdict: 'pending' };
    if (isVerdictStale(verdict, brief)) {
      return { ...base, itemIds: [], verdict: 'stale' };
    }
    const supported =
      verdict.verdict === 'supported' || verdict.verdict === 'partly';
    return {
      ...base,
      itemIds: supported ? verdict.itemIds : [],
      verdict: verdict.verdict,
      ...(verdict.note ? { note: verdict.note } : {}),
      ...(verdict.reason ? { reason: verdict.reason } : {}),
      ...(verdict.modelId ? { modelId: verdict.modelId } : {}),
      at: verdict.at,
    };
  });
}

/**
 * One mark per sentence of the given segments, from the stored verdicts.
 * Memoised per (segment, brief, verdicts array) object identity: typing in
 * one segment recomputes that segment alone, and landing verdicts
 * recomputes marks without re-cutting sentences or re-grounding quotes.
 * The returned arrays are shared; callers must not mutate them.
 */
export function citationMarks(
  segments: Segment[],
  version: Pick<Version, 'verdicts'> | undefined,
  brief: Brief,
): CitationMark[] {
  const verdicts = version?.verdicts;
  return segments.flatMap((segment) => {
    let byBrief = MARKS_MEMO.get(segment);
    const cached = byBrief?.get(brief);
    if (cached && cached.verdicts === verdicts) return cached.marks;
    const marks = segmentCitationMarks(segment, verdicts, brief);
    if (!byBrief) {
      byBrief = new WeakMap();
      MARKS_MEMO.set(segment, byBrief);
    }
    byBrief.set(brief, { verdicts, marks });
    return marks;
  });
}

/* ------------------------------------------------------------------ */
/* What the cite step needs                                            */
/* ------------------------------------------------------------------ */

/**
 * The sentences a cite call should send: those with no verdict, or a stale
 * one. A sentence code has already found wanting (an ungrounded quote or
 * number inside) is not sent: its verdict is decided, and rewording it
 * gives it a new key, and a new turn.
 */
export function pendingClaims(
  segments: Segment[],
  version: Pick<Version, 'verdicts'> | undefined,
  brief: Brief,
): CiteClaim[] {
  const claims: CiteClaim[] = [];
  const seen = new Set<string>();
  for (const mark of citationMarks(segments, version, brief)) {
    if (mark.verdict !== 'pending' && mark.verdict !== 'stale') continue;
    const key = verdictKey(mark.segmentId, mark.key);
    if (seen.has(key)) continue;
    seen.add(key);
    const segment = segments.find((entry) => entry.id === mark.segmentId);
    if (!segment) continue;
    claims.push({
      segmentId: mark.segmentId,
      text: segment.text.slice(mark.start, mark.end),
    });
  }
  return claims;
}

/** The items the model attributed sentences to (supported or partly), never the brief itself. */
export function citedItemIds(marks: CitationMark[]): string[] {
  const ids = new Set<string>();
  for (const mark of marks) {
    if (mark.verdict !== 'supported' && mark.verdict !== 'partly') continue;
    for (const id of mark.itemIds) if (id !== BRIEF_ITSELF) ids.add(id);
  }
  return [...ids];
}

/**
 * Which specs' versions draw on a brief item ("Used in LinkedIn, X"): by a
 * quotation or number of it, by the ids reported at generation, or by a
 * sentence the model attributed to it.
 */
export function specsUsingItem(
  itemId: string,
  versions: Record<string, Pick<Version, 'segments' | 'verdicts'>>,
  brief: Brief,
): string[] {
  return Object.entries(versions)
    .filter(
      ([, version]) =>
        version.segments.some(
          (segment) =>
            segment.usedItemIds.includes(itemId) ||
            groundSegment(segment, brief).some(
              (mark) => mark.itemId === itemId,
            ),
        ) ||
        citedItemIds(citationMarks(version.segments, version, brief)).includes(
          itemId,
        ),
    )
    .map(([specId]) => specId);
}
