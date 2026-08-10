/**
 * Tier-2 mail draft tools, driven through the executor (real catalog
 * validation + failure mapping). Graph is mocked at the graphApi boundary,
 * the phishing screen at the mailScreen module boundary, and blob storage
 * at the factory — no network, no Azure.
 */
import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import { createM365ToolExecutor } from '@/lib/services/m365/tools/executor';
import { DRAFT_MARKER_PROPERTY_ID } from '@/lib/services/m365/tools/mailDraftTools';
import { clearScopeProbeCache } from '@/lib/services/m365/tools/scopeProbe';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const graphJsonMock = vi.hoisted(() => vi.fn());
const graphFetchMock = vi.hoisted(() => vi.fn());
const mintGraphTokenMock = vi.hoisted(() => vi.fn());
const screenMailMessageMock = vi.hoisted(() => vi.fn());
const getBlobSizeMock = vi.hoisted(() => vi.fn());
const blobGetMock = vi.hoisted(() => vi.fn());

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

// The screen is concurrently implemented (frozen interface) — always mocked.
vi.mock('@/lib/services/m365/tools/mailScreen', () => ({
  screenMailMessage: screenMailMessageMock,
  clearMailScreenCache: vi.fn(),
}));

vi.mock('@/lib/services/blobStorageFactory', () => ({
  createBlobStorageClient: () => ({
    getBlobSize: getBlobSizeMock,
    get: blobGetMock,
  }),
}));

// Only the enum is consumed; mocking avoids loading the Azure SDK graph.
vi.mock('@/lib/utils/server/blob/blob', () => ({
  BlobProperty: { URL: 'url', BLOB: 'blob' },
}));

const req = new NextRequest('http://localhost/api/chat');
const session = {
  user: { id: 'user-1', mail: 'me@contoso.com' },
} as unknown as Session;

function executor(options?: { screenOverrideIds?: string[] }) {
  return createM365ToolExecutor(req, session, options);
}

/** The Graph path of the nth graphJson call. */
function calledPath(n = 0): string {
  return graphJsonMock.mock.calls[n][2] as string;
}

/** The parsed JSON request body of the nth graphJson call. */
function calledBody(n = 0): Record<string, unknown> {
  const init = graphJsonMock.mock.calls[n][3] as { body?: string };
  return JSON.parse(init.body ?? '{}') as Record<string, unknown>;
}

const MARKER = [{ id: DRAFT_MARKER_PROPERTY_ID, value: '1' }];

beforeEach(() => {
  vi.clearAllMocks();
  clearScopeProbeCache();
  screenMailMessageMock.mockResolvedValue({ verdict: 'clear' });
});

describe('mail_create_draft', () => {
  it('stamps the app marker, shapes recipients, and renders NOT-sent copy with the webLink', async () => {
    graphJsonMock.mockResolvedValue({
      id: 'draft-1',
      subject: 'Budget update',
      webLink: 'https://outlook.office.com/mail/draft-1',
    });
    const result = await executor().callTool('mail_create_draft', {
      to: ['ana@contoso.com', 'bob@partner.org'],
      cc: ['carla@contoso.com'],
      subject: 'Budget update',
      body: 'Hi all,\n\nNumbers attached next week.',
    });

    expect(result.isError).toBe(false);
    expect(calledPath()).toBe('/me/messages');
    const body = calledBody();
    expect(body.singleValueExtendedProperties).toEqual(MARKER);
    expect(body.toRecipients).toEqual([
      { emailAddress: { address: 'ana@contoso.com' } },
      { emailAddress: { address: 'bob@partner.org' } },
    ]);
    expect(body.ccRecipients).toHaveLength(1);
    expect(body.body).toEqual({
      contentType: 'text',
      content: 'Hi all,\n\nNumbers attached next week.',
    });
    expect(result.resultText).toContain('Draft created (NOT sent)');
    expect(result.resultText).toContain('"Budget update"');
    expect(result.resultText).toContain('3 recipient(s)');
    expect(result.resultText).toContain(
      'Open in Outlook: https://outlook.office.com/mail/draft-1',
    );
  });

  it('detects simple HTML bodies', async () => {
    graphJsonMock.mockResolvedValue({ id: 'draft-2' });
    await executor().callTool('mail_create_draft', {
      to: ['ana@contoso.com'],
      subject: 'Hi',
      body: '<p>Hello</p><ul><li>One</li></ul>',
    });
    expect((calledBody().body as { contentType: string }).contentType).toBe(
      'html',
    );
  });

  it('rejects invalid recipients, empty to, >50 total, long subject and long body', async () => {
    const exec = executor();

    const badEmail = await exec.callTool('mail_create_draft', {
      to: ['not-an-email'],
      subject: 'x',
      body: 'y',
    });
    expect(badEmail.isError).toBe(true);
    expect(badEmail.resultText).toContain('invalid email');

    const emptyTo = await exec.callTool('mail_create_draft', {
      to: [],
      subject: 'x',
      body: 'y',
    });
    expect(emptyTo.isError).toBe(true);
    expect(emptyTo.resultText).toContain('at least one recipient');

    const many = Array.from({ length: 51 }, (_, i) => `u${i}@contoso.com`);
    const tooMany = await exec.callTool('mail_create_draft', {
      to: many,
      subject: 'x',
      body: 'y',
    });
    expect(tooMany.isError).toBe(true);
    expect(tooMany.resultText).toContain('Too many recipients');

    const longSubject = await exec.callTool('mail_create_draft', {
      to: ['a@contoso.com'],
      subject: 'S'.repeat(301),
      body: 'y',
    });
    expect(longSubject.isError).toBe(true);
    expect(longSubject.resultText).toContain('subject is too long');

    const longBody = await exec.callTool('mail_create_draft', {
      to: ['a@contoso.com'],
      subject: 'x',
      body: 'B'.repeat(50_001),
    });
    expect(longBody.isError).toBe(true);
    expect(longBody.resultText).toContain('body is too long');

    expect(graphJsonMock).not.toHaveBeenCalled();
  });
});

