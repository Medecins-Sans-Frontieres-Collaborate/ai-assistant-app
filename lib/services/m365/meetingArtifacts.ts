/**
 * Artifact probing for the filtered meeting listing.
 *
 * The calendar knows a meeting was a Teams meeting; it does not know whether
 * anything was captured. Transcripts and recordings hang off the
 * *onlineMeeting* resource, and Graph offers no join between the two in one
 * query (`getAllTranscripts` / `getAllRecordings` are application-permission
 * only, so they are closed to this delegated flow). Availability therefore
 * costs three calls per meeting: resolve the join URL to an online-meeting
 * id, then list transcripts and recordings.
 *
 * Two rules make that affordable and honest:
 *
 * 1. ONE token for the whole fan-out. `graphFetch` mints a fresh delegated
 *    token per call, so 25 probes would be 75 uncached ESTS round trips.
 *    Minting once and issuing raw fetches makes it one — the same reason
 *    the mail composites carry their own `graphGetJson`.
 * 2. A 403 is not an empty result. The lazy resolve path collapses both
 *    into an empty artifact array, which is harmless when a human is
 *    reading the panel and actively wrong when the answer decides whether
 *    a meeting is shown at all. Every failure is classified instead.
 *
 * Per-meeting failures never fail the request: they become an outcome
 * status. Only the token mint throws, because without it nothing can be
 * probed at all.
 */
import { NextRequest } from 'next/server';

import {
  GRAPH_V1,
  M365Error,
  graphErrorFromResponse,
  mintGraphToken,
} from '@/lib/services/m365/graphApi';
import { createLimiter } from '@/lib/services/m365/graphLimiter';

import type { M365MeetingEntry, M365MeetingResources } from '@/types/m365';

/**
 * Meetings probed at once. A probe holds its slot while fanning its two
 * artifact listings out in parallel, so the true ceiling on simultaneous
 * Graph requests is 2x this — the legs deliberately do NOT take slots of
 * their own, which would deadlock once every slot is held by a waiter.
 */
export const PROBE_CONCURRENCY = 4;
/** Hard cap on meetings probed per listing (each is up to 3 Graph calls). */
export const MAX_ARTIFACT_PROBES = 25;
/** Cooperative wall clock: checked before a probe starts, never mid-flight. */
export const PROBE_BUDGET_MS = 12_000;

export const MEETING_PROBE_SCOPES = [
  'OnlineMeetings.Read',
  'OnlineMeetingTranscript.Read.All',
  'OnlineMeetingRecording.Read.All',
];

let nowFn: () => number = () => Date.now();

/** Test hook for the wall-clock budget. */
export function setNowFnForTests(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now());
}

export type M365ProbeStatus =
  | 'available'
  /**
   * Graph answered and there is nothing attached. Reserved for a clean
   * answer: every error, 404 included, degrades to 'unprobed' or
   * 'forbidden' instead.
   */
  | 'none'
  /**
   * The join URL matched no online meeting the user can address — almost
   * always a meeting they attended rather than organized. Nothing is
   * attachable, and unlike 'none' nothing ever will be.
   */
  | 'unresolved'
  | 'forbidden'
  | 'unprobed';

export interface M365MeetingProbeOutcome {
  /** Identifies the candidate this outcome belongs to. */
  eventId: string;
  status: M365ProbeStatus;
  /** Set only for 'available'. */
  resources?: M365MeetingResources;
  /** One artifact listing failed while the other succeeded. */
  partial?: boolean;
}

export interface M365ProbeResult {
  outcomes: M365MeetingProbeOutcome[];
  /** A candidate was skipped for cap or wall-clock reasons. */
  budgetExhausted: boolean;
  /** Graph returned 429 at some point during the fan-out. */
  throttled: boolean;
}

interface GraphMeetingArtifact {
  id?: string;
  createdDateTime?: string;
}

interface GraphOnlineMeeting {
  id?: string;
  participants?: {
    organizer?: {
      upn?: string;
      identity?: { user?: { displayName?: string } };
    };
  };
}

function toArtifacts(artifacts: GraphMeetingArtifact[] | undefined) {
  return (artifacts ?? [])
    .filter((a): a is { id: string; createdDateTime?: string } => !!a.id)
    .map((a) => ({ id: a.id, created: a.createdDateTime }));
}

/**
 * The join URL is a full URL, not a Graph id: double the quotes for the
 * OData string literal, then percent-encode the result. Identical to the
 * lazy resolve path in the route — the two must not drift.
 */
