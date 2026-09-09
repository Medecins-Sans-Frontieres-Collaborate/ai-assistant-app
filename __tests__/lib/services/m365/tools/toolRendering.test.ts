/**
 * One happy-path render per tool: fixture Graph JSON in, compact
 * model-friendly text out — plus the endpoint-shape constraints that Graph
 * enforces in production (no $filter/$orderby on calendarView, the To Do
 * $filter fallback, HTML stripping on Teams message bodies).
 */
import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import { M365Error } from '@/lib/services/m365/graphApi';
import { createM365ToolExecutor } from '@/lib/services/m365/tools/executor';
import { clearScopeProbeCache } from '@/lib/services/m365/tools/scopeProbe';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const graphJsonMock = vi.hoisted(() => vi.fn());
const graphFetchMock = vi.hoisted(() => vi.fn());
const mintGraphTokenMock = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({ getGraphAccessToken: vi.fn() }));

vi.mock('@/lib/services/m365/graphApi', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/m365/graphApi')>();
  return {
    ...actual,
    graphJson: graphJsonMock,
    graphFetch: graphFetchMock,
    mintGraphToken: mintGraphTokenMock,
  };
});

const req = new NextRequest('http://localhost/api/chat');
const session = {
  user: { id: 'user-1', mail: 'me@contoso.com' },
} as unknown as Session;

const TEAM_ID = '0fe95443-8b26-4a29-bd0c-cb373b76dcbf';
const CHANNEL_ID = '19:abc123def@thread.tacv2';

function executor() {
  return createM365ToolExecutor(req, session);
}

/** The Graph path of the nth graphJson call. */
function calledPath(n = 0): string {
  return graphJsonMock.mock.calls[n][2] as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearScopeProbeCache();
});

describe('calendar_list_events', () => {
  it('renders sorted event lines and uses no $filter/$orderby', async () => {
    graphJsonMock.mockResolvedValue({
      value: [
        {
          subject: 'Late standup',
          start: { dateTime: '2026-08-03T15:00:00.0000000' },
          end: { dateTime: '2026-08-03T15:30:00.0000000' },
          organizer: { emailAddress: { name: 'Ana Silva' } },
        },
        {
          subject: 'Planning',
          start: { dateTime: '2026-08-03T09:00:00.0000000' },
          end: { dateTime: '2026-08-03T10:00:00.0000000' },
          location: { displayName: 'Room 4' },
          isOnlineMeeting: true,
        },
      ],
    });
    const result = await executor().callTool('calendar_list_events', {
      startDate: '2026-08-03',
      endDate: '2026-08-03',
    });
    expect(result.isError).toBe(false);
    expect(result.resultText).toContain('Planning');
    expect(result.resultText).toContain('2026-08-03 09:00–10:00 UTC');
    expect(result.resultText).toContain('Room 4');
    expect(result.resultText).toContain('organizer: Ana Silva');
    // Sorted by start despite the fixture order.
    expect(result.resultText.indexOf('Planning')).toBeLessThan(
      result.resultText.indexOf('Late standup'),
    );
    const path = calledPath();
    expect(path).toContain('/me/calendarView?startDateTime=');
    expect(path).not.toContain('$filter');
    expect(path).not.toContain('$orderby');
  });
});

describe('calendar_get_schedule', () => {
  it('includes the user and renders availability runs', async () => {
    graphJsonMock.mockResolvedValue({
      value: [
        { scheduleId: 'me@contoso.com', availabilityView: '0022' },
        { scheduleId: 'ana@contoso.com', availabilityView: '2200' },
      ],
    });
    const result = await executor().callTool('calendar_get_schedule', {
      attendees: ['ana@contoso.com'],
      startDateTime: '2026-08-03T09:00:00',
      endDateTime: '2026-08-03T11:00:00',
    });
    expect(result.isError).toBe(false);
    expect(result.resultText).toContain(
      'me@contoso.com: Free 2026-08-03 09:00–10:00, Busy 2026-08-03 10:00–11:00',
    );
    expect(result.resultText).toContain('ana@contoso.com: Busy');
    const body = JSON.parse(
      (graphJsonMock.mock.calls[0][3] as { body: string }).body,
    );
    expect(body.schedules).toEqual(['me@contoso.com', 'ana@contoso.com']);
    expect(body.availabilityViewInterval).toBe(30);
    expect(calledPath()).toBe('/me/calendar/getSchedule');
  });
});

