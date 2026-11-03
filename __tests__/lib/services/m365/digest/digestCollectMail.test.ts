import { NextRequest } from 'next/server';

import {
  collectMail,
  createDigestRun,
} from '@/lib/services/m365/digest/digestSources';

import type { DigestWindow } from '@/types/m365Digest';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn(), getGraphAccessToken: vi.fn() }));
vi.mock('@/lib/services/m365/graphApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/m365/graphApi')>()),
  mintGraphToken: vi.fn().mockResolvedValue('token'),
}));

const window: DigestWindow = {
  startIso: '2026-10-23T00:00:00.000Z',
  endIso: '2026-10-30T09:00:00.000Z',
  preset: '7d',
};
const nowMs = Date.parse(window.endIso);
const me = {
  id: 'me-id',
  addresses: new Set(['me@example.org']),
  displayName: 'Me',
};

const person = (address: string, name = address.split('@')[0]) => ({
  emailAddress: { name, address },
});
const many = Array.from({ length: 19 }, (_, i) => person(`p${i}@example.org`));

const inbox = [
  // The inbox copy of something I sent myself.
  {
    id: 'self',
    conversationId: 'cself',
    subject: 'Notes',
    from: person('me@example.org', 'Me'),
    toRecipients: [person('me@example.org')],
    receivedDateTime: '2026-10-29T10:00:05Z',
  },
  // A direct ask, then a reply-all that only cc's me.
  {
    id: 'ask1',
    conversationId: 'cask',
    subject: 'Can you approve this?',
    from: person('ana@example.org', 'Ana'),
    toRecipients: [person('me@example.org')],
    receivedDateTime: '2026-10-28T10:00:00Z',
    bodyPreview: 'Can you approve this?',
  },
  {
    id: 'ask2',
    conversationId: 'cask',
    subject: 'RE: Can you approve this?',
    from: person('bo@example.org', 'Bo'),
    toRecipients: [person('ana@example.org')],
    ccRecipients: [person('me@example.org')],
    receivedDateTime: '2026-10-28T12:00:00Z',
  },
  // All-team note with twenty named recipients, me among them.
  {
    id: 'bc',
    conversationId: 'cbc',
    subject: 'Weekly team update',
    from: person('ceo@example.org', 'CEO'),
    toRecipients: [person('me@example.org'), ...many],
    receivedDateTime: '2026-10-27T09:00:00Z',
  },
  // A distribution-list copy nobody addressed to me.
  {
    id: 'dl',
    conversationId: 'cdl',
    subject: 'Parking changes',
    from: person('facilities-team@example.org', 'Facilities'),
    toRecipients: [person('everyone-list@example.org')],
    receivedDateTime: '2026-10-26T09:00:00Z',
  },
  // A colleague with a dotted address asking me directly.
  {
    id: 'hr',
    conversationId: 'chr',
    subject: 'Quick question?',
    from: person('hr.smith@example.org', 'H. Smith'),
    toRecipients: [person('me@example.org')],
    receivedDateTime: '2026-10-29T08:00:00Z',
  },
];

const sent = [
  {
    id: 'sent-self',
    conversationId: 'cself',
    subject: 'Notes',
    from: person('me@example.org', 'Me'),
    toRecipients: [person('me@example.org')],
    sentDateTime: '2026-10-29T10:00:00Z',
  },
  // My own announcement to twenty people: nobody owes me a reply.
  {
    id: 'sent-bc',
    conversationId: 'csentbc',
    subject: 'Team offsite details',
    from: person('me@example.org', 'Me'),
    toRecipients: many.concat(person('x@example.org')),
    sentDateTime: '2026-10-25T10:00:00Z',
  },
  // A question to one person, silent for five days.
  {
    id: 'sent-q',
    conversationId: 'csentq',
    subject: 'Numbers for Q4?',
    from: person('me@example.org', 'Me'),
    toRecipients: [person('carl@example.org', 'Carl')],
    sentDateTime: '2026-10-25T11:00:00Z',
  },
];

const urls: string[] = [];

beforeEach(() => {
  urls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      const value = url.includes('/sentitems/') ? sent : inbox;
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ value }),
      } as unknown as Response;
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('collectMail', () => {
  it('judges unanswered/addressed per thread, ignores self and broadcast sends, bounds the inbox query', async () => {
    // The run clock is wall time (deadline = now + budget); the window is fixed.
    const run = createDigestRun(new NextRequest('http://localhost/x'), [
      'Mail.Read',
    ]);
    const { items, report } = await collectMail(run, window, me, nowMs);
    const byId = new Map(items.map((item) => [item.id, item]));

    expect(report.status).toBe('ok');
    expect(urls.find((u) => u.includes('/inbox/'))).toContain(
      'receivedDateTime le 2026-10-30T09:00:00.000Z',
    );

    // Self-sent copy never becomes an item.
    expect(byId.has('mail:self')).toBe(false);
    // Thread-level addressing: the reply-all that only cc's me still carries Ana's direct ask.
    expect(byId.get('mail:ask2')?.signals).toMatchObject({
      unanswered: true,
      mentionsMe: true,
      broadcast: false,
    });
    // A broadcast with me among twenty recipients is not awaiting my reply.
    expect(byId.get('mail:bc')?.signals).toMatchObject({
      broadcast: true,
      unanswered: false,
    });
    // A DL copy nobody addressed to me is not unanswered either.
    expect(byId.get('mail:dl')?.signals).toMatchObject({
      unanswered: false,
      mentionsMe: false,
    });
    // Dotted personal address: a real direct ask.
    expect(byId.get('mail:hr')?.signals).toMatchObject({
      unanswered: true,
      mentionsMe: true,
      broadcast: false,
    });
    // Waiting on others: the one-to-one question yes, my own announcement no.
    expect(byId.get('mail:sent-q')?.signals.waitingOnOthers).toBe(true);
    expect(byId.has('mail:sent-bc')).toBe(false);
  });
});
