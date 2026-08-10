/**
 * Teams meetings for the §4 meeting-import flow (third pass).
 *
 * GET /api/m365/meetings                         → recent online meetings
 *     (calendarView, past 14 days; listing needs only calendar read — the
 *     tenant granted Calendars.ReadWrite, there is no narrower Calendars.Read
 *     in the grant, which user-facing consent copy should note).
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
import {
  meetingTranscriptFilename,
  parseVttTranscript,
} from '@/lib/services/m365/meetingTranscript';

import {
  badRequestResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import type { M365MeetingEntry, M365MeetingResources } from '@/types/m365';

import { auth } from '@/auth';

const CALENDAR_SCOPES = ['Calendars.ReadWrite'];
const MEETING_SCOPES = [
  'OnlineMeetings.Read',
  'OnlineMeetingTranscript.Read.All',
  'OnlineMeetingRecording.Read.All',
];

const LOOKBACK_DAYS = 14;
const MAX_MEETINGS = 50;
// Raw calendarView page size — larger than MAX_MEETINGS because the
// online-meeting filter happens in code, after the fetch.
const EVENT_WINDOW = 200;

interface GraphEvent {
  id?: string;
  subject?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string };
  isOnlineMeeting?: boolean;
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
    ...(event.organizer?.emailAddress?.name && {
      organizer: event.organizer.emailAddress.name,
    }),
  };
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

    // Listing: recent calendarView window. Graph requires explicit
    // start/end, and calendarView supports NEITHER $filter on
    // isOnlineMeeting NOR a reliable $orderby — so fetch the window and do
    // both in code (normalizeEvent drops non-online events by requiring a
    // join URL).
    const end = new Date();
    const startWindow = new Date(end.getTime() - LOOKBACK_DAYS * 86_400_000);
    const path =
      `/me/calendarView?startDateTime=${startWindow.toISOString()}&endDateTime=${end.toISOString()}` +
      `&$select=id,subject,start,end,isOnlineMeeting,onlineMeeting,organizer` +
      `&$top=${EVENT_WINDOW}`;
    const data = await graphJson<{ value?: GraphEvent[] }>(
      req,
      CALENDAR_SCOPES,
      path,
    );
    const meetings = (data.value ?? [])
      .map(normalizeEvent)
      .filter((m): m is M365MeetingEntry => m !== null)
      .sort((a, b) => (b.start ?? '').localeCompare(a.start ?? ''))
      .slice(0, MAX_MEETINGS);
    return successResponse({ meetings });
  } catch (error) {
    return m365ErrorResponse(error);
  }
}
