/**
 * Teams meetings for the §4 meeting-import flow (third pass).
 *
 * GET /api/m365/meetings                         → recent online meetings
 *     (calendarView, past 14 days; listing needs only calendar read — the
 *     tenant granted Calendars.ReadWrite, there is no narrower Calendars.Read
 *     in the grant, which user-facing consent copy should note).
 * GET /api/m365/meetings?artifacts=required      → the same listing, but
 *     filtered server-side to meetings that actually have a transcript or
 *     recording, each carrying its resolved resources inline. Costs a
 *     bounded Graph fan-out (see meetingArtifacts.ts); the plain listing
 *     above is unchanged and stays the fallback for "show everything".
 * GET /api/m365/meetings?joinWebUrl=…            → resolve one meeting to its
 *     online-meeting id + available transcripts/recordings.
 * GET /api/m365/meetings?meetingId=…&transcriptId=… → the transcript as
 *     speaker-attributed plain text (VTT parsed server-side).
 *
 * All delegated: only meetings the signed-in user organized or attended
 * resolve. A denied transcript surfaces M365_FORBIDDEN and the client names
 * the organizer — Teams has no request-access flow for transcripts.
 */
import { NextRequest } from 'next/server';

import {
  graphFetch,
  graphJson,
  isValidGraphId,
  m365ErrorResponse,
} from '@/lib/services/m365/graphApi';
import { probeMeetingArtifacts } from '@/lib/services/m365/meetingArtifacts';
import {
  meetingTranscriptFilename,
  parseVttTranscript,
} from '@/lib/services/m365/meetingTranscript';

import {
  badRequestResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import type {
  M365FilteredMeetingList,
  M365MeetingCandidate,
  M365MeetingEntry,
  M365MeetingResources,
} from '@/types/m365';

import { auth } from '@/auth';

const CALENDAR_SCOPES = ['Calendars.ReadWrite'];
const MEETING_SCOPES = [
  'OnlineMeetings.Read',
  'OnlineMeetingTranscript.Read.All',
  'OnlineMeetingRecording.Read.All',
];

/**
 * The probe fan-out (up to 25 meetings x 3 Graph calls) runs inside the
 * request, so the platform default is too tight for the filtered path.
 */
export const maxDuration = 60;

const LOOKBACK_DAYS = 14;
const MAX_MEETINGS = 50;
// Raw calendarView page size — larger than MAX_MEETINGS because the
// online-meeting filter happens in code, after the fetch.
const EVENT_WINDOW = 200;
/**
 * A meeting that ended moments ago may have no transcript *yet* — Teams
 * publishes minutes after the fact. Inside this window "nothing found"
 * reports as pending rather than hiding the meeting.
 */
const TRANSCRIPT_GRACE_MS = 30 * 60_000;

interface GraphEvent {
  id?: string;
  subject?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string };
  isOnlineMeeting?: boolean;
  isCancelled?: boolean;
  onlineMeeting?: { joinUrl?: string };
  organizer?: { emailAddress?: { name?: string; address?: string } };
}

interface GraphMeetingArtifact {
  id?: string;
  createdDateTime?: string;
}

function normalizeEvent(event: GraphEvent): M365MeetingEntry | null {
  const joinWebUrl = event.onlineMeeting?.joinUrl;
  if (!event.id || !joinWebUrl) return null;
  return {
    eventId: event.id,
    subject: event.subject?.trim() || '(no subject)',
    joinWebUrl,
    ...(event.start?.dateTime && { start: `${event.start.dateTime}Z` }),
    ...(event.end?.dateTime && { end: `${event.end.dateTime}Z` }),
    ...(event.organizer?.emailAddress?.name && {
      organizer: event.organizer.emailAddress.name,
    }),
  };
}

/**
 * Collapses a recurring series into one row. Every occurrence of a
 * recurring Teams meeting carries the same join URL and therefore the same
 * online meeting — and the same transcripts. Without this a daily standup
 * fills the list, and probes the identical meeting once per occurrence.
 * The most recent occurrence represents the group; the artifact buttons
 * are labelled with each transcript's own date, so nothing is lost.
 */
function dedupeByJoinWebUrl(meetings: M365MeetingEntry[]): M365MeetingEntry[] {
  const groups = new Map<string, M365MeetingEntry>();
  for (const meeting of meetings) {
    const existing = groups.get(meeting.joinWebUrl);
    if (!existing) {
      groups.set(meeting.joinWebUrl, { ...meeting, occurrences: 1 });
      continue;
    }
    const newer = (meeting.start ?? '') > (existing.start ?? '');
    groups.set(meeting.joinWebUrl, {
      ...(newer ? meeting : existing),
      occurrences: (existing.occurrences ?? 1) + 1,
    });
  }
  return [...groups.values()];
}

