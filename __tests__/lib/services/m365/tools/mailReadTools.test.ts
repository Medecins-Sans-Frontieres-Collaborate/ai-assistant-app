/**
 * Tier-1 mail read tools through the executor seam: envelope-only search
 * rendering (ids included), the $search/$filter query-building choice, the
 * shared-mailbox gate (unconfigured rejected, configured targets
 * /users/{address}, 403 → Exchange-admin copy), attachment METADATA only
 * (never contentBytes), withheld/overridden rendering, and thread
 * windowing. Graph is mocked at the graphApi boundary; the phishing screen
 * is mocked at the module boundary (its own policy is unit-tested in
 * mailScreen.test.ts).
 */
import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import { M365Error } from '@/lib/services/m365/graphApi';
import { createM365ToolExecutor } from '@/lib/services/m365/tools/executor';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const graphJsonMock = vi.hoisted(() => vi.fn());
const graphFetchMock = vi.hoisted(() => vi.fn());
const mintGraphTokenMock = vi.hoisted(() => vi.fn());
const screenMock = vi.hoisted(() => vi.fn());

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

vi.mock('@/lib/services/m365/tools/mailScreen', () => ({
  screenMailMessage: screenMock,
  clearMailScreenCache: vi.fn(),
}));

const req = new NextRequest('http://localhost/api/chat');
const session = {
  user: { id: 'user-1', mail: 'me@contoso.com' },
} as unknown as Session;

const SHARED_MAILBOX = 'recruitment@contoso.com';

function executor(options: Parameters<typeof createM365ToolExecutor>[2] = {}) {
  return createM365ToolExecutor(req, session, {
    sharedMailboxes: [SHARED_MAILBOX],
    ...options,
  });
}

function calledPath(n = 0): string {
  return decodeURIComponent(graphJsonMock.mock.calls[n][2] as string);
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    subject: 'Kenya budget',
    from: { emailAddress: { name: 'Ana Silva', address: 'ana@contoso.com' } },
    toRecipients: [{ emailAddress: { address: 'me@contoso.com' } }],
    receivedDateTime: '2026-07-30T09:15:00Z',
    bodyPreview: 'Numbers attached for review',
    hasAttachments: true,
    parentFolderId: 'folder-1',
    ...overrides,
  };
}

function fullMessage(overrides: Record<string, unknown> = {}) {
  return {
    ...envelope(),
    ccRecipients: [],
    replyTo: [{ emailAddress: { address: 'ana@contoso.com' } }],
    body: { contentType: 'text', content: 'Here are the Q3 numbers.\nThanks.' },
    internetMessageHeaders: [
      { name: 'Authentication-Results', value: 'spf=pass' },
    ],
    webLink: 'https://outlook.office.com/mail/x',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  screenMock.mockResolvedValue({ verdict: 'clear' });
});