describe('calendar_create_event', () => {
  it('creates a Teams meeting and renders subject, time, webLink', async () => {
    graphJsonMock.mockResolvedValue({
      subject: 'Follow-up',
      start: { dateTime: '2026-08-04T14:00:00.0000000' },
      end: { dateTime: '2026-08-04T14:30:00.0000000' },
      webLink: 'https://outlook.office.com/calendar/item/xyz',
    });
    const result = await executor().callTool('calendar_create_event', {
      subject: 'Follow-up',
      startDateTime: '2026-08-04T14:00:00',
      endDateTime: '2026-08-04T14:30:00',
      attendees: ['ana@contoso.com'],
      isOnlineMeeting: true,
    });
    expect(result.isError).toBe(false);
    expect(result.resultText).toContain('Created "Follow-up"');
    expect(result.resultText).toContain('2026-08-04 14:00–14:30 UTC');
    expect(result.resultText).toContain(
      'https://outlook.office.com/calendar/item/xyz',
    );
    expect(calledPath()).toBe('/me/events');
    const body = JSON.parse(
      (graphJsonMock.mock.calls[0][3] as { body: string }).body,
    );
    expect(body.onlineMeetingProvider).toBe('teamsForBusiness');
    expect(body.attendees).toEqual([
      { emailAddress: { address: 'ana@contoso.com' }, type: 'required' },
    ]);
  });
});

describe('person_resolve', () => {
  it('ranks people, folds contacts, dedupes by email, escapes quotes', async () => {
    graphJsonMock.mockImplementation(async (_r, _s, path: string) => {
      if (path.startsWith('/me/people')) {
        return {
          value: [
            {
              displayName: "Chris O'Brien",
              scoredEmailAddresses: [{ address: 'chris.obrien@contoso.com' }],
              jobTitle: 'Engineer',
              department: 'R&D',
            },
          ],
        };
      }
      return {
        value: [
          // Duplicate of the people hit — must be deduped.
          {
            displayName: "Chris O'Brien",
            emailAddresses: [{ address: 'chris.obrien@contoso.com' }],
          },
          {
            displayName: "Chris O'Toole",
            emailAddresses: [{ address: 'chris.otoole@example.org' }],
          },
        ],
      };
    });
    const result = await executor().callTool('person_resolve', {
      query: "Chris O'",
    });
    expect(result.isError).toBe(false);
    expect(result.resultText).toContain(
      "1. Chris O'Brien — Engineer, R&D — chris.obrien@contoso.com",
    );
    expect(result.resultText).toContain('chris.otoole@example.org');
    expect(result.resultText.match(/chris\.obrien@contoso\.com/g)).toHaveLength(
      1,
    );
    // OData literal: single quote doubled inside the startswith filter.
    expect(decodeURIComponent(calledPath(1))).toContain(
      "startswith(displayName,'Chris O''')",
    );
  });
});

describe('person_lookup', () => {
  it('renders profile, tolerates a missing manager, lists reports', async () => {
    graphJsonMock.mockImplementation(async (_r, _s, path: string) => {
      if (path.includes('/manager')) {
        throw new M365Error('no manager', 'not_found', 404);
      }
      if (path.includes('/directReports')) {
        return {
          value: [
            {
              displayName: 'Devi Nair',
              mail: 'devi@contoso.com',
              jobTitle: 'Analyst',
            },
          ],
        };
      }
      return {
        id: 'id-1',
        displayName: 'Sofia Marino',
        jobTitle: 'Director',
        department: 'Operations',
        mail: 'sofia@contoso.com',
        officeLocation: 'HQ 3.14',
      };
    });
    const result = await executor().callTool('person_lookup', {
      userIdOrEmail: 'sofia@contoso.com',
    });
    expect(result.isError).toBe(false);
    expect(result.resultText).toContain(
      'Sofia Marino — Director — sofia@contoso.com',
    );
    expect(result.resultText).toContain('Department: Operations');
    expect(result.resultText).toContain('Manager: none listed');
    expect(result.resultText).toContain('- Devi Nair — Analyst');
    expect(calledPath()).toContain('/users/sofia%40contoso.com?');
  });
});

describe('tasks_list', () => {
  it('falls back to code filtering when the server rejects $filter', async () => {
    graphJsonMock.mockImplementation(async (_r, _s, path: string) => {
      if (!path.includes('/tasks')) {
        return { value: [{ id: 'l1', displayName: 'Work' }] };
      }
      if (path.includes('%24filter') || path.includes('$filter')) {
        throw new M365Error('Invalid filter clause', 'graph_error', 502);
      }
      return {
        value: [
          { title: 'Ship executor', status: 'notStarted' },
          { title: 'Old thing', status: 'completed' },
        ],
      };
    });
    const result = await executor().callTool('tasks_list', {
      listName: 'work',
    });
    expect(result.isError).toBe(false);
    expect(result.resultText).toContain('Work — 1 open task(s)');
    expect(result.resultText).toContain('- Ship executor');
    expect(result.resultText).not.toContain('Old thing');
  });
});

describe('tasks_create', () => {
  it('ensures the default list and creates tasks sequentially', async () => {
    const taskPosts: string[] = [];
    graphJsonMock.mockImplementation(
      async (_r, _s, path: string, init?: RequestInit) => {
        if (path.includes('/tasks')) {
          taskPosts.push(JSON.parse(init?.body as string).title);
          return { id: `t${taskPosts.length}` };
        }
        if (path.includes('$filter') || path.includes('%24filter')) {
          return { value: [] };
        }
        // POST /me/todo/lists — create the missing list.
        return { id: 'list-1', displayName: 'AI Assistant' };
      },
    );
    const result = await executor().callTool('tasks_create', {
      tasks: ['Send minutes', 'Book room'],
    });
    expect(result.isError).toBe(false);
    expect(result.resultText).toBe('Created 2 task(s) in "AI Assistant".');
    expect(taskPosts).toEqual(['Send minutes', 'Book room']);
    expect(
      graphJsonMock.mock.calls.some(([, , path]) => path === '/me/todo/lists'),
    ).toBe(true);
  });
});