function byStartDesc(a: M365MeetingEntry, b: M365MeetingEntry): number {
  return (b.start ?? '').localeCompare(a.start ?? '');
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorizedResponse();
  }

  const params = req.nextUrl.searchParams;
  const joinWebUrl = params.get('joinWebUrl');
  const meetingId = params.get('meetingId');
  const transcriptId = params.get('transcriptId');
  const artifacts = params.get('artifacts');

  try {
    if (meetingId || transcriptId) {
      if (!isValidGraphId(meetingId) || !isValidGraphId(transcriptId)) {
        return badRequestResponse('Invalid meetingId or transcriptId');
      }
      const subject = params.get('subject') ?? undefined;
      const start = params.get('start') ?? undefined;
      const content = await graphFetch(
        req,
        MEETING_SCOPES,
        `/me/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts/${encodeURIComponent(transcriptId)}/content?$format=text/vtt`,
      );
      const vtt = await content.text();
      const parsed = parseVttTranscript(vtt);
      if (!parsed.text) {
        return badRequestResponse(
          'Transcript is empty',
          'M365_EMPTY_TRANSCRIPT',
        );
      }
      return successResponse({
        transcript: parsed.text,
        speakers: parsed.speakers,
        fileName: meetingTranscriptFilename(subject, start),
      });
    }

    if (joinWebUrl) {
      // joinWebUrl is a full URL, not a Graph id — escape only quotes for
      // the OData literal; encodeURIComponent handles the rest.
      const escaped = joinWebUrl.replace(/'/g, "''");
      const data = await graphJson<{
        value?: {
          id?: string;
          participants?: {
            organizer?: {
              upn?: string;
              identity?: { user?: { displayName?: string } };
            };
          };
        }[];
      }>(
        req,
        MEETING_SCOPES,
        `/me/onlineMeetings?$filter=JoinWebUrl%20eq%20'${encodeURIComponent(escaped)}'`,
      );
      const meeting = data.value?.[0];
      if (!meeting?.id) {
        return badRequestResponse(
          'No online meeting found for this event',
          'M365_MEETING_NOT_FOUND',
        );
      }
      const [transcripts, recordings] = await Promise.all([
        graphJson<{ value?: GraphMeetingArtifact[] }>(
          req,
          MEETING_SCOPES,
          `/me/onlineMeetings/${encodeURIComponent(meeting.id)}/transcripts`,
        ).catch(() => ({ value: [] })),
        graphJson<{ value?: GraphMeetingArtifact[] }>(
          req,
          MEETING_SCOPES,
          `/me/onlineMeetings/${encodeURIComponent(meeting.id)}/recordings`,
        ).catch(() => ({ value: [] })),
      ]);
      const resources: M365MeetingResources = {
        meetingId: meeting.id,
        organizer:
          meeting.participants?.organizer?.identity?.user?.displayName ??
          meeting.participants?.organizer?.upn,
        transcripts: (transcripts.value ?? [])
          .filter((a): a is { id: string; createdDateTime?: string } => !!a.id)
          .map((a) => ({ id: a.id, created: a.createdDateTime })),
        recordings: (recordings.value ?? [])
          .filter((a): a is { id: string; createdDateTime?: string } => !!a.id)
          .map((a) => ({ id: a.id, created: a.createdDateTime })),
      };
      return successResponse(resources);
    }

    if (artifacts !== null && artifacts !== 'required') {
      return badRequestResponse('artifacts must be "required" when present');
    }

    // Listing: recent calendarView window. Graph requires explicit
    // start/end, and calendarView supports NEITHER $filter on
    // isOnlineMeeting NOR a reliable $orderby — so fetch the window and do
    // both in code (normalizeEvent drops non-online events by requiring a
    // join URL).
    const end = new Date();
    const startWindow = new Date(end.getTime() - LOOKBACK_DAYS * 86_400_000);
    const path =
      `/me/calendarView?startDateTime=${startWindow.toISOString()}&endDateTime=${end.toISOString()}` +
      `&$select=id,subject,start,end,isOnlineMeeting,onlineMeeting,organizer,isCancelled` +
      `&$top=${EVENT_WINDOW}`;
    const data = await graphJson<{ value?: GraphEvent[] }>(
      req,
      CALENDAR_SCOPES,
      path,
      // Graph already defaults event times to UTC; asking explicitly makes
      // the `Z` normalizeEvent appends true by contract rather than by
      // default, which the "has it ended" filter below relies on.
      { headers: { Prefer: 'outlook.timezone="UTC"' } },
    );
    const events = data.value ?? [];
    const normalized = events
      .map(normalizeEvent)
      .filter((m): m is M365MeetingEntry => m !== null);

    if (artifacts !== 'required') {
      return successResponse({
        meetings: normalized.sort(byStartDesc).slice(0, MAX_MEETINGS),
      });
    }

    // Filtered listing. Everything below narrows the candidate set BEFORE
    // spending Graph calls: a cancelled or still-running meeting can have
    // nothing attached, and a recurring series is one meeting.
    //
    // hiddenCount is what "Show all meetings (N hidden)" promises, so it
    // counts every meeting this view drops for ANY reason — not just the
    // ones a probe proved empty. Undercounting it would make the toggle
    // reveal more rows than it advertised.
    const nowMs = end.getTime();
    const cancelled = new Set(
      events.filter((e) => e.isCancelled && e.id).map((e) => e.id),
    );
    let hiddenCount = 0;
    // Cancelled occurrences drop out before dedupe so that one scrapped
    // instance of a recurring series never speaks for the whole series.
    const live = normalized.filter((m) => !cancelled.has(m.eventId));
    // Both narrowing passes run per OCCURRENCE and before dedupe. Dropping
    // occurrences first is what makes the representative meaningful: pick
    // it first and a series whose latest occurrence is still in progress
    // would take every earlier, transcribed occurrence down with it, even
    // though the probe is keyed on the join URL they all share.
    const finished = live.filter((m) => {
      // No parseable end (an all-day or malformed event) is not grounds to
      // hide a meeting sight unseen — probe it like any other.
      const ended = m.end ? Date.parse(m.end) : NaN;
      return !Number.isFinite(ended) || ended <= nowMs;
    });
    const finishedUrls = new Set(finished.map((m) => m.joinWebUrl));
    // A meeting only counts as hidden once, however many occurrences it
    // has, and only when NO occurrence of it survived.
    for (const url of new Set(normalized.map((m) => m.joinWebUrl))) {
      if (!finishedUrls.has(url)) hiddenCount++;
    }
    const deduped = dedupeByJoinWebUrl(finished).sort(byStartDesc);
    const { outcomes, budgetExhausted, throttled } =
      await probeMeetingArtifacts(req, deduped);
    const byEventId = new Map(deduped.map((m) => [m.eventId, m]));

    let unprobedCount = 0;
    const candidates: M365MeetingCandidate[] = [];
    for (const outcome of outcomes) {
      const meeting = byEventId.get(outcome.eventId);
      if (!meeting) continue;
      if (outcome.status === 'available') {
        candidates.push({
          ...meeting,
          availability: 'available',
          resources: outcome.resources,
          ...(outcome.partial && { partial: true }),
        });
      } else if (outcome.status === 'forbidden') {
        // Denied is not empty: keep the row so the modal can name the
        // organizer to ask, which is the only route Teams offers.
        candidates.push({ ...meeting, availability: 'forbidden' });
      } else if (outcome.status === 'unprobed') {
        // Unknown, so not shown — but still a row "Show all" would reveal.
        unprobedCount++;
        hiddenCount++;
      } else if (
        outcome.status === 'none' &&
        meeting.end &&
        nowMs - Date.parse(meeting.end) < TRANSCRIPT_GRACE_MS
      ) {
        // Probed clean and empty, but Teams may still be publishing. Only
        // 'none' earns this: an unresolved meeting has nothing to wait for.
        candidates.push({ ...meeting, availability: 'pending' });
      } else {
        hiddenCount++;
      }
    }

    const payload: M365FilteredMeetingList = {
      meetings: candidates.sort(byStartDesc).slice(0, MAX_MEETINGS),
      hiddenCount,
      unprobedCount,
      ...(budgetExhausted && { budgetExhausted: true }),
      ...(throttled && { throttled: true }),
      // The raw window filled its page, so older meetings in the lookback
      // were never seen — a silent truncation would read as "nothing there".
      ...(events.length >= EVENT_WINDOW && { windowTruncated: true }),
    };
    return successResponse(payload);
  } catch (error) {
    return m365ErrorResponse(error);
  }
}
