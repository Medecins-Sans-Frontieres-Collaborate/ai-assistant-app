/**
 * Version transitions and everything DERIVED about a version.
 *
 * Approval, staleness and "changed since copied" are never stored as flags.
 * Each is a comparison made on demand, so no code path that changes text can
 * forget to reset them: typing, accepting a suggestion, "Use new", split,
 * merge and "Move overflow" all make an approval lapse without knowing that
 * approval exists.
 */
import { normalizeForQuoteMatch } from '@/lib/utils/app/citationQuotes';

import {
  ApprovalStatus,
  Brief,
  DRAFTER_LIMITS,
  GeneratedVersion,
  Segment,
  StatementVerdict,
  Version,
  VersionSnapshot,
  VersionStatus,
} from '@/types/drafter';

import { carryMedia, mediaSignatures, sameMedia } from './media';
import { statementKey } from './statements';

/** Whether a stamp (approved, copied, sent) still describes the version. */
function stampHolds(
  stamp: { texts: string[]; media?: string[] },
  version: Version,
): boolean {
  return (
    sameTexts(stamp.texts, segmentTexts(version)) &&
    sameMedia(stamp.media, version.segments)
  );
}

/** The content a stamp remembers: the words, and the images with their alt. */
function stampOf(version: Version, now: string) {
  return {
    at: now,
    texts: segmentTexts(version),
    media: mediaSignatures(version.segments),
  };
}

export function segmentTexts(version: Pick<Version, 'segments'>): string[] {
  return version.segments.map((segment) => segment.text);
}

function sameTexts(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((text, index) => text === b[index]);
}

export function hasText(version: Version | undefined): boolean {
  return !!version && version.segments.some((segment) => segment.text.trim());
}

/* ------------------------------------------------------------------ */
/* Approval                                                            */
/* ------------------------------------------------------------------ */

/**
 * `approved` only while the text is exactly what the user ticked. `changed`
 * keeps the old approval around so the UI can show what moved since.
 */
export function approvalStatus(version: Version | undefined): ApprovalStatus {
  if (!version?.approval) return 'none';
  return stampHolds(version.approval, version) ? 'approved' : 'changed';
}

export function approveVersion(version: Version, now: string): Version {
  if (!hasText(version)) return version;
  return { ...version, approval: stampOf(version, now) };
}

export function clearApproval(version: Version): Version {
  if (!version.approval) return version;
  const { approval: _approval, ...rest } = version;
  return rest;
}

/* ------------------------------------------------------------------ */
/* Copied                                                              */
/* ------------------------------------------------------------------ */

export function markCopied(version: Version, now: string): Version {
  return { ...version, copied: stampOf(version, now) };
}

export function markSent(version: Version, now: string): Version {
  return { ...version, sent: stampOf(version, now) };
}

export function changedSinceSent(version: Version | undefined): boolean {
  return !!version?.sent && !stampHolds(version.sent, version);
}

export function changedSinceCopied(version: Version | undefined): boolean {
  return !!version?.copied && !stampHolds(version.copied, version);
}

/* ------------------------------------------------------------------ */
/* Staleness                                                           */
/* ------------------------------------------------------------------ */

