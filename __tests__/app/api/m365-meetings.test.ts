/**
 * Meetings listing (§4): calendarView supports neither $filter on
 * isOnlineMeeting nor reliable $orderby — the route must fetch the window
 * plain and filter/sort in code (a $filter regression fails live with
 * "The property 'isOnlineMeeting' does not support filtering").
 */
import { NextRequest } from 'next/server';

import { GET as meetingsGET } from '@/app/api/m365/meetings/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const graphJsonMock = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({
  auth: vi.fn(async () => ({ user: { id: 'user-1' } })),
  getGraphAccessToken: vi.fn(),
}));
vi.mock('@/lib/services/m365/graphApi', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/m365/graphApi')>();
  return { ...actual, graphJson: graphJsonMock, graphFetch: vi.fn() };
});

function event(
  id: string,
  subject: string,
  startIso: string,
  joinUrl?: string,
) {
  return {
    id,
    subject,
    start: { dateTime: startIso },
    isOnlineMeeting: !!joinUrl,
    ...(joinUrl && { onlineMeeting: { joinUrl } }),
    organizer: { emailAddress: { name: 'Org Anizer' } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
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
});