describe('mail_search', () => {
  it('renders envelope lines with ids from a free-text $search', async () => {
    graphJsonMock.mockResolvedValue({
      value: [
        envelope(),
        envelope({
          id: 'msg-2',
          conversationId: 'conv-2',
          subject: 'Lunch',
          hasAttachments: false,
          bodyPreview: 'p'.repeat(120),
        }),
      ],
    });
    const result = await executor().callTool('mail_search', {
      query: 'kenya budget',
    });
    expect(result.isError).toBe(false);
    expect(result.resultText).toContain('envelopes only');
    expect(result.resultText).toContain(
      'Ana Silva <ana@contoso.com>: "Kenya budget"',
    );
    expect(result.resultText).toContain('[attachments]');
    expect(result.resultText).toContain('(id: msg-1, conversation: conv-1)');
    expect(result.resultText).toContain('(id: msg-2, conversation: conv-2)');
    // Preview is truncated to ≤80 chars, never the full text.
    expect(result.resultText).not.toContain('p'.repeat(81));
    expect(result.resultText).toContain('…');
    // Never a body: envelope $select only.
    const path = calledPath();
    expect(path).toContain('/me/messages?$search="kenya budget"');
    expect(path).toContain('$top=10');
    expect(path).toContain('bodyPreview');
    expect(path).not.toContain('$filter');
    expect(path).not.toMatch(/\$select=[^&]*\bbody\b/);
  });

  it('uses $filter (no $search) when the query is facets only', async () => {
    graphJsonMock.mockResolvedValue({ value: [envelope()] });
    const result = await executor().callTool('mail_search', {
      query: 'from:ana@contoso.com hasAttachments:true received>=2026-07-01',
      maxResults: 100,
    });
    expect(result.isError).toBe(false);
    const path = calledPath();
    expect(path).not.toContain('$search');
    expect(path).toContain('receivedDateTime ge 2026-07-01T00:00:00Z');
    expect(path).toContain("from/emailAddress/address eq 'ana@contoso.com'");
    expect(path).toContain('hasAttachments eq true');
    expect(path).toContain('$orderby=receivedDateTime desc');
    expect(path).toContain('$top=25'); // maxResults clamped to 25
  });

  it('folds facets into the $search KQL string when free text is present', async () => {
    graphJsonMock.mockResolvedValue({ value: [] });
    await executor().callTool('mail_search', {
      query: 'from:ana@contoso.com received>=2026-07-01 kenya',
    });
    const path = calledPath();
    expect(path).toContain(
      '$search="from:ana@contoso.com received>=2026-07-01 kenya"',
    );
    expect(path).not.toContain('$filter');
  });

  it('falls back to $search for a display-name from: facet', async () => {
    graphJsonMock.mockResolvedValue({ value: [] });
    await executor().callTool('mail_search', { query: 'from:Ana' });
    expect(calledPath()).toContain('$search="from:Ana"');
  });

  it('rejects an unconfigured shared mailbox without touching Graph', async () => {
    const result = await executor().callTool('mail_search', {
      query: 'budget',
      mailbox: 'finance@contoso.com',
    });
    expect(result.isError).toBe(true);
    expect(result.resultText).toContain("isn't configured");
    expect(result.resultText).toContain('Settings → Connections');
    expect(graphJsonMock).not.toHaveBeenCalled();
  });

  it('targets /users/{address} for a configured mailbox, case-insensitively', async () => {
    graphJsonMock.mockResolvedValue({ value: [] });
    const result = await executor().callTool('mail_search', {
      query: 'intern',
      mailbox: 'Recruitment@Contoso.com',
    });
    expect(result.isError).toBe(false);
    expect(calledPath()).toContain(`/users/${SHARED_MAILBOX}/messages?`);
  });

  it('maps shared-mailbox 403 to the Exchange-admin copy', async () => {
    graphJsonMock.mockRejectedValue(
      new M365Error('Access is denied', 'forbidden', 403),
    );
    const result = await executor().callTool('mail_search', {
      query: 'intern',
      mailbox: SHARED_MAILBOX,
    });
    expect(result.isError).toBe(true);
    expect(result.resultText).toContain(
      `You don't appear to have access to ${SHARED_MAILBOX} — access is granted by your Exchange admin.`,
    );
  });
});