describe('mail_create_reply_draft', () => {
  const target = {
    subject: 'Re: invoice',
    from: { emailAddress: { address: 'sender@partner.org' } },
    body: { contentType: 'text', content: 'original body' },
    internetMessageHeaders: [{ name: 'Authentication-Results', value: 'ok' }],
  };
  const createdReply = {
    id: 'reply-1',
    body: { contentType: 'html', content: '<div>quoted history</div>' },
    toRecipients: [{ emailAddress: { address: 'sender@partner.org' } }],
    webLink: 'https://outlook.office.com/mail/reply-1',
  };

  it('refuses a flagged target and never builds the reply', async () => {
    graphJsonMock.mockResolvedValue(target);
    screenMailMessageMock.mockResolvedValue({
      verdict: 'suspicious',
      reasons: ['SPF fail', 'lookalike domain'],
      overridden: false,
    });

    const result = await executor().callTool('mail_create_reply_draft', {
      messageId: 'msg-1',
      body: 'Thanks!',
    });

    expect(result.isError).toBe(true);
    expect(result.resultText).toContain('flagged by the phishing screen');
    expect(result.resultText).toContain('SPF fail');
    // Only the screening fetch happened — no createReply, no PATCH.
    expect(graphJsonMock).toHaveBeenCalledTimes(1);
  });

  it('proceeds when the user explicitly overrode the flag', async () => {
    graphJsonMock
      .mockResolvedValueOnce(target)
      .mockResolvedValueOnce(createdReply)
      .mockResolvedValueOnce({ webLink: createdReply.webLink });
    screenMailMessageMock.mockResolvedValue({
      verdict: 'suspicious',
      reasons: ['SPF fail'],
      overridden: true,
    });

    const result = await executor({
      screenOverrideIds: ['msg-1'],
    }).callTool('mail_create_reply_draft', {
      messageId: 'msg-1',
      body: 'Thanks!',
    });

    expect(result.isError).toBe(false);
    // The override ids from the request payload reach the screen.
    expect(screenMailMessageMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        messageId: 'msg-1',
        bodyText: 'original body',
      }),
      { overrideIds: new Set(['msg-1']) },
    );
  });

  it('prepends the model body above the quoted history and stamps the marker via PATCH', async () => {
    graphJsonMock
      .mockResolvedValueOnce(target)
      .mockResolvedValueOnce(createdReply)
      .mockResolvedValueOnce({ webLink: createdReply.webLink });

    const result = await executor().callTool('mail_create_reply_draft', {
      messageId: 'msg-1',
      body: 'Thanks & <cheers>!',
    });

    expect(result.isError).toBe(false);
    expect(calledPath(1)).toBe('/me/messages/msg-1/createReply');
    expect(calledPath(2)).toBe('/me/messages/reply-1');
    const patch = calledBody(2);
    const patchedBody = patch.body as { contentType: string; content: string };
    // Plain-text model body is escaped into simple HTML ABOVE the quote.
    expect(patchedBody.contentType).toBe('html');
    expect(patchedBody.content).toBe(
      '<p>Thanks &amp; &lt;cheers&gt;!</p><div>quoted history</div>',
    );
    expect(patch.singleValueExtendedProperties).toEqual(MARKER);
    expect(result.resultText).toContain('reply-all: no');
    expect(result.resultText).toContain('1 recipient(s)');
    expect(result.resultText).toContain(createdReply.webLink);
  });

  it('routes replyAll to /createReplyAll and restates it', async () => {
    graphJsonMock
      .mockResolvedValueOnce(target)
      .mockResolvedValueOnce({
        ...createdReply,
        toRecipients: [
          { emailAddress: { address: 'sender@partner.org' } },
          { emailAddress: { address: 'other@contoso.com' } },
        ],
        ccRecipients: [{ emailAddress: { address: 'cc@contoso.com' } }],
      })
      .mockResolvedValueOnce({});

    const result = await executor().callTool('mail_create_reply_draft', {
      messageId: 'msg-1',
      body: 'All hands reply',
      replyAll: true,
    });

    expect(result.isError).toBe(false);
    expect(calledPath(1)).toBe('/me/messages/msg-1/createReplyAll');
    expect(result.resultText).toContain('reply-all: yes');
    expect(result.resultText).toContain('3 recipient(s)');
  });
});