function hashString(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/**
 * Digest of the brief inputs a version depends on: its used items (text,
 * attribution, whether still included), the key message and the call to
 * action. An unrelated brief edit leaves it unchanged.
 */
export function briefDigestFor(brief: Brief, usedItemIds: string[]): string {
  const used = new Set(usedItemIds);
  const items = brief.items
    .filter((item) => used.has(item.id))
    .map((item) => [
      item.id,
      item.text,
      item.attribution?.name ?? '',
      item.attribution?.role ?? '',
      item.decision ?? '',
    ]);
  // Links are inputs to every version: including one, or turning the ask
  // for donations on or off, changes what the posts should say.
  const links = brief.links.map((link) => [link.role, link.url]);
  return hashString(
    JSON.stringify([brief.keyMessage, brief.callToAction ?? '', items, links]),
  );
}

/**
 * Digest of the brief a citation verdict was judged against. A supported or
 * partly verdict depends on the entries it cites; one citing nothing
 * depends on every included item, since a new one could support it. The
 * key message and call to action are inputs to both. Links are left out:
 * they are placed by code and say nothing about what a sentence states.
 */
export function verdictDigestFor(
  brief: Brief,
  itemIds: string[],
  verdict: StatementVerdict['verdict'],
): string {
  const cited =
    verdict === 'supported' || verdict === 'partly' ? new Set(itemIds) : null;
  const items = brief.items
    .filter(
      (item) => item.decision === 'included' && (!cited || cited.has(item.id)),
    )
    .map((item) => [
      item.id,
      item.text,
      item.attribution?.name ?? '',
      item.attribution?.role ?? '',
    ]);
  return hashString(
    JSON.stringify([brief.keyMessage, brief.callToAction ?? '', items]),
  );
}

export function usedItemIdsOf(version: Pick<Version, 'segments'>): string[] {
  return [...new Set(version.segments.flatMap((s) => s.usedItemIds))];
}

export function isStale(version: Version | undefined, brief: Brief): boolean {
  if (!version || !hasText(version)) return false;
  return version.briefDigest !== briefDigestFor(brief, usedItemIdsOf(version));
}

/* ------------------------------------------------------------------ */
/* Transitions                                                         */
/* ------------------------------------------------------------------ */

function pushHistory(
  version: Version,
  reason: VersionSnapshot['reason'],
  now: string,
): VersionSnapshot[] {
  if (!hasText(version)) return version.history;
  const texts = segmentTexts(version);
  // The same words twice in a row is not history, only weight.
  const latest = version.history[0];
  if (latest && sameTexts(latest.texts, texts)) return version.history;
  const snapshot: VersionSnapshot = {
    at: now,
    reason,
    texts,
    // What the words rested on goes with them: a restore that forgot it
    // looked stale at once, and let a post resting on a vouched or excluded
    // item through the publish gate.
    usedItemIds: version.segments.map((segment) => segment.usedItemIds),
    briefDigest: version.briefDigest,
  };
  return [snapshot, ...version.history].slice(0, DRAFTER_LIMITS.MAX_HISTORY);
}

export function emptyVersion(specId: string): Version {
  return {
    specId,
    segments: [],
    briefRev: 0,
    briefDigest: '',
    handEdited: false,
    history: [],
  };
}

/**
 * Lands a generated version. Into an empty column it is simply the text.
 * Over existing text it becomes `proposed`, shown as a diff with Keep mine /
 * Use new: text the user has seen is never replaced behind their back.
 */
export function applyGenerated(
  existing: Version | undefined,
  generated: GeneratedVersion,
  /**
   * The brief AS IT WAS SENT, not as it is when the answer lands. The text
   * was written from that one; stamping today's brief on it would hide any
   * edit made while the request was in flight, and "Brief changed" would
   * never show for a post that still says what the brief no longer does.
   */
  brief: Brief,
  ids: string[],
  reason: string,
): Version {
  const base = existing ?? emptyVersion(generated.specId);
  const segments: Segment[] = generated.segments
    .filter((segment) => segment.text.trim())
    .map((segment, index) => ({
      id: ids[index] ?? `${generated.specId}-${index}`,
      text: segment.text.trim(),
      usedItemIds: segment.usedItemIds,
    }));
  if (segments.length === 0) return base;
  const briefDigest = briefDigestFor(brief, usedItemIdsOf({ segments }));
  if (hasText(base)) {
    // The same words again are not a decision worth asking for.
    if (sameTexts(segmentTexts(base), segmentTexts({ segments }))) {
      return { ...base, briefRev: brief.rev, briefDigest, proposed: undefined };
    }
    return {
      ...base,
      proposed: { segments, briefRev: brief.rev, briefDigest, reason },
    };
  }
  return {
    ...base,
    segments,
    briefRev: brief.rev,
    briefDigest,
    handEdited: false,
    proposed: undefined,
  };
}

export function useProposed(
  version: Version,
  brief: Brief,
  now: string,
): Version {
  if (!version.proposed) return version;
  const { briefRev } = version.proposed;
  // A rewrite is words only; the user's images come with them.
  const segments = carryMedia(version.segments, version.proposed.segments);
  return {
    ...version,
    history: pushHistory(version, 'updated', now),
    segments,
    briefRev,
    // The digest of the brief the proposal was WRITTEN from. A proposal can
    // wait for minutes; if the brief moved on meanwhile, the new text is
    // already behind it and must say so. (Older proposals carry none.)
    briefDigest:
      version.proposed.briefDigest ??
      briefDigestFor(brief, usedItemIdsOf({ segments })),
    handEdited: false,
    edits: undefined,
    proposed: undefined,
  };
}

/**
 * Keeps the user's text against a newer brief. The digest is refreshed so
 * "Brief changed" clears: the user has answered it. A quote that no longer
 * matches the brief is still caught, by the grounding check.
 */
export function keepMine(version: Version, brief: Brief): Version {
  if (!version.proposed) return version;
  return {
    ...version,
    briefRev: brief.rev,
    briefDigest: briefDigestFor(brief, usedItemIdsOf(version)),
    proposed: undefined,
  };
}

/** Any change to the segments the user makes by hand. */
export function setSegments(version: Version, segments: Segment[]): Version {
  if (segments === version.segments) return version;
  return { ...version, segments, handEdited: true };
}

export function editSegmentText(
  version: Version,
  segmentId: string,
  text: string,
): Version {
  const capped = text.slice(0, DRAFTER_LIMITS.MAX_SEGMENT_CHARS);
  const current = version.segments.find((s) => s.id === segmentId);
  if (!current || current.text === capped) return version;
  return setSegments(
    version,
    version.segments.map((segment) =>
      segment.id === segmentId ? { ...segment, text: capped } : segment,
    ),
  );
}

export function restoreSnapshot(
  version: Version,
  snapshot: VersionSnapshot,
  ids: string[],
  now: string,
): Version {
  return {
    ...version,
    history: pushHistory(version, 'restored', now),
    // History remembers words only, so the images now on the version stay.
    segments: carryMedia(
      version.segments,
      snapshot.texts.map((text, index) => ({
        id: ids[index] ?? `${version.specId}-r${index}`,
        text,
        usedItemIds: snapshot.usedItemIds?.[index] ?? [],
      })),
    ),
    // The brief those words were written from, so "Brief changed" is true
    // exactly when it changed since THEN.
    briefDigest: snapshot.briefDigest ?? version.briefDigest,
    handEdited: true,
    edits: undefined,
    proposed: undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Verdicts                                                            */
/* ------------------------------------------------------------------ */

/**
 * Lands cite-step results on a version. A verdict is keyed by its
 * sentence, so it applies only while that sentence is still in the text:
 * one whose sentence is not in its segment is dropped, one on a sentence
 * already judged replaces the earlier verdict, and only the newest
 * MAX_VERDICTS are kept. A verdict never changes a grounding mark; whether
 * it still applies is decided by `citationMarks` (core/citations.ts).
 */
export function landVerdicts(
  version: Version,
  incoming: Array<Omit<StatementVerdict, 'id' | 'at'>>,
  ids: string[],
  now: string,
): Version {
  const texts = new Map(
    version.segments.map((segment) => [
      segment.id,
      normalizeForQuoteMatch(segment.text),
    ]),
  );
  const landed: StatementVerdict[] = incoming
    .filter((verdict) => {
      const text = texts.get(verdict.segmentId);
      return (
        !!verdict.sentenceKey && !!text && text.includes(verdict.sentenceKey)
      );
    })
    .map((verdict, index) => ({
      ...verdict,
      id: ids[index] ?? `v${index}`,
      at: now,
    }));
  if (landed.length === 0) return version;
  const replaced = new Set(
    landed.map((verdict) => `${verdict.segmentId}\n${verdict.sentenceKey}`),
  );
  const combined = [
    ...(version.verdicts ?? []).filter(
      (verdict) =>
        !replaced.has(`${verdict.segmentId}\n${verdict.sentenceKey}`),
    ),
    ...landed,
  ];
  // Newest by `at`, then by position; the survivors keep their order.
  const kept = new Set(
    combined
      .map((verdict, index) => ({ verdict, index }))
      .sort(
        (a, b) => b.verdict.at.localeCompare(a.verdict.at) || b.index - a.index,
      )
      .slice(0, DRAFTER_LIMITS.MAX_VERDICTS)
      .map((entry) => entry.index),
  );
  return {
    ...version,
    verdicts: combined.filter((_verdict, index) => kept.has(index)),
  };
}

/**
 * The stored verdict on this sentence of this segment, by key alone. It
 * says nothing about staleness against today's brief: render from
 * `citationMarks` (core/citations.ts), which does.
 */
export function verdictFor(
  version: Version | undefined,
  segmentId: string,
  sentenceText: string,
): StatementVerdict | undefined {
  const key = statementKey(sentenceText);
  return version?.verdicts?.find(
    (verdict) => verdict.segmentId === segmentId && verdict.sentenceKey === key,
  );
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

export interface StatusInputs {
  brief: Brief;
  /** Blocking findings from the deterministic checks. */
  blocking: number;
}

/** Every status that applies, worst first. The UI shows the first. */
export function versionStatuses(
  version: Version | undefined,
  inputs: StatusInputs,
): VersionStatus[] {
  if (!version || !hasText(version)) return ['empty'];
  const statuses: VersionStatus[] = [];
  if (inputs.blocking > 0) statuses.push('to-fix');
  if (version.edits?.some((edit) => edit.status === 'pending')) {
    statuses.push('suggestions');
  }
  if (version.proposed) statuses.push('proposed');
  else if (isStale(version, inputs.brief)) statuses.push('brief-changed');
  const approval = approvalStatus(version);
  if (approval === 'changed') statuses.push('approval-changed');
  if (approval === 'approved' && statuses.length === 0) return ['approved'];
  if (statuses.length === 0) statuses.push('ready');
  return statuses;
}

/** Whether "Approve all ready" may tick this version. */
export function isReadyToApprove(
  version: Version | undefined,
  inputs: StatusInputs,
): boolean {
  const statuses = versionStatuses(version, inputs);
  return (
    statuses.length === 1 &&
    (statuses[0] === 'ready' || statuses[0] === 'approval-changed')
  );
}
