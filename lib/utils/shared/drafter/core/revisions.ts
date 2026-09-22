/**
 * Revisions: an instruction ("less jargon", "LinkedIn is too stiff") comes
 * back as SUGGESTIONS on exact spans of text, never as replaced text. Each is
 * accepted or rejected like any review edit, so the user sees every change
 * before it happens and an approval lapses only through their own accept.
 *
 * Two things a suggestion may never touch, enforced here and not left to the
 * model: a quotation that matches the brief (the words are someone's), and a
 * link the brief carries (code places those).
 */
import { CheckFinding } from '@/lib/utils/shared/review/deterministicChecks';
import {
  ANCHOR_CONTEXT_CHARS,
  applyEdit,
  locateEditTarget,
} from '@/lib/utils/shared/review/editApplication';

import {
  Brief,
  ProposedEdit,
  Segment,
  Version,
  VersionEdit,
} from '@/types/drafter';

import { groundSegment } from './grounding';
import { linkRanges } from './links';

export const MAX_EDITS_PER_VERSION = 20;
/** Decided suggestions kept as history; older ones are dropped. */
export const MAX_DECIDED_EDITS = 30;

/**
 * How much is wrong with a set of segments, as one number: supplied by the
 * caller (it runs the spec's checks), so the core stays ignorant of what a
 * kind checks. A suggestion that RAISES it is not admitted: that is what
 * stops "make it warmer" from pushing a fitting post over a hard limit, or
 * from adding a link the brief does not carry.
 */
export type EditGuard = (segments: Segment[]) => number;

/** The usual guard score: every blocking finding, plus how far over it is. */
export function blockingScore(findings: CheckFinding[]): number {
  return findings
    .filter((finding) => finding.severity === 'block')
    .reduce((sum, finding) => {
      const count = finding.values?.count;
      return sum + 1000 + (typeof count === 'number' ? count : 0);
    }, 0);
}