describe('mail_update_draft', () => {
  it('rejects drafts without the app marker, and non-drafts', async () => {
    graphJsonMock.mockResolvedValueOnce({
      isDraft: true,
      subject: 'Hand-written',
      singleValueExtendedProperties: [],
    });
    const unmarked = await executor().callTool('mail_update_draft', {
      draftId: 'draft-x',
      subject: 'New subject',
    });
    expect(unmarked.isError).toBe(true);
    expect(unmarked.resultText).toContain(
      'Only drafts created by this assistant',
    );

    graphJsonMock.mockResolvedValueOnce({
      isDraft: false,
      singleValueExtendedProperties: [
        { id: DRAFT_MARKER_PROPERTY_ID, value: '1' },
      ],
    });
    const sent = await executor().callTool('mail_update_draft', {
      draftId: 'draft-x',
      subject: 'New subject',
    });
    expect(sent.isError).toBe(true);
    expect(sent.resultText).toContain('Only drafts created by this assistant');

    // Neither case reached PATCH.
    expect(graphJsonMock).toHaveBeenCalledTimes(2);
  });

  it('verifies via the marker $expand and replaces recipients wholesale', async () => {
    graphJsonMock
      .mockResolvedValueOnce({
        isDraft: true,
        subject: 'Old subject',
        singleValueExtendedProperties: [
          { id: DRAFT_MARKER_PROPERTY_ID, value: '1' },
        ],
      })
      .mockResolvedValueOnce({
        subject: 'New subject',
        webLink: 'https://outlook.office.com/mail/draft-1',
      });

    const result = await executor().callTool('mail_update_draft', {
      draftId: 'draft-1',
      to: ['new@contoso.com'],
      subject: 'New subject',
    });

    expect(result.isError).toBe(false);
    expect(calledPath(0)).toContain('/me/messages/draft-1');
    expect(calledPath(0)).toContain('$select=isDraft,subject,toRecipients');
    expect(calledPath(0)).toContain('singleValueExtendedProperties');
    const patch = calledBody(1);
    expect(patch.toRecipients).toEqual([
      { emailAddress: { address: 'new@contoso.com' } },
    ]);
    expect(patch.subject).toBe('New subject');
    expect(result.resultText).toContain('Draft updated (NOT sent)');
    expect(result.resultText).toContain('"New subject"');
  });

  it('rejects an update with nothing to change and invalid replacement recipients', async () => {
    const nothing = await executor().callTool('mail_update_draft', {
      draftId: 'draft-1',
    });
    expect(nothing.isError).toBe(true);
    expect(nothing.resultText).toContain('Nothing to update');

    const badTo = await executor().callTool('mail_update_draft', {
      draftId: 'draft-1',
      to: ['nope'],
    });
    expect(badTo.isError).toBe(true);
    expect(badTo.resultText).toContain('invalid email');
    expect(graphJsonMock).not.toHaveBeenCalled();
  });
});

