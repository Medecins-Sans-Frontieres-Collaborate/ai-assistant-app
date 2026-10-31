import {
  BROADCAST_RECIPIENTS_MIN,
  analyzeChatMessages,
  calendarItemsFromEvents,
  latestPerConversation,
  mailItemFromEnvelope,
} from '@/lib/services/m365/digest/digestSources';
import type { MailEnvelopeLite } from '@/lib/services/m365/tools/mailOrchestration';

import type { DigestWindow } from '@/types/m365Digest';

import { describe, expect, it } from 'vitest';

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

const envelope = (over: Partial<MailEnvelopeLite>): MailEnvelopeLite => ({
  id: 'm1',
  conversationId: 'c1',
  subject: 'Hello',
  fromName: 'Ana',
  fromAddress: 'ana@example.org',
  toAddresses: ['me@example.org'],
  ccAddresses: [],
  receivedMs: Date.parse('2026-10-29T10:00:00.000Z'),
  receivedIso: '2026-10-29T10:00:00.000Z',
  preview: 'hi',
  importance: 'normal',
  hasAttachments: false,
  ...over,
});

describe('mail items', () => {
  it('keeps one envelope per conversation, the newest', () => {
    const latest = latestPerConversation([
      envelope({
        id: 'old',
        receivedMs: 1,
        receivedIso: '2026-10-24T00:00:00.000Z',
      }),
      envelope({
        id: 'new',
        receivedMs: 2,
        receivedIso: '2026-10-25T00:00:00.000Z',
      }),
      envelope({ id: 'other', conversationId: 'c2', receivedMs: 3 }),
    ]);
    expect(latest.map((e) => e.id)).toEqual(['other', 'new']);
  });

  it('marks wide distribution and list senders as broadcast, and direct mail as addressed to me', () => {
    const wide = mailItemFromEnvelope(
      envelope({
        toAddresses: Array.from(
          { length: BROADCAST_RECIPIENTS_MIN },
          (_, i) => `p${i}@x.org`,
        ),
      }),
      me,
      nowMs,
    );
    expect(wide.signals.broadcast).toBe(true);
    expect(wide.signals.mentionsMe).toBe(false);
    const list = mailItemFromEnvelope(
      envelope({ fromAddress: 'allstaff@example.org' }),
      me,
      nowMs,
    );
    expect(list.signals.broadcast).toBe(true);
    const direct = mailItemFromEnvelope(envelope({}), me, nowMs, {
      unanswered: true,
      reason: 'x',
    });
    expect(direct.signals).toMatchObject({
      broadcast: false,
      mentionsMe: true,
      unanswered: true,
    });
    expect(direct.webLink).toContain(
      'outlook.office.com/mail/deeplink/read/m1',
    );
    expect(direct.signals.ageHours).toBe(23);
  });
});

describe('analyzeChatMessages', () => {
  const msg = (
    id: string,
    from: string,
    at: string,
    mentions: string[] = [],
  ) => ({
    id,
    messageType: 'message',
    createdDateTime: at,
    from: { user: { id: from, displayName: from } },
    body: { content: `<p>${id}</p>`, contentType: 'html' },
    mentions: mentions.map((user) => ({ mentioned: { user: { id: user } } })),
  });

  it('a one-on-one message with no later reply from me is unanswered', () => {
    const result = analyzeChatMessages(
      [msg('a', 'ana', '2026-10-29T10:00:00Z')],
      me,
      window,
      true,
    );
    expect(result.candidate?.id).toBe('a');
    expect(result.unanswered).toBe(true);
  });

  it('my later reply clears it; group chats only count when I am mentioned', () => {
    const answered = analyzeChatMessages(
      [
        msg('a', 'ana', '2026-10-29T10:00:00Z'),
        msg('b', 'me-id', '2026-10-29T11:00:00Z'),
      ],
      me,
      window,
      true,
    );
    expect(answered.unanswered).toBe(false);
    const group = analyzeChatMessages(
      [msg('a', 'ana', '2026-10-29T10:00:00Z')],
      me,
      window,
      false,
    );
    expect(group.unanswered).toBe(false);
    const mentioned = analyzeChatMessages(
      [
        msg('a', 'ana', '2026-10-29T10:00:00Z', ['me-id']),
        msg('c', 'bo', '2026-10-29T12:00:00Z'),
      ],
      me,
      window,
      false,
    );
    // The @-mention wins over the newer chatter as the item.
    expect(mentioned.candidate?.id).toBe('a');
    expect(mentioned).toMatchObject({ mentioned: true, unanswered: true });
  });

  it('ignores messages outside the window and system events', () => {
    const result = analyzeChatMessages(
      [
        { ...msg('old', 'ana', '2026-10-01T10:00:00Z') },
        {
          ...msg('sys', 'ana', '2026-10-29T10:00:00Z'),
          messageType: 'systemEventMessage',
        },
      ],
      me,
      window,
      true,
    );
    expect(result.candidate).toBeNull();
  });
});

