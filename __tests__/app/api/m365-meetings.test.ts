/**
 * Meetings listing (§4): calendarView supports neither $filter on
 * isOnlineMeeting nor reliable $orderby — the route must fetch the window
 * plain and filter/sort in code (a $filter regression fails live with
 * "The property 'isOnlineMeeting' does not support filtering").
 *
 * The `?artifacts=required` branch is covered here at the ASSEMBLY level:
 * the probe is mocked, so these tests pin param validation, the
 * cancelled/not-ended pre-filter, join-URL dedupe, the grace window, the
 * hidden/unprobed counters and the sort+cap. The probe's own semantics
 * (403-vs-empty, wall clock, concurrency) live in its unit test.
 */
import { NextRequest } from 'next/server';

import { M365Error } from '@/lib/services/m365/graphApi';
import type { M365ProbeResult } from '@/lib/services/m365/meetingArtifacts';

import { parseJsonResponse } from './helpers';

import { GET as meetingsGET } from '@/app/api/m365/meetings/route';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const graphJsonMock = vi.hoisted(() => vi.fn());
const probeMock = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({
  auth: vi.fn(async () => ({ user: { id: 'user-1' } })),
  getGraphAccessToken: vi.fn(),
}));
vi.mock('@/lib/services/m365/graphApi', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/m365/graphApi')>();
  return { ...actual, graphJson: graphJsonMock, graphFetch: vi.fn() };
});
// Only the probe entry point is stubbed; the module's exported constants
// stay real so this file never drifts from the service's own limits.
vi.mock('@/lib/services/m365/meetingArtifacts', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/lib/services/m365/meetingArtifacts')
    >();
  return { ...actual, probeMeetingArtifacts: probeMock };
});

/** Mirrors the route-local MAX_MEETINGS (not exported). */
const MAX_MEETINGS = 50;
/** Mirrors the route-local EVENT_WINDOW (not exported). */
const EVENT_WINDOW = 200;