describe('mail_add_draft_attachment', () => {
  const markedDraft = {
    isDraft: true,
    subject: 'Minutes',
    webLink: 'https://outlook.office.com/mail/draft-1',
    singleValueExtendedProperties: [
      { id: DRAFT_MARKER_PROPERTY_ID, value: '1' },
    ],
  };

  it('rejects a fileUri that is not an app file reference', async () => {
    const result = await executor().callTool('mail_add_draft_attachment', {
      draftId: 'draft-1',
      fileUri: 'https://evil.example/file.pdf',
      fileName: 'file.pdf',
    });
    expect(result.isError).toBe(true);
    expect(result.resultText).toContain('app file reference');

    const traversal = await executor().callTool('mail_add_draft_attachment', {
      draftId: 'draft-1',
      fileUri: '/api/file/../secrets.txt',
      fileName: 'secrets.txt',
    });
    expect(traversal.isError).toBe(true);
    expect(graphJsonMock).not.toHaveBeenCalled();
    expect(blobGetMock).not.toHaveBeenCalled();
  });

  it('rejects a draft without the app marker before touching storage', async () => {
    graphJsonMock.mockResolvedValueOnce({
      isDraft: true,
      singleValueExtendedProperties: [],
    });
    const result = await executor().callTool('mail_add_draft_attachment', {
      draftId: 'draft-1',
      fileUri: '/api/file/abc-123.pdf',
      fileName: 'report.pdf',
    });
    expect(result.isError).toBe(true);
    expect(result.resultText).toContain(
      'Only drafts created by this assistant',
    );
    expect(blobGetMock).not.toHaveBeenCalled();
  });

  it('attaches a small file inline as base64 from the user upload path', async () => {
    graphJsonMock
      .mockResolvedValueOnce(markedDraft)
      .mockResolvedValueOnce({ id: 'att-1' });
    getBlobSizeMock.mockResolvedValue(5);
    blobGetMock.mockResolvedValue(Buffer.from('hello'));

    const result = await executor().callTool('mail_add_draft_attachment', {
      draftId: 'draft-1',
      fileUri: '/api/file/abc-123.pdf',
      fileName: 'report.pdf',
    });

    expect(result.isError).toBe(false);
    // Bytes come from the user's OWN upload storage, not the HTTP route.
    expect(blobGetMock).toHaveBeenCalledWith(
      'user-1/uploads/files/abc-123.pdf',
      'blob',
    );
    expect(calledPath(1)).toBe('/me/messages/draft-1/attachments');
    expect(calledBody(1)).toEqual({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: 'report.pdf',
      contentBytes: Buffer.from('hello').toString('base64'),
    });
    expect(result.resultText).toContain('Attached "report.pdf"');
    expect(result.resultText).toContain('"Minutes"');
    expect(result.resultText).toContain('(NOT sent)');
  });

  it('refuses files above the 25MB cap without downloading them', async () => {
    graphJsonMock.mockResolvedValueOnce(markedDraft);
    getBlobSizeMock.mockResolvedValue(26 * 1024 * 1024);

    const result = await executor().callTool('mail_add_draft_attachment', {
      draftId: 'draft-1',
      fileUri: '/api/file/abc-123.zip',
      fileName: 'big.zip',
    });

    expect(result.isError).toBe(true);
    expect(result.resultText).toContain('too large');
    expect(blobGetMock).not.toHaveBeenCalled();
  });

  it('uses an upload session with Content-Range chunks above 3MB', async () => {
    const bytes = Buffer.alloc(4 * 1024 * 1024, 7);
    graphJsonMock
      .mockResolvedValueOnce(markedDraft)
      .mockResolvedValueOnce({ uploadUrl: 'https://upload.example/session' });
    getBlobSizeMock.mockResolvedValue(bytes.length);
    blobGetMock.mockResolvedValue(bytes);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));

    try {
      const result = await executor().callTool('mail_add_draft_attachment', {
        draftId: 'draft-1',
        fileUri: '/api/file/abc-123.bin',
        fileName: 'big.bin',
      });

      expect(result.isError).toBe(false);
      expect(calledPath(1)).toBe(
        '/me/messages/draft-1/attachments/createUploadSession',
      );
      // 4MB is below the 5MB (16×320KiB) fragment size → a single PUT.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://upload.example/session');
      expect((init.headers as Record<string, string>)['Content-Range']).toBe(
        `bytes 0-${bytes.length - 1}/${bytes.length}`,
      );
    } finally {
      fetchMock.mockRestore();
    }
  });
});