describe('chats_search', () => {
  it('strips HTML, renders sender/date, and reports showing N of M', async () => {
    graphJsonMock.mockResolvedValue({
      value: [
        {
          hitsContainers: [
            {
              total: 12,
              hits: [
                {
                  resource: {
                    createdDateTime: '2026-07-30T14:22:00Z',
                    from: { user: { displayName: 'Ana Silva' } },
                    body: {
                      content: '<p>Check <b>this</b>&nbsp;link &amp; doc</p>',
                    },
                    chatId: '19:chat',
                  },
                },
                {
                  resource: {
                    createdDateTime: '2026-07-29T09:10:00Z',
                    from: { emailAddress: { name: 'Jon Doe' } },
                    body: { content: 'plain text' },
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    const result = await executor().callTool('chats_search', {
      query: 'link',
    });
    expect(result.isError).toBe(false);
    expect(result.resultText).toContain('showing 2 of 12');
    expect(result.resultText).toContain('Ana Silva');
    expect(result.resultText).toContain('Check this link & doc');
    expect(result.resultText).not.toContain('<b>');
    expect(result.resultText).toContain('Jon Doe');
    expect(calledPath()).toBe('/search/query');
    const body = JSON.parse(
      (graphJsonMock.mock.calls[0][3] as { body: string }).body,
    );
    expect(body.requests[0].entityTypes).toEqual(['chatMessage']);
  });
});

describe('teams_list', () => {
  it('renders sorted team names with ids', async () => {
    graphJsonMock.mockResolvedValue({
      value: [
        { id: 't2', displayName: 'Logistics' },
        { id: 't1', displayName: 'Emergency Response' },
      ],
    });
    const result = await executor().callTool('teams_list', {});
    expect(result.isError).toBe(false);
    expect(result.resultText).toContain('- Emergency Response (id: t1)');
    expect(result.resultText).toContain('- Logistics (id: t2)');
    expect(result.resultText.indexOf('Emergency')).toBeLessThan(
      result.resultText.indexOf('Logistics'),
    );
    // NO $top: /me/joinedTeams rejects the Top query option on many tenants.
    expect(calledPath()).toBe(
      '/me/joinedTeams?$select=id,displayName,description',
    );
  });
});

describe('channels_list', () => {
  it('renders channels with ids for the follow-up tool', async () => {
    graphJsonMock.mockResolvedValue({
      value: [{ id: CHANNEL_ID, displayName: 'General' }],
    });
    const result = await executor().callTool('channels_list', {
      teamId: TEAM_ID,
    });
    expect(result.isError).toBe(false);
    expect(result.resultText).toContain(`- General (id: ${CHANNEL_ID})`);
    expect(calledPath()).toBe(
      `/teams/${TEAM_ID}/channels?$select=id,displayName,description`,
    );
  });
});

describe('channel_messages', () => {
  it('filters by sinceDate, skips system/empty messages, strips HTML, renders chronologically', async () => {
    // Graph returns newest-first.
    graphJsonMock.mockResolvedValue({
      value: [
        {
          messageType: 'message',
          createdDateTime: '2026-07-30T10:00:00Z',
          from: { user: { displayName: 'Ana Silva' } },
          body: { content: '<div>Second: shipped &amp; done</div>' },
        },
        {
          messageType: 'systemEventMessage',
          createdDateTime: '2026-07-30T09:30:00Z',
          body: { content: 'Ana added Jon to the channel' },
        },
        {
          messageType: 'message',
          createdDateTime: '2026-07-30T09:00:00Z',
          from: { user: { displayName: 'Jon Doe' } },
          body: { content: '<p>First message</p>' },
        },
        {
          messageType: 'message',
          createdDateTime: '2026-07-01T08:00:00Z',
          from: { user: { displayName: 'Old Poster' } },
          body: { content: 'too old' },
        },
      ],
    });
    const result = await executor().callTool('channel_messages', {
      teamId: TEAM_ID,
      channelId: CHANNEL_ID,
      sinceDate: '2026-07-28',
    });
    expect(result.isError).toBe(false);
    expect(result.resultText).toContain('Jon Doe: First message');
    expect(result.resultText).toContain('Ana Silva: Second: shipped & done');
    expect(result.resultText).not.toContain('too old');
    expect(result.resultText).not.toContain('added Jon');
    expect(result.resultText).not.toContain('<div>');
    // Chronological for digest reading despite newest-first input.
    expect(result.resultText.indexOf('First message')).toBeLessThan(
      result.resultText.indexOf('Second: shipped'),
    );
    expect(calledPath()).toBe(
      `/teams/${TEAM_ID}/channels/${encodeURIComponent(CHANNEL_ID)}/messages?$top=50`,
    );
  });
});