function joinUrlFilter(joinWebUrl: string): string {
  const escaped = joinWebUrl.replace(/'/g, "''");
  return `/me/onlineMeetings?$filter=JoinWebUrl%20eq%20'${encodeURIComponent(escaped)}'`;
}

export async function probeMeetingArtifacts(
  req: NextRequest,
  candidates: M365MeetingEntry[],
): Promise<M365ProbeResult> {
  if (candidates.length === 0) {
    return { outcomes: [], budgetExhausted: false, throttled: false };
  }

  // Throws (consent_missing / not_connected / graph_error) — a listing that
  // cannot probe at all is a real error, not a partial result.
  const token = await mintGraphToken(req, MEETING_PROBE_SCOPES);

  const startedAt = nowFn();
  const schedule = createLimiter(PROBE_CONCURRENCY);
  let budgetExhausted = false;
  let throttled = false;

  const get = async <T>(path: string): Promise<T> => {
    const response = await fetch(`${GRAPH_V1}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw await graphErrorFromResponse(response);
    }
    return (await response.json()) as T;
  };

  const classifyFailure = (error: unknown): { status: M365ProbeStatus } => {
    if (error instanceof M365Error) {
      if (error.kind === 'forbidden') return { status: 'forbidden' };
      if (error.kind === 'rate_limited') {
        throttled = true;
        return { status: 'unprobed' };
      }
    }
    return { status: 'unprobed' };
  };

  const probeOne = async (
    candidate: M365MeetingEntry,
  ): Promise<M365MeetingProbeOutcome> => {
    // Once Graph throttles, every further probe would just deepen the hole;
    // the remaining candidates report as unknown instead.
    if (throttled) {
      return { eventId: candidate.eventId, status: 'unprobed' };
    }
    if (nowFn() - startedAt >= PROBE_BUDGET_MS) {
      budgetExhausted = true;
      return { eventId: candidate.eventId, status: 'unprobed' };
    }

    let meeting: GraphOnlineMeeting | undefined;
    try {
      const resolved = await get<{ value?: GraphOnlineMeeting[] }>(
        joinUrlFilter(candidate.joinWebUrl),
      );
      meeting = resolved.value?.[0];
    } catch (error) {
      return { eventId: candidate.eventId, ...classifyFailure(error) };
    }
    // Delegated /me/onlineMeetings resolves meetings the user ORGANIZED, so
    // no match is the ordinary answer for a meeting they merely attended.
    // Distinct from 'none' because nothing is attachable there at all —
    // badging it "may still be processing" would be a lie, and the lazy
    // resolve behind an expand would only 404.
    if (!meeting?.id) {
      return { eventId: candidate.eventId, status: 'unresolved' };
    }

    const id = encodeURIComponent(meeting.id);
    const [transcripts, recordings] = await Promise.all([
      get<{ value?: GraphMeetingArtifact[] }>(
        `/me/onlineMeetings/${id}/transcripts`,
      ).catch((error: unknown) => error as Error),
      get<{ value?: GraphMeetingArtifact[] }>(
        `/me/onlineMeetings/${id}/recordings`,
      ).catch((error: unknown) => error as Error),
    ]);

    const transcriptFailure = transcripts instanceof Error ? transcripts : null;
    const recordingFailure = recordings instanceof Error ? recordings : null;

    const failures = [transcriptFailure, recordingFailure].filter(
      (failure): failure is Error => !!failure,
    );
    // A 429 on either leg still stops the fan-out, whatever this meeting
    // turns out to hold.
    if (
      failures.some(
        (failure) =>
          failure instanceof M365Error && failure.kind === 'rate_limited',
      )
    ) {
      throttled = true;
    }

    const organizer =
      meeting.participants?.organizer?.identity?.user?.displayName ??
      meeting.participants?.organizer?.upn;
    const resources: M365MeetingResources = {
      meetingId: meeting.id,
      ...(organizer && { organizer }),
      transcripts: toArtifacts(
        transcriptFailure
          ? []
          : (transcripts as { value?: GraphMeetingArtifact[] }).value,
      ),
      recordings: toArtifacts(
        recordingFailure
          ? []
          : (recordings as { value?: GraphMeetingArtifact[] }).value,
      ),
    };
    const partial = failures.length > 0;
    // What one leg answered stands even when its sibling failed: a readable
    // transcript must not be thrown away because the recordings listing
    // 403'd or got throttled. The row is 'available' and flagged partial.
    if (resources.transcripts.length > 0 || resources.recordings.length > 0) {
      return {
        eventId: candidate.eventId,
        status: 'available',
        resources,
        ...(partial && { partial: true }),
      };
    }
    // Nothing found, and at least one leg never answered. A denial is the
    // more informative verdict (the modal can name the organizer to ask);
    // anything else is simply unknown. Half an answer is never proof of
    // nothing, so neither may hide the meeting.
    if (
      failures.some(
        (failure) =>
          failure instanceof M365Error && failure.kind === 'forbidden',
      )
    ) {
      return { eventId: candidate.eventId, status: 'forbidden' };
    }
    if (partial) {
      return { eventId: candidate.eventId, status: 'unprobed' };
    }
    return { eventId: candidate.eventId, status: 'none' };
  };

  const probed = candidates.slice(0, MAX_ARTIFACT_PROBES);
  if (candidates.length > probed.length) {
    budgetExhausted = true;
  }
  const outcomes = await Promise.all(
    probed.map((candidate) => schedule(() => probeOne(candidate))),
  );

  return {
    outcomes: [
      ...outcomes,
      ...candidates
        .slice(MAX_ARTIFACT_PROBES)
        .map((c) => ({ eventId: c.eventId, status: 'unprobed' as const })),
    ],
    budgetExhausted,
    throttled,
  };
}
