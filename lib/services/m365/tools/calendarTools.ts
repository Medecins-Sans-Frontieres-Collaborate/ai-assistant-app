/**
 * Calendar tools (fourth pass B2): calendar_list_events,
 * calendar_get_schedule, calendar_create_event. graphApi is lazy-imported
 * inside each function so this module graph stays free of next-auth.
 *
 * All Graph times are requested/sent in UTC (Prefer: outlook.timezone) so
 * rendered slots are unambiguous for the model.
 */
import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import {
  M365ToolInputError,
  catalogScopes,
  clampNumber,
  formatGraphDateTime,
  formatGraphTime,
  isValidEmail,
  optionalString,
  parseAsUtc,
  requireIsoDate,
  requireString,
  toDateTime,
  truncateText,
} from '@/lib/services/m365/tools/shared';

interface GraphEvent {
  subject?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  location?: { displayName?: string };
  organizer?: { emailAddress?: { name?: string; address?: string } };
  isOnlineMeeting?: boolean;
  attendees?: { emailAddress?: { address?: string } }[];
  webLink?: string;
}

const UTC_PREFER = 'outlook.timezone="UTC"';

export async function calendarListEvents(
  req: NextRequest,
  _session: Session,
  args: Record<string, unknown>,
): Promise<string> {
  const start = toDateTime(requireIsoDate(args, 'startDate'), 'start');
  const end = toDateTime(requireIsoDate(args, 'endDate'), 'end');
  const maxEvents = clampNumber(args, 'maxEvents', 25, 50);

  const { graphJson } = await import('@/lib/services/m365/graphApi');
  // calendarView rejects $filter/$orderby — the range IS the filter; sort
  // client-side below.
  const data = await graphJson<{
    value?: GraphEvent[];
    '@odata.nextLink'?: string;
  }>(
    req,
    catalogScopes('calendar_list_events'),
    `/me/calendarView?startDateTime=${encodeURIComponent(start)}` +
      `&endDateTime=${encodeURIComponent(end)}` +
      `&$select=subject,start,end,location,organizer,isOnlineMeeting,attendees` +
      `&$top=${maxEvents}`,
    { headers: { Prefer: UTC_PREFER } },
  );

  const events = (data.value ?? [])
    .slice()
    .sort((a, b) =>
      (a.start?.dateTime ?? '').localeCompare(b.start?.dateTime ?? ''),
    );
  if (events.length === 0) {
    return `No calendar events between ${start} and ${end}.`;
  }

  const lines = events.map((event) => {
    const parts = [
      `${formatGraphDateTime(event.start?.dateTime)}–${formatGraphTime(event.end?.dateTime)} UTC`,
      event.subject?.trim() || '(no subject)',
    ];
    if (event.location?.displayName) parts.push(event.location.displayName);
    const organizer =
      event.organizer?.emailAddress?.name ||
      event.organizer?.emailAddress?.address;
    if (organizer) parts.push(`organizer: ${organizer}`);
    if (event.isOnlineMeeting) parts.push('Teams meeting');
    return `- ${parts.join(' — ')}`;
  });

  const header = data['@odata.nextLink']
    ? `Events ${start} to ${end} (showing first ${events.length}; more exist):`
    : `Events ${start} to ${end} (${events.length}):`;
  return [header, ...lines].join('\n');
}

const AVAILABILITY_LABEL: Record<string, string> = {
  '0': 'Free',
  '1': 'Tentative',
  '2': 'Busy',
  '3': 'Out of office',
  '4': 'Working elsewhere',
};

function renderAvailabilityRuns(
  view: string,
  windowStart: Date,
  intervalMinutes: number,
): string {
  const runs: string[] = [];
  let runStart = 0;
  for (let i = 1; i <= view.length; i++) {
    if (i === view.length || view[i] !== view[runStart]) {
      const from = new Date(
        windowStart.getTime() + runStart * intervalMinutes * 60_000,
      );
      const to = new Date(windowStart.getTime() + i * intervalMinutes * 60_000);
      const label = AVAILABILITY_LABEL[view[runStart]] ?? 'Unknown';
      runs.push(
        `${label} ${from.toISOString().slice(0, 16).replace('T', ' ')}–${to
          .toISOString()
          .slice(11, 16)}`,
      );
      runStart = i;
    }
  }
  return runs.join(', ');
}