const NOW = Date.parse('2026-07-30T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Graph hands back naive local date-times; the route appends the `Z` itself.
 * Producing times the same way keeps the ended/pending boundaries exact.
 */
function graphTime(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString().replace('Z', '');
}

function event(
  id: string,
  subject: string,
  startIso: string,
  joinUrl?: string,
  extra: { end?: string; isCancelled?: boolean } = {},
) {
  return {
    id,
    subject,
    start: { dateTime: startIso },
    ...(extra.end !== undefined && { end: { dateTime: extra.end } }),
    isOnlineMeeting: !!joinUrl,
    ...(joinUrl && { onlineMeeting: { joinUrl } }),
    ...(extra.isCancelled !== undefined && { isCancelled: extra.isCancelled }),
    organizer: { emailAddress: { name: 'Org Anizer' } },
  };
}

function request(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/m365/meetings${query}`);
}

function probeResult(
  outcomes: M365ProbeResult['outcomes'],
  flags: Partial<Pick<M365ProbeResult, 'budgetExhausted' | 'throttled'>> = {},
): M365ProbeResult {
  return {
    outcomes,
    budgetExhausted: false,
    throttled: false,
    ...flags,
  };
}

/** Runs the filtered branch and returns its parsed `data` payload. */
async function filteredListing(events: unknown[]) {
  graphJsonMock.mockResolvedValue({ value: events });
  const response = await meetingsGET(request('?artifacts=required'));
  const body = await parseJsonResponse(response);
  return { response, body, data: body.data };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  probeMock.mockResolvedValue(probeResult([]));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/m365/meetings (listing)', () => {
  it('queries calendarView WITHOUT $filter or $orderby', async () => {
    graphJsonMock.mockResolvedValue({ value: [] });
    const response = await meetingsGET(
      new NextRequest('http://localhost/api/m365/meetings'),
    );
    expect(response.status).toBe(200);
    const path = graphJsonMock.mock.calls[0][2] as string;
    expect(path).toContain('/me/calendarView?startDateTime=');
    expect(path).not.toContain('$filter');
    expect(path).not.toContain('$orderby');
  });

  it('drops non-online events and sorts newest first in code', async () => {
    graphJsonMock.mockResolvedValue({
      value: [
        event(
          'e1',
          'Old sync',
          '2026-07-20T09:00:00.0000000',
          'https://join/1',
        ),
        event('e2', 'Lunch', '2026-07-29T12:00:00.0000000'),
        event(
          'e3',
          'New sync',
          '2026-07-30T09:00:00.0000000',
          'https://join/3',
        ),
      ],
    });
    const response = await meetingsGET(
      new NextRequest('http://localhost/api/m365/meetings'),
    );
    const body = await response.json();
    expect(
      body.data.meetings.map((m: { subject: string }) => m.subject),
    ).toEqual(['New sync', 'Old sync']);
  });

  it('never probes, keeps cancelled meetings and does not dedupe without the param', async () => {
    graphJsonMock.mockResolvedValue({
      value: [
        event('e1', 'Standup Mon', graphTime(-2 * DAY), 'https://join/rec', {
          end: graphTime(-2 * DAY + HOUR),
        }),
        event('e2', 'Standup Tue', graphTime(-1 * DAY), 'https://join/rec', {
          end: graphTime(-1 * DAY + HOUR),
        }),
        event('e3', 'Scrapped', graphTime(-3 * HOUR), 'https://join/dead', {
          end: graphTime(-2 * HOUR),
          isCancelled: true,
        }),
      ],
    });

    const response = await meetingsGET(request());
    const body = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(probeMock).not.toHaveBeenCalled();
    // Today's shape exactly: nothing but `meetings`.
    expect(Object.keys(body.data)).toEqual(['meetings']);
    expect(
      body.data.meetings.map((m: { subject: string }) => m.subject),
    ).toEqual(['Scrapped', 'Standup Tue', 'Standup Mon']);
    // No dedupe: both occurrences of the shared join URL survive.
    expect(
      body.data.meetings.filter(
        (m: { joinWebUrl: string }) => m.joinWebUrl === 'https://join/rec',
      ),
    ).toHaveLength(2);
    // No availability/occurrences decoration on the plain path.
    for (const meeting of body.data.meetings) {
      expect(meeting).not.toHaveProperty('availability');
      expect(meeting).not.toHaveProperty('occurrences');
    }
  });
});

describe('GET /api/m365/meetings?artifacts=… (validation)', () => {
  it('rejects any value other than "required" before touching Graph', async () => {
    for (const value of ['1', 'true', '', 'REQUIRED', 'optional']) {
      const response = await meetingsGET(request(`?artifacts=${value}`));
      expect(response.status).toBe(400);
    }
    expect(graphJsonMock).not.toHaveBeenCalled();
    expect(probeMock).not.toHaveBeenCalled();
  });

  it('asks for isCancelled and UTC times, still without $filter or $orderby', async () => {
    await filteredListing([]);

    const [, , path, init] = graphJsonMock.mock.calls[0] as [
      unknown,
      unknown,
      string,
      { headers?: Record<string, string> },
    ];
    expect(path).toContain('/me/calendarView?startDateTime=');
    expect(path).toContain('isCancelled');
    expect(path).toContain(`$top=${EVENT_WINDOW}`);
    expect(path).not.toContain('$filter');
    expect(path).not.toContain('$orderby');
    expect(init.headers?.Prefer).toBe('outlook.timezone="UTC"');
  });
});

describe('GET /api/m365/meetings?artifacts=required (candidate selection)', () => {
  it('hides a cancelled meeting but still probes one with no parseable end', async () => {
    // A missing or malformed end (an all-day event, say) says nothing
    // about whether a transcript exists — hiding it sight unseen would
    // report a meeting as content-less without ever asking.
    const { data } = await filteredListing([
      event('cancelled', 'Scrapped', graphTime(-3 * HOUR), 'https://join/a', {
        end: graphTime(-2 * HOUR),
        isCancelled: true,
      }),
      event('no-end', 'Open ended', graphTime(-3 * HOUR), 'https://join/b'),
    ]);

    expect(
      probeMock.mock.calls[0][1].map((m: { eventId: string }) => m.eventId),
    ).toEqual(['no-end']);
    expect(data.meetings).toEqual([]);
    expect(data.hiddenCount).toBe(1);
    expect(data.unprobedCount).toBe(0);
  });

  it('hides a recurring series only when every occurrence is cancelled', async () => {
    const { data } = await filteredListing([
      event('c1', 'Standup', graphTime(-2 * DAY), 'https://join/dead', {
        end: graphTime(-2 * DAY + HOUR),
        isCancelled: true,
      }),
      event('c2', 'Standup', graphTime(-1 * DAY), 'https://join/dead', {
        end: graphTime(-1 * DAY + HOUR),
        isCancelled: true,
      }),
      // One scrapped instance must not speak for the whole series.
      event('l1', 'Weekly', graphTime(-2 * DAY), 'https://join/live', {
        end: graphTime(-2 * DAY + HOUR),
        isCancelled: true,
      }),
      event('l2', 'Weekly', graphTime(-1 * DAY), 'https://join/live', {
        end: graphTime(-1 * DAY + HOUR),
      }),
    ]);

    expect(
      probeMock.mock.calls[0][1].map((m: { eventId: string }) => m.eventId),
    ).toEqual(['l2']);
    // One group vanished entirely; it is counted once, not per occurrence.
    expect(data.hiddenCount).toBe(1);
  });

  it('skips a meeting that is still running and counts it as hidden', async () => {
    const { data } = await filteredListing([
      event(
        'running',
        'In progress',
        graphTime(-30 * MINUTE),
        'https://join/a',
        {
          end: graphTime(30 * MINUTE),
        },
      ),
    ]);

    expect(probeMock.mock.calls[0][1]).toEqual([]);
    expect(data.meetings).toEqual([]);
    // "Show all meetings (N hidden)" must not under-promise: the toggle
    // would reveal this meeting, so it is counted here.
    expect(data.hiddenCount).toBe(1);
    expect(data.unprobedCount).toBe(0);
  });

  it('collapses recurring occurrences into one candidate and one probe', async () => {
    const occurrences = [
      event('r1', 'Standup', graphTime(-3 * DAY), 'https://join/rec', {
        end: graphTime(-3 * DAY + 30 * MINUTE),
      }),
      event('r3', 'Standup', graphTime(-1 * DAY), 'https://join/rec', {
        end: graphTime(-1 * DAY + 30 * MINUTE),
      }),
      event('r2', 'Standup', graphTime(-2 * DAY), 'https://join/rec', {
        end: graphTime(-2 * DAY + 30 * MINUTE),
      }),
    ];
    probeMock.mockResolvedValue(
      probeResult([
        {
          eventId: 'r3',
          status: 'available',
          resources: { meetingId: 'om-1', transcripts: [], recordings: [] },
        },
      ]),
    );

    const { data } = await filteredListing(occurrences);

    const probed = probeMock.mock.calls[0][1];
    expect(probed).toHaveLength(1);
    expect(probed[0]).toMatchObject({
      eventId: 'r3',
      occurrences: 3,
      joinWebUrl: 'https://join/rec',
      start: `${graphTime(-1 * DAY)}Z`,
    });
    expect(data.meetings).toHaveLength(1);
    expect(data.meetings[0]).toMatchObject({
      eventId: 'r3',
      occurrences: 3,
      availability: 'available',
    });
  });

  it('probes the newest ENDED occurrence when the newest one is still running', async () => {
    // Every occurrence of the series shares one join URL, so the artifacts
    // of the ended ones are reachable through the group. Choosing the
    // representative before dropping in-progress occurrences lets the one
    // meeting that has not finished take the whole series down with it.
    probeMock.mockResolvedValue(
      probeResult([
        {
          eventId: 'r2',
          status: 'available',
          resources: { meetingId: 'om-3', transcripts: [], recordings: [] },
        },
      ]),
    );

    const { data } = await filteredListing([
      event('r1', 'Standup', graphTime(-3 * DAY), 'https://join/rec', {
        end: graphTime(-3 * DAY + 30 * MINUTE),
      }),
      event('r2', 'Standup', graphTime(-2 * DAY), 'https://join/rec', {
        end: graphTime(-2 * DAY + 30 * MINUTE),
      }),
      // Today's occurrence is mid-flight.
      event('r3', 'Standup', graphTime(-30 * MINUTE), 'https://join/rec', {
        end: graphTime(30 * MINUTE),
      }),
    ]);

    const probed = probeMock.mock.calls[0][1];
    expect(probed).toHaveLength(1);
    expect(probed[0]).toMatchObject({
      eventId: 'r2',
      joinWebUrl: 'https://join/rec',
      // The running occurrence is not part of the group it never joined.
      occurrences: 2,
      start: `${graphTime(-2 * DAY)}Z`,
    });
    expect(data.meetings).toHaveLength(1);
    expect(data.meetings[0]).toMatchObject({
      eventId: 'r2',
      availability: 'available',
    });
    // An occurrence survived, so nothing about this series was dropped.
    expect(data.hiddenCount).toBe(0);
  });

  it('counts a wholly in-progress series once, not once per occurrence', async () => {
    const { data } = await filteredListing([
      event('r1', 'Standup', graphTime(-30 * MINUTE), 'https://join/rec', {
        end: graphTime(30 * MINUTE),
      }),
      event('r2', 'Standup', graphTime(-20 * MINUTE), 'https://join/rec', {
        end: graphTime(40 * MINUTE),
      }),
      event('r3', 'Standup', graphTime(-10 * MINUTE), 'https://join/rec', {
        end: graphTime(50 * MINUTE),
      }),
    ]);

    expect(probeMock.mock.calls[0][1]).toEqual([]);
    expect(data.meetings).toEqual([]);
    // "Show all" reveals one row for this series, so it is counted once.
    expect(data.hiddenCount).toBe(1);
    expect(data.unprobedCount).toBe(0);
  });

  it('counts hidden groups per join URL across a mixed calendar', async () => {
    probeMock.mockResolvedValue(
      probeResult([
        {
          eventId: 'ok2',
          status: 'available',
          resources: { meetingId: 'om-4', transcripts: [], recordings: [] },
        },
      ]),
    );

    const { data } = await filteredListing([
      // Two cancelled occurrences of one series.
      event('x1', 'Scrapped', graphTime(-2 * DAY), 'https://join/dead', {
        end: graphTime(-2 * DAY + HOUR),
        isCancelled: true,
      }),
      event('x2', 'Scrapped', graphTime(-1 * DAY), 'https://join/dead', {
        end: graphTime(-1 * DAY + HOUR),
        isCancelled: true,
      }),
      // Three occurrences of a series that is entirely still running.
      event('n1', 'All-hands', graphTime(-30 * MINUTE), 'https://join/live', {
        end: graphTime(30 * MINUTE),
      }),
      event('n2', 'All-hands', graphTime(-20 * MINUTE), 'https://join/live', {
        end: graphTime(40 * MINUTE),
      }),
      event('n3', 'All-hands', graphTime(-10 * MINUTE), 'https://join/live', {
        end: graphTime(50 * MINUTE),
      }),
      // Two ended occurrences that do survive.
      event('ok1', 'Weekly', graphTime(-2 * DAY), 'https://join/ok', {
        end: graphTime(-2 * DAY + HOUR),
      }),
      event('ok2', 'Weekly', graphTime(-1 * DAY), 'https://join/ok', {
        end: graphTime(-1 * DAY + HOUR),
      }),
    ]);

    expect(
      probeMock.mock.calls[0][1].map((m: { eventId: string }) => m.eventId),
    ).toEqual(['ok2']);
    expect(data.meetings.map((m: { eventId: string }) => m.eventId)).toEqual([
      'ok2',
    ]);
    // Two join URLs vanished (one cancelled series, one running series);
    // five occurrences did. The toggle reveals rows, so it counts rows.
    expect(data.hiddenCount).toBe(2);
    expect(data.unprobedCount).toBe(0);
  });
});

describe('GET /api/m365/meetings?artifacts=required (probe outcomes)', () => {
  const ended = (id: string, subject: string, ago: number) =>
    event(id, subject, graphTime(-ago - HOUR), `https://join/${id}`, {
      end: graphTime(-ago),
    });

  it('drops "none", inlines "available", keeps "forbidden" and counts "unprobed"', async () => {
    const resources = {
      meetingId: 'om-2',
      organizer: 'Org Anizer',
      transcripts: [{ id: 't1', created: '2026-07-30T09:00:00Z' }],
      recordings: [],
    };
    probeMock.mockResolvedValue(
      probeResult([
        { eventId: 'gone', status: 'none' },
        { eventId: 'good', status: 'available', resources },
        { eventId: 'denied', status: 'forbidden' },
        { eventId: 'unknown', status: 'unprobed' },
      ]),
    );

    const { data } = await filteredListing([
      ended('gone', 'Nothing captured', 2 * HOUR),
      ended('good', 'Has transcript', 3 * HOUR),
      ended('denied', 'Not mine', 4 * HOUR),
      ended('unknown', 'Never asked', 5 * HOUR),
    ]);

    expect(
      data.meetings.map((m: { eventId: string; availability: string }) => [
        m.eventId,
        m.availability,
      ]),
    ).toEqual([
      ['good', 'available'],
      ['denied', 'forbidden'],
    ]);
    expect(data.meetings[0].resources).toEqual(resources);
    // 'forbidden' is unknown availability, not a resolved empty listing.
    expect(data.meetings[1].resources).toBeUndefined();
    // One probed empty + one never asked: both are rows "Show all" would
    // reveal, so hiddenCount counts them together while unprobedCount
    // isolates the one whose availability is merely unknown.
    expect(data.hiddenCount).toBe(2);
    expect(data.unprobedCount).toBe(1);
  });

  it('treats an empty probe inside the grace window as pending, outside it as hidden', async () => {
    probeMock.mockResolvedValue(
      probeResult([
        { eventId: 'fresh', status: 'none' },
        { eventId: 'stale', status: 'none' },
      ]),
    );

    const { data } = await filteredListing([
      ended('fresh', 'Just wrapped', 5 * MINUTE),
      ended('stale', 'Long over', 3 * HOUR),
    ]);

    expect(data.meetings).toHaveLength(1);
    expect(data.meetings[0]).toMatchObject({
      eventId: 'fresh',
      availability: 'pending',
    });
    expect(data.hiddenCount).toBe(1);
    expect(data.unprobedCount).toBe(0);
  });

  it('hides "unresolved" inside the grace window that "none" would badge pending', async () => {
    // Both ended five minutes ago, so only the status separates them: a
    // clean-but-empty probe may still be waiting on Teams, while a join
    // URL that resolves to no online meeting (attended, not organized)
    // has nothing to wait for and would 404 on expand.
    probeMock.mockResolvedValue(
      probeResult([
        { eventId: 'noresolve', status: 'unresolved' },
        { eventId: 'fresh', status: 'none' },
      ]),
    );

    const { data } = await filteredListing([
      ended('noresolve', 'Attended, not organized', 5 * MINUTE),
      ended('fresh', 'Just wrapped', 5 * MINUTE),
    ]);

    expect(
      data.meetings.map((m: { eventId: string; availability: string }) => [
        m.eventId,
        m.availability,
      ]),
    ).toEqual([['fresh', 'pending']]);
    expect(data.hiddenCount).toBe(1);
    // Unresolved is a definite answer, not an unknown one.
    expect(data.unprobedCount).toBe(0);
  });

  it('hides "unresolved" outside the grace window and counts it', async () => {
    probeMock.mockResolvedValue(
      probeResult([{ eventId: 'noresolve', status: 'unresolved' }]),
    );

    const { data } = await filteredListing([
      ended('noresolve', 'Attended, not organized', 3 * HOUR),
    ]);

    expect(data.meetings).toEqual([]);
    expect(data.hiddenCount).toBe(1);
    expect(data.unprobedCount).toBe(0);
  });

  it('passes budgetExhausted and throttled through to the payload', async () => {
    probeMock.mockResolvedValue(
      probeResult([{ eventId: 'unknown', status: 'unprobed' }], {
        budgetExhausted: true,
        throttled: true,
      }),
    );

    const { data } = await filteredListing([
      ended('unknown', 'Never asked', 2 * HOUR),
    ]);

    expect(data.budgetExhausted).toBe(true);
    expect(data.throttled).toBe(true);
    expect(data.unprobedCount).toBe(1);
  });

  it('omits the flags when the probe reports neither', async () => {
    const { data } = await filteredListing([]);
    expect(data).not.toHaveProperty('budgetExhausted');
    expect(data).not.toHaveProperty('throttled');
  });

  it('flags windowTruncated only when the raw calendar page came back full', async () => {
    const short = await filteredListing([
      ended('gone', 'Nothing captured', 2 * HOUR),
    ]);
    expect(short.data).not.toHaveProperty('windowTruncated');

    // A full page is truncation regardless of how many events survive the
    // online-meeting filter, so cheap non-online events prove the point.
    const full = await filteredListing(
      Array.from({ length: EVENT_WINDOW }, (_, i) =>
        event(`f${i}`, `Offline ${i}`, graphTime(-i * HOUR - DAY)),
      ),
    );
    expect(full.data.windowTruncated).toBe(true);
  });

  it('sorts rows newest first and caps them at MAX_MEETINGS', async () => {
    const total = MAX_MEETINGS + 10;
    const events = Array.from({ length: total }, (_, i) =>
      ended(`m${i}`, `Meeting ${i}`, (i + 1) * HOUR),
    );
    probeMock.mockResolvedValue(
      probeResult(
        events.map((e) => ({ eventId: e.id, status: 'available' as const })),
      ),
    );

    const { data } = await filteredListing(events);

    expect(data.meetings).toHaveLength(MAX_MEETINGS);
    expect(data.meetings[0].eventId).toBe('m0');
    expect(data.meetings[MAX_MEETINGS - 1].eventId).toBe(
      `m${MAX_MEETINGS - 1}`,
    );
    const starts = data.meetings.map((m: { start: string }) => m.start);
    expect([...starts].sort().reverse()).toEqual(starts);
  });

  it('surfaces a throwing probe as the standard error envelope, not a 200', async () => {
    probeMock.mockRejectedValue(
      new M365Error(
        'Tenant consent has not been granted for: OnlineMeetings.Read',
        'consent_missing',
        403,
      ),
    );

    const { response, body } = await filteredListing([
      ended('good', 'Has transcript', 2 * HOUR),
    ]);

    expect(response.status).toBe(403);
    expect(body.code).toBe('M365_CONSENT_MISSING');
    expect(body.success).toBeUndefined();
  });
});