describe('mail_get_message', () => {
  it('renders headers, body, attachment METADATA and webLink when clear', async () => {
    graphJsonMock.mockResolvedValueOnce(fullMessage()).mockResolvedValueOnce({
      value: [
        { name: 'Q3-budget.xlsx', size: 2048, contentType: 'application/xlsx' },
      ],
    });
    const result = await executor().callTool('mail_get_message', {
      messageId: 'msg-1',
    });
    expect(result.isError).toBe(false);
    expect(result.resultText).toContain('From: Ana Silva <ana@contoso.com>');
    expect(result.resultText).toContain('Subject: Kenya budget');
    expect(result.resultText).toContain('Here are the Q3 numbers.');
    expect(result.resultText).toContain(
      'Q3-budget.xlsx (application/xlsx, 2 KB)',
    );
    expect(result.resultText).toContain(
      'Open in Outlook: https://outlook.office.com/mail/x',
    );

    // Full fetch asks for body/headers as text (route pattern).
    expect(calledPath(0)).toContain('/me/messages/msg-1?');
    expect(calledPath(0)).toContain('internetMessageHeaders');
    const init = graphJsonMock.mock.calls[0][3] as {
      headers: Record<string, string>;
    };
    expect(init.headers).toEqual({
      Prefer: 'outlook.body-content-type="text"',
    });

    // Attachment call is metadata-only — contentBytes is NEVER requested.
    expect(calledPath(1)).toBe(
      '/me/messages/msg-1/attachments?$select=name,size,contentType',
    );
    for (const call of graphJsonMock.mock.calls) {
      expect(String(call[2])).not.toContain('contentBytes');
    }
  });

  it('screens the raw body before rendering and threads override ids', async () => {
    graphJsonMock
      .mockResolvedValueOnce(fullMessage())
      .mockResolvedValueOnce({ value: [] });
    await executor({ screenOverrideIds: ['msg-1'] }).callTool(
      'mail_get_message',
      { messageId: 'msg-1' },
    );
    expect(screenMock).toHaveBeenCalledTimes(1);
    expect(screenMock).toHaveBeenCalledWith(
      req,
      session,
      expect.objectContaining({
        messageId: 'msg-1',
        from: 'ana@contoso.com',
        replyTo: 'ana@contoso.com',
        bodyText: 'Here are the Q3 numbers.\nThanks.',
        headers: [{ name: 'Authentication-Results', value: 'spf=pass' }],
      }),
      { overrideIds: new Set(['msg-1']) },
    );
  });

  it('caps the body with an explicit counted truncation marker', async () => {
    graphJsonMock.mockResolvedValueOnce(
      fullMessage({
        hasAttachments: false,
        body: { contentType: 'text', content: 'x'.repeat(9000) },
      }),
    );
    const result = await executor().callTool('mail_get_message', {
      messageId: 'msg-1',
    });
    expect(result.resultText).toContain('…[truncated — 1000 more characters]');
    expect(result.resultText).not.toContain('x'.repeat(8001));
  });

  it('converts an HTML body to text when Graph returns HTML anyway', async () => {
    graphJsonMock.mockResolvedValueOnce(
      fullMessage({
        hasAttachments: false,
        body: {
          contentType: 'html',
          content: '<p>Hello <b>there</b></p><p>Second &amp; final.</p>',
        },
      }),
    );
    const result = await executor().callTool('mail_get_message', {
      messageId: 'msg-1',
    });
    expect(result.resultText).toContain('Hello there');
    expect(result.resultText).toContain('Second & final.');
    expect(result.resultText).not.toContain('<p>');
  });

  it('withholds a flagged body: envelope + reasons, no body, no attachment fetch', async () => {
    screenMock.mockResolvedValue({
      verdict: 'suspicious',
      reasons: ['sender authentication failure (spf=fail)'],
      overridden: false,
    });
    graphJsonMock.mockResolvedValueOnce(fullMessage());
    const result = await executor().callTool('mail_get_message', {
      messageId: 'msg-1',
    });
    expect(result.isError).toBe(false);
    expect(result.resultText).toContain(
      'WITHHELD: flagged by the phishing screen',
    );
    expect(result.resultText).toContain('spf=fail');
    expect(result.resultText).toContain('show it anyway');
    expect(result.resultText).not.toContain('Here are the Q3 numbers.');
    // Withheld message: only the message fetch itself, no attachments call.
    expect(graphJsonMock).toHaveBeenCalledTimes(1);
  });

  it('labels an overridden body with the FLAGGED prefix and shows it', async () => {
    screenMock.mockResolvedValue({
      verdict: 'suspicious',
      reasons: ['sender authentication failure (spf=fail)'],
      overridden: true,
    });
    graphJsonMock
      .mockResolvedValueOnce(fullMessage())
      .mockResolvedValueOnce({ value: [] });
    const result = await executor().callTool('mail_get_message', {
      messageId: 'msg-1',
    });
    expect(
      result.resultText.startsWith('[FLAGGED — user chose to show it]'),
    ).toBe(true);
    expect(result.resultText).toContain('Here are the Q3 numbers.');
  });

  it('rejects malformed message ids before any Graph call', async () => {
    const result = await executor().callTool('mail_get_message', {
      messageId: 'bad id with spaces',
    });
    expect(result.isError).toBe(true);
    expect(result.resultText).toContain('not a valid message id');
    expect(graphJsonMock).not.toHaveBeenCalled();
  });
});