export async function calendarGetSchedule(
  req: NextRequest,
  session: Session,
  args: Record<string, unknown>,
): Promise<string> {
  const start = requireIsoDate(args, 'startDateTime');
  const end = requireIsoDate(args, 'endDateTime');
  const interval = clampNumber(args, 'intervalMinutes', 30, 240, 5);

  const rawAttendees = args.attendees;
  if (rawAttendees !== undefined && !Array.isArray(rawAttendees)) {
    throw new M365ToolInputError('attendees must be an array of emails');
  }
  const attendees = ((rawAttendees as unknown[] | undefined) ?? []).map(
    (entry) => {
      if (!isValidEmail(entry)) {
        throw new M365ToolInputError(
          `attendees contains an invalid email: ${truncateText(String(entry), 60)}`,
        );
      }
      return entry;
    },
  );

  const ownMail = session.user?.mail;
  const schedules = Array.from(
    new Set(
      [ownMail, ...attendees]
        .filter((m): m is string => !!m)
        .map((m) => m.toLowerCase()),
    ),
  );
  if (schedules.length === 0) {
    throw new M365ToolInputError(
      'No calendars to check — provide attendee emails',
    );
  }

  const { graphJson } = await import('@/lib/services/m365/graphApi');
  const data = await graphJson<{
    value?: { scheduleId?: string; availabilityView?: string }[];
  }>(req, catalogScopes('calendar_get_schedule'), '/me/calendar/getSchedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: UTC_PREFER },
    body: JSON.stringify({
      schedules,
      startTime: { dateTime: toDateTime(start, 'start'), timeZone: 'UTC' },
      endTime: { dateTime: toDateTime(end, 'end'), timeZone: 'UTC' },
      availabilityViewInterval: interval,
    }),
  });

  const windowStart = parseAsUtc(toDateTime(start, 'start'));
  const lines = (data.value ?? []).map((entry) => {
    const who = entry.scheduleId ?? 'unknown';
    if (!entry.availabilityView) {
      return `- ${who}: availability unavailable`;
    }
    return `- ${who}: ${renderAvailabilityRuns(entry.availabilityView, windowStart, interval)}`;
  });
  if (lines.length === 0) {
    return 'No availability information returned.';
  }
  return [
    `Availability ${start} to ${end} UTC (${interval}-minute slots):`,
    ...lines,
  ].join('\n');
}

export async function calendarCreateEvent(
  req: NextRequest,
  _session: Session,
  args: Record<string, unknown>,
): Promise<string> {
  const subject = requireString(args, 'subject');
  const start = toDateTime(requireIsoDate(args, 'startDateTime'), 'start');
  const end = toDateTime(requireIsoDate(args, 'endDateTime'), 'end');
  const body = optionalString(args, 'body');
  const location = optionalString(args, 'location');
  const isOnlineMeeting = args.isOnlineMeeting === true;

  const rawAttendees = args.attendees;
  if (rawAttendees !== undefined && !Array.isArray(rawAttendees)) {
    throw new M365ToolInputError('attendees must be an array of emails');
  }
  const attendees = ((rawAttendees as unknown[] | undefined) ?? []).map(
    (entry) => {
      if (!isValidEmail(entry)) {
        throw new M365ToolInputError(
          `attendees contains an invalid email: ${truncateText(String(entry), 60)}`,
        );
      }
      return { emailAddress: { address: entry }, type: 'required' };
    },
  );

  const { graphJson } = await import('@/lib/services/m365/graphApi');
  const created = await graphJson<GraphEvent>(
    req,
    catalogScopes('calendar_create_event'),
    '/me/events',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: UTC_PREFER },
      body: JSON.stringify({
        subject,
        ...(body && { body: { contentType: 'text', content: body } }),
        start: { dateTime: start, timeZone: 'UTC' },
        end: { dateTime: end, timeZone: 'UTC' },
        ...(attendees.length > 0 && { attendees }),
        ...(location && { location: { displayName: location } }),
        ...(isOnlineMeeting && {
          isOnlineMeeting: true,
          onlineMeetingProvider: 'teamsForBusiness',
        }),
      }),
    },
  );

  const parts = [
    `Created "${created.subject ?? subject}"`,
    `${formatGraphDateTime(created.start?.dateTime ?? start)}–${formatGraphTime(created.end?.dateTime ?? end)} UTC`,
  ];
  if (attendees.length > 0) parts.push(`${attendees.length} attendee(s)`);
  if (isOnlineMeeting) parts.push('Teams meeting attached');
  const link = created.webLink ? `\nLink: ${created.webLink}` : '';
  return parts.join(' — ') + link;
}