describe('calendar edge cases', () => {
  it('skips invitations to meetings that already ended and keeps one line per recurring series', () => {
    const items = calendarItemsFromEvents(
      [
        {
          id: 'past',
          subject: 'Yesterday',
          isOrganizer: false,
          responseStatus: { response: 'notResponded' },
          start: { dateTime: '2026-10-29T10:00:00.0000000' },
          end: { dateTime: '2026-10-29T11:00:00.0000000' },
        },
        {
          id: 'occ2',
          subject: 'Weekly sync',
          isOrganizer: false,
          seriesMasterId: 'S',
          type: 'occurrence',
          responseStatus: { response: 'notResponded' },
          createdDateTime: '2026-09-01T09:00:00Z',
          start: { dateTime: '2026-11-11T10:00:00.0000000' },
          end: { dateTime: '2026-11-11T11:00:00.0000000' },
        },
        {
          id: 'occ1',
          subject: 'Weekly sync',
          isOrganizer: false,
          seriesMasterId: 'S',
          type: 'occurrence',
          responseStatus: { response: 'notResponded' },
          createdDateTime: '2026-09-01T09:00:00Z',
          start: { dateTime: '2026-11-04T10:00:00.0000000' },
          end: { dateTime: '2026-11-04T11:00:00.0000000' },
        },
      ],
      window,
      nowMs,
    );
    expect(items.map((i) => i.id)).toEqual(['calendar:occ1']);
  });

  it('a dotted personal address is not a broadcast sender', () => {
    const personal = mailItemFromEnvelope(
      envelope({ fromAddress: 'hr.smith@example.org', fromName: 'H. Smith' }),
      me,
      nowMs,
    );
    expect(personal.signals.broadcast).toBe(false);
    const list = mailItemFromEnvelope(
      envelope({ fromAddress: 'hr@example.org' }),
      me,
      nowMs,
    );
    expect(list.signals.broadcast).toBe(true);
  });
});

describe('calendarItemsFromEvents', () => {
  it('surfaces unanswered invitations and my meetings nobody answered', () => {
    const items = calendarItemsFromEvents(
      [
        {
          id: 'inv',
          subject: 'Budget sync',
          isOrganizer: false,
          responseStatus: { response: 'notResponded' },
          createdDateTime: '2026-10-28T09:00:00Z',
          start: { dateTime: '2026-11-03T10:00:00.0000000' },
          organizer: {
            emailAddress: { name: 'Ana', address: 'ana@example.org' },
          },
        },
        {
          id: 'mine',
          subject: 'Retro',
          isOrganizer: true,
          createdDateTime: '2026-10-27T09:00:00Z',
          start: { dateTime: '2026-11-04T10:00:00.0000000' },
          attendees: [
            { type: 'required', status: { response: 'none' } },
            { type: 'required', status: { response: 'accepted' } },
          ],
        },
        {
          id: 'cancelled',
          isCancelled: true,
          isOrganizer: false,
          responseStatus: { response: 'notResponded' },
        },
        {
          id: 'accepted',
          isOrganizer: false,
          responseStatus: { response: 'accepted' },
        },
      ],
      window,
      nowMs,
    );
    expect(items.map((i) => i.id)).toEqual(['calendar:inv', 'calendar:mine']);
    expect(items[0].signals).toMatchObject({
      invitation: true,
      unanswered: true,
    });
    expect(items[1].signals.waitingOnOthers).toBe(true);
    expect(items[1].preview).toContain('1 invitee');
  });
});