describe('mail_get_thread', () => {
  function threadFixture(count: number) {
    return Array.from({ length: count }, (_, i) =>
      envelope({
        id: `m${i + 1}`,
        conversationId: 'conv-9',
        subject: 'Thread subject',
        hasAttachments: false,
        receivedDateTime: `2026-07-${String(10 + i).padStart(2, '0')}T08:00:00Z`,
      }),
    );
  }

  function mockThread(count: number) {
    graphJsonMock.mockImplementation(async (_req, _scopes, path: string) => {
      if (path.includes('$filter=conversationId')) {
        // Graph returns unordered; the tool restores received order.
        return { value: [...threadFixture(count)].reverse() };
      }
      const id = /\/messages\/(m\d+)\?/.exec(path)?.[1];
      return fullMessage({
        id,
        conversationId: 'conv-9',
        hasAttachments: false,
        subject: 'Thread subject',
        body: { contentType: 'text', content: `Body of ${id}` },
      });
    });
  }

  it('windows the thread: newest N full bodies, older ones envelopes', async () => {
    mockThread(6);
    const result = await executor().callTool('mail_get_thread', {
      conversationId: 'conv-9',
    });
    expect(result.isError).toBe(false);
    expect(result.resultText).toContain(
      'Thread: 6 messages, showing full bodies for the latest 3',
    );
    expect(result.resultText).toContain('Older messages (3, envelopes only):');
    // Envelope-only for the older window…
    expect(result.resultText).toContain('(id: m1, conversation: conv-9)');
    expect(result.resultText).not.toContain('Body of m1');
    // …full bodies for the newest, in received order.
    expect(result.resultText).toContain('Body of m4');
    expect(result.resultText).toContain('Body of m6');
    expect(result.resultText.indexOf('Body of m4')).toBeLessThan(
      result.resultText.indexOf('Body of m6'),
    );

    // List call mirrors the third-pass route: escaped $filter, top 50, no
    // $orderby (received order restored in code).
    const listPath = calledPath();
    expect(listPath).toContain("$filter=conversationId eq 'conv-9'");
    expect(listPath).toContain('$top=50');
    expect(listPath).not.toContain('$orderby');
    // 1 list + 3 full fetches, nothing else (no attachment calls).
    expect(graphJsonMock).toHaveBeenCalledTimes(4);
    // Every full body was screened.
    expect(screenMock).toHaveBeenCalledTimes(3);
  });

  it('clamps fullBodies to 5', async () => {
    mockThread(6);
    const result = await executor().callTool('mail_get_thread', {
      conversationId: 'conv-9',
      fullBodies: 9,
    });
    expect(result.resultText).toContain('showing full bodies for the latest 5');
    expect(graphJsonMock).toHaveBeenCalledTimes(6);
  });

  it('renders flagged messages inside the window as withheld', async () => {
    mockThread(4);
    screenMock.mockImplementation(async (_req, _session, input) =>
      input.messageId === 'm4'
        ? {
            verdict: 'suspicious',
            reasons: ['link mismatch'],
            overridden: false,
          }
        : { verdict: 'clear' },
    );
    const result = await executor().callTool('mail_get_thread', {
      conversationId: 'conv-9',
    });
    expect(result.resultText).toContain('Body of m3');
    expect(result.resultText).not.toContain('Body of m4');
    expect(result.resultText).toContain(
      'WITHHELD: flagged by the phishing screen',
    );
    expect(result.resultText).toContain('link mismatch');
  });

  it('targets a configured shared mailbox for both list and body fetches', async () => {
    mockThread(2);
    await executor().callTool('mail_get_thread', {
      conversationId: 'conv-9',
      mailbox: SHARED_MAILBOX,
    });
    expect(calledPath(0)).toContain(`/users/${SHARED_MAILBOX}/messages?`);
    expect(calledPath(1)).toContain(`/users/${SHARED_MAILBOX}/messages/m1?`);
  });

  it('rejects malformed conversation ids before any Graph call', async () => {
    const result = await executor().callTool('mail_get_thread', {
      conversationId: "conv'; $top=999",
    });
    expect(result.isError).toBe(true);
    expect(graphJsonMock).not.toHaveBeenCalled();
  });
});