const QUOTE_MARK = /["“”„«»‘’‚‹›]/u;

function overlaps(
  a: { start: number; end: number },
  b: { start: number; end: number },
): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Spans a suggestion may not change: verified quotations and brief links. */
export function protectedRanges(
  segment: Segment,
  brief: Brief,
): Array<{ start: number; end: number }> {
  const ranges = groundSegment(segment, brief)
    .filter((mark) => mark.kind === 'quote' && mark.itemId !== undefined)
    .map((mark) => ({ start: mark.start, end: mark.end }));
  // The marks belong to the quotation: an edit that moves the closing mark
  // puts new words inside it.
  for (const range of ranges) {
    if (QUOTE_MARK.test(segment.text[range.start - 1] ?? '')) range.start -= 1;
    if (QUOTE_MARK.test(segment.text[range.end] ?? '')) range.end += 1;
  }
  ranges.push(
    ...linkRanges(segment.text, brief.links).map(({ start, end }) => ({
      start,
      end,
    })),
  );
  return ranges;
}

/** The segments as they would read with these proposals applied. */
export function applyProposals(
  segments: Segment[],
  proposals: ProposedEdit[],
): Segment[] {
  return proposals.reduce(
    (current, proposal) =>
      current.map((segment) =>
        segment.id === proposal.segmentId
          ? {
              ...segment,
              text: segment.text.replace(proposal.before, () => proposal.after),
            }
          : segment,
      ),
    segments,
  );
}

/**
 * Keeps the proposals that can be applied honestly: `before` is really in
 * the named segment, something actually changes, the segment is in scope,
 * and no protected span is touched.
 */
export function admissibleEdits(
  proposals: ProposedEdit[],
  segments: Segment[],
  brief: Brief,
  onlySegmentId?: string,
  guard?: EditGuard,
): ProposedEdit[] {
  const kept: ProposedEdit[] = [];
  // The text as it would be with everything admitted so far, so that two
  // suggestions cannot each fit alone and overflow together.
  let running = segments;
  let score = guard ? guard(running) : 0;
  for (const proposal of proposals) {
    if (kept.length >= MAX_EDITS_PER_VERSION) break;
    const segment = segments.find((s) => s.id === proposal.segmentId);
    if (!segment || (onlySegmentId && segment.id !== onlySegmentId)) continue;
    if (!proposal.before || proposal.before === proposal.after) continue;
    const start = segment.text.indexOf(proposal.before);
    if (start < 0) continue;
    const range = { start, end: start + proposal.before.length };
    if (protectedRanges(segment, brief).some((p) => overlaps(range, p))) {
      continue;
    }
    // Two suggestions over the same words cannot both be applied.
    const clash = kept.some(
      (other) =>
        other.segmentId === segment.id &&
        overlaps(range, {
          start: segment.text.indexOf(other.before),
          end: segment.text.indexOf(other.before) + other.before.length,
        }),
    );
    if (clash) continue;
    if (guard) {
      const next = applyProposals(running, [proposal]);
      const nextScore = guard(next);
      if (nextScore > score) continue;
      running = next;
      score = nextScore;
    }
    kept.push(proposal);
  }
  return kept;
}

/** Lands admissible proposals as pending suggestions, replacing older ones. */
export function landEdits(
  version: Version,
  proposals: ProposedEdit[],
  brief: Brief,
  ids: string[],
  instruction: string,
  onlySegmentId?: string,
  guard?: EditGuard,
): Version {
  const admitted = admissibleEdits(
    proposals,
    version.segments,
    brief,
    onlySegmentId,
    guard,
  );
  // Nothing new to show: an empty answer must not wipe suggestions the user
  // has not decided yet.
  if (admitted.length === 0) return version;
  const edits: VersionEdit[] = admitted.map((proposal, index) => {
    const segment = version.segments.find((s) => s.id === proposal.segmentId);
    const at = segment ? segment.text.indexOf(proposal.before) : -1;
    return {
      id: ids[index] ?? `e${index}`,
      segmentId: proposal.segmentId,
      criterion: proposal.criterion ?? 'revision',
      before: proposal.before,
      after: proposal.after,
      reason: proposal.reason.slice(0, 300),
      severity: 'minor',
      status: 'pending',
      instruction: instruction.slice(0, 500),
      anchorStart: at >= 0 ? at : undefined,
      anchorContext:
        segment && at >= 0
          ? segment.text.slice(Math.max(0, at - ANCHOR_CONTEXT_CHARS), at)
          : undefined,
    };
  });
  // Decided suggestions are history; undecided ones from an earlier
  // instruction would now sit on text the new ones also target.
  const decided = (version.edits ?? [])
    .filter((e) => e.status !== 'pending')
    .slice(-MAX_DECIDED_EDITS);
  return { ...version, edits: [...decided, ...edits] };
}

export function pendingEdits(version: Version | undefined): VersionEdit[] {
  return (version?.edits ?? []).filter((edit) => edit.status === 'pending');
}

function resolve(
  version: Version,
  editId: string,
  status: VersionEdit['status'],
  now: string,
): VersionEdit[] {
  return (version.edits ?? []).map((edit) =>
    edit.id === editId ? { ...edit, status, resolvedAt: now } : edit,
  );
}

/**
 * Applies one suggestion to its segment. When its words are no longer there
 * (the user typed over them) it becomes `unapplicable` instead of guessing.
 */
export function acceptEdit(
  version: Version,
  editId: string,
  now: string,
  /** When given, the protected spans are checked again on today's text. */
  brief?: Brief,
): Version {
  const edit = pendingEdits(version).find((entry) => entry.id === editId);
  const segment = edit
    ? version.segments.find((s) => s.id === edit.segmentId)
    : undefined;
  if (!edit || !segment) return version;
  // The text may have changed since the suggestion landed, and its words may
  // now be found inside a quotation.
  const at = brief ? locateEditTarget(segment.text, edit.before, edit) : -1;
  if (
    brief &&
    at >= 0 &&
    protectedRanges(segment, brief).some((p) =>
      overlaps({ start: at, end: at + edit.before.length }, p),
    )
  ) {
    return { ...version, edits: resolve(version, editId, 'unapplicable', now) };
  }
  const outcome = applyEdit(segment.text, edit);
  if (!outcome.applied) {
    return { ...version, edits: resolve(version, editId, 'unapplicable', now) };
  }
  return {
    ...version,
    segments: version.segments.map((s) =>
      s.id === segment.id ? { ...s, text: outcome.text } : s,
    ),
    handEdited: true,
    edits: resolve(version, editId, 'accepted', now),
  };
}

export function rejectEdit(
  version: Version,
  editId: string,
  now: string,
): Version {
  if (!pendingEdits(version).some((edit) => edit.id === editId)) return version;
  return { ...version, edits: resolve(version, editId, 'rejected', now) };
}

/** Accepts every pending suggestion, in text order within each segment. */
export function acceptAllEdits(
  version: Version,
  now: string,
  brief?: Brief,
): Version {
  let next = version;
  const order = [...pendingEdits(version)].sort(
    (a, b) => (b.anchorStart ?? 0) - (a.anchorStart ?? 0),
  );
  // Last-to-first, so applying one never shifts another's position.
  for (const edit of order) next = acceptEdit(next, edit.id, now, brief);
  return next;
}

export function discardPendingEdits(version: Version, now: string): Version {
  let next = version;
  for (const edit of pendingEdits(version)) {
    next = rejectEdit(next, edit.id, now);
  }
  return next;
}
