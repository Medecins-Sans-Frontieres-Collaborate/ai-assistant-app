/**
 * Route tests for /api/m365/*. Auth and Graph token minting are mocked at
 * the @/auth boundary; Graph HTTP itself is stubbed via global fetch.
 */
import { NextRequest } from 'next/server';

import {
  decodeGraphPageToken,
  encodeGraphNextLink,
} from '@/lib/services/m365/graphPageToken';

import { parseJsonResponse } from './helpers';

import { GET as driveGET } from '@/app/api/m365/drive/route';
import { GET as importGET } from '@/app/api/m365/import/route';
import { GET as mailGET } from '@/app/api/m365/mail/route';
import { POST as savePOST } from '@/app/api/m365/save/route';
import { GET as statusGET } from '@/app/api/m365/status/route';
import { auth, getGraphAccessToken } from '@/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  getGraphAccessToken: vi.fn(),
}));

const mockSession = {
  user: { id: 'user-1', email: 'blaze@example.org', name: 'Blaze' },
  expires: new Date(Date.now() + 86_400_000).toISOString(),
};

const fetchMock = vi.fn();

function grantToken() {
  vi.mocked(getGraphAccessToken).mockResolvedValue({
    accessToken: 'tok',
    grantedScopes: [],
  });
}

function graphJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue(mockSession as never);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/m365/status', () => {
  it('returns 401 without a session', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const response = await statusGET(
      new NextRequest('http://localhost/api/m365/status'),
    );
    expect(response.status).toBe(401);
  });

  it('maps token results to per-feature statuses', async () => {
    vi.mocked(getGraphAccessToken).mockImplementation(async (_req, scopes) => {
      if (scopes[0] === 'Mail.Read') {
        return { accessToken: null, grantedScopes: [], error: 'AADSTS65001' };
      }
      if (scopes[0] === 'Sites.ReadWrite.All') {
        return { accessToken: null, grantedScopes: [], error: 'boom' };
      }
      return { accessToken: 'tok', grantedScopes: scopes };
    });
    const response = await statusGET(
      new NextRequest('http://localhost/api/m365/status'),
    );
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.data.features).toMatchObject({
      files: 'granted',
      sharepoint: 'granted',
      sharepointWrite: 'error',
      mail: 'consent_missing',
      // Fourth/fifth-pass feature areas probe the same way.
      mailDrafts: 'granted',
      calendar: 'granted',
      people: 'granted',
      orgDirectory: 'granted',
      tasks: 'granted',
      meetings: 'granted',
      teamsChats: 'granted',
      teamsChannels: 'granted',
      groups: 'granted',
    });
  });
});

describe('GET /api/m365/drive', () => {
  it('rejects unknown views and malformed ids', async () => {
    grantToken();
    const bad = await driveGET(
      new NextRequest('http://localhost/api/m365/drive?view=nope'),
    );
    expect(bad.status).toBe(400);
    const badId = await driveGET(
      new NextRequest(
        'http://localhost/api/m365/drive?view=children&driveId=a/b',
      ),
    );
    expect(badId.status).toBe(400);
    const orphanItem = await driveGET(
      new NextRequest(
        'http://localhost/api/m365/drive?view=children&itemId=x1',
      ),
    );
    expect(orphanItem.status).toBe(400);
  });

  it('lists root children in strict Graph wire order', async () => {
    grantToken();
    fetchMock.mockResolvedValue(
      graphJsonResponse({
        value: [
          {
            id: 'f2',
            name: 'zeta.txt',
            parentReference: { driveId: 'd1' },
            file: { mimeType: 'text/plain' },
          },
          {
            id: 'f1',
            name: 'Alpha',
            parentReference: { driveId: 'd1' },
            folder: { childCount: 2 },
          },
        ],
      }),
    );
    const response = await driveGET(
      new NextRequest('http://localhost/api/m365/drive?view=children'),
    );
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    // No folders-first regrouping — server order must survive pagination.
    expect(body.data.entries.map((e: { name: string }) => e.name)).toEqual([
      'zeta.txt',
      'Alpha',
    ]);
    expect(fetchMock.mock.calls[0][0]).toContain('/me/drive/root/children');
  });

  it('surfaces a consent gap with its code', async () => {
    vi.mocked(getGraphAccessToken).mockResolvedValue({
      accessToken: null,
      grantedScopes: [],
      error: 'AADSTS65001: consent required',
    });
    const response = await driveGET(
      new NextRequest('http://localhost/api/m365/drive?view=recent'),
    );
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(403);
    expect(body.code).toBe('M365_CONSENT_MISSING');
  });
});

describe('GET /api/m365/import', () => {
  it('rejects folders', async () => {
    grantToken();
    fetchMock.mockResolvedValue(
      graphJsonResponse({ name: 'Folder', folder: {} }),
    );
    const response = await importGET(
      new NextRequest('http://localhost/api/m365/import?driveId=d1&itemId=i1'),
    );
    expect(response.status).toBe(400);
  });

  it('rejects files over the category limit', async () => {
    grantToken();
    fetchMock.mockResolvedValue(
      graphJsonResponse({
        name: 'huge.txt',
        size: 10 * 1024 * 1024 * 1024,
        file: { mimeType: 'text/plain' },
      }),
    );
    const response = await importGET(
      new NextRequest('http://localhost/api/m365/import?driveId=d1&itemId=i1'),
    );
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(400);
    expect(body.details).toBe('M365_FILE_TOO_LARGE');
  });

  it('streams content with name/webUrl headers', async () => {
    grantToken();
    fetchMock
      .mockResolvedValueOnce(
        graphJsonResponse({
          name: 'notes.txt',
          size: 5,
          webUrl: 'https://contoso-my.sharepoint.com/notes.txt',
          file: { mimeType: 'text/plain' },
          '@microsoft.graph.downloadUrl': 'https://download.example/notes',
        }),
      )
      .mockResolvedValueOnce(new Response('hello', { status: 200 }));
    const response = await importGET(
      new NextRequest('http://localhost/api/m365/import?driveId=d1&itemId=i1'),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/plain');
    expect(decodeURIComponent(response.headers.get('X-M365-Name') ?? '')).toBe(
      'notes.txt',
    );
    expect(await response.text()).toBe('hello');
  });
});

describe('GET /api/m365/mail', () => {
  it('lists inbox envelopes', async () => {
    grantToken();
    fetchMock.mockResolvedValue(
      graphJsonResponse({
        value: [
          {
            id: 'm1',
            conversationId: 'c1',
            subject: 'Hello',
            from: { emailAddress: { address: 'a@x.org' } },
            bodyPreview: 'hi',
            hasAttachments: false,
          },
        ],
      }),
    );
    const response = await mailGET(
      new NextRequest('http://localhost/api/m365/mail'),
    );
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.data.envelopes).toHaveLength(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/me/mailFolders/inbox');
  });

  it('renders a thread as ordered markdown', async () => {
    grantToken();
    fetchMock.mockResolvedValue(
      graphJsonResponse({
        value: [
          {
            id: 'm2',
            subject: 'RE: Topic',
            receivedDateTime: '2026-07-02T00:00:00Z',
            body: { content: 'Second' },
          },
          {
            id: 'm1',
            subject: 'Topic',
            receivedDateTime: '2026-07-01T00:00:00Z',
            body: { content: 'First' },
          },
        ],
      }),
    );
    const response = await mailGET(
      new NextRequest('http://localhost/api/m365/mail?conversationId=c1'),
    );
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.data.messageCount).toBe(2);
    expect(body.data.fileName).toBe('Topic.md');
    expect(body.data.markdown.indexOf('First')).toBeLessThan(
      body.data.markdown.indexOf('Second'),
    );
    // Bodies must be requested as plain text.
    expect(fetchMock.mock.calls[0][1]?.headers?.Prefer).toContain(
      'outlook.body-content-type="text"',
    );
  });

  it('rejects malformed message ids', async () => {
    grantToken();
    const response = await mailGET(
      new NextRequest('http://localhost/api/m365/mail?messageId=a/b'),
    );
    expect(response.status).toBe(400);
  });

  it('leads the browse $filter with the receivedDateTime guard clause', async () => {
    grantToken();
    fetchMock.mockResolvedValue(graphJsonResponse({ value: [] }));
    const response = await mailGET(
      new NextRequest(
        'http://localhost/api/m365/mail?filters=unread,hasAttachments',
      ),
    );
    expect(response.status).toBe(200);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/me/mailFolders/inbox/messages');
    expect(url).toContain('$orderby=receivedDateTime desc');
    expect(url).toContain(
      '$filter=receivedDateTime ge 1900-01-01T00:00:00Z' +
        ' and isRead eq false and hasAttachments eq true',
    );
  });

  it('omits $filter when no chips are selected', async () => {
    grantToken();
    fetchMock.mockResolvedValue(graphJsonResponse({ value: [] }));
    await mailGET(new NextRequest('http://localhost/api/m365/mail'));
    expect(fetchMock.mock.calls[0][0]).not.toContain('$filter');
  });

  it('rejects unknown filter values (flagged is deferred)', async () => {
    grantToken();
    for (const filters of ['flagged', 'unread,bogus']) {
      const response = await mailGET(
        new NextRequest(`http://localhost/api/m365/mail?filters=${filters}`),
      );
      expect(response.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores filters in search mode — no $filter/$orderby with $search', async () => {
    grantToken();
    fetchMock.mockResolvedValue(graphJsonResponse({ value: [] }));
    const response = await mailGET(
      new NextRequest('http://localhost/api/m365/mail?q=budget&filters=unread'),
    );
    expect(response.status).toBe(200);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('$search=');
    expect(url).not.toContain('$filter');
    expect(url).not.toContain('$orderby');
  });

  it('normalizes the extended envelope fields', async () => {
    grantToken();
    const recipients = Array.from({ length: 12 }, (_, i) => ({
      emailAddress: { name: `Person ${i}`, address: `p${i}@x.org` },
    }));
    fetchMock.mockResolvedValue(
      graphJsonResponse({
        value: [
          {
            id: 'm1',
            subject: 'Hello',
            from: { emailAddress: { name: 'Ana Diaz', address: 'ana@x.org' } },
            bodyPreview: 'hi',
            hasAttachments: true,
            isRead: false,
            flag: { flagStatus: 'flagged' },
            importance: 'high',
            toRecipients: recipients,
            ccRecipients: [{ emailAddress: { address: 'cc@x.org' } }],
          },
          {
            id: 'm2',
            subject: 'Bare',
            from: { emailAddress: { address: 'b@x.org' } },
            bodyPreview: '',
            hasAttachments: false,
          },
        ],
      }),
    );
    const response = await mailGET(
      new NextRequest('http://localhost/api/m365/mail'),
    );
    const body = await parseJsonResponse(response);
    const [rich, bare] = body.data.envelopes;
    expect(rich.fromName).toBe('Ana Diaz');
    expect(rich.fromAddress).toBe('ana@x.org');
    expect(rich.isRead).toBe(false);
    expect(rich.isFlagged).toBe(true);
    expect(rich.importance).toBe('high');
    expect(rich.to.endsWith(' …')).toBe(true);
    expect(rich.to).toContain('Person 9 <p9@x.org>');
    expect(rich.to).not.toContain('Person 10');
    expect(rich.cc).toBe('cc@x.org');
    // Missing optional fields stay absent, not defaulted.
    expect(bare).not.toHaveProperty('isRead');
    expect(bare).not.toHaveProperty('isFlagged');
    expect(bare).not.toHaveProperty('importance');
    expect(bare).not.toHaveProperty('to');
    expect(bare).not.toHaveProperty('cc');
  });

  it('returns nextToken exactly when Graph returns @odata.nextLink', async () => {
    grantToken();
    const nextLink =
      'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=25';
    fetchMock
      .mockResolvedValueOnce(
        graphJsonResponse({ value: [], '@odata.nextLink': nextLink }),
      )
      .mockResolvedValueOnce(graphJsonResponse({ value: [] }));
    const withNext = await parseJsonResponse(
      await mailGET(new NextRequest('http://localhost/api/m365/mail')),
    );
    expect(decodeGraphPageToken(withNext.data.nextToken)).toBe(nextLink);
    const withoutNext = await parseJsonResponse(
      await mailGET(new NextRequest('http://localhost/api/m365/mail')),
    );
    expect(withoutNext.data).not.toHaveProperty('nextToken');
  });

  it('replays a valid pageToken verbatim, ignoring q/filters', async () => {
    grantToken();
    const nextLink =
      'https://graph.microsoft.com/v1.0/me/messages?$search=%22x%22&$skiptoken=abc';
    const token = encodeGraphNextLink(nextLink);
    fetchMock.mockResolvedValue(graphJsonResponse({ value: [] }));
    const response = await mailGET(
      new NextRequest(
        `http://localhost/api/m365/mail?pageToken=${token}&q=ignored&filters=unread`,
      ),
    );
    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe(nextLink);
  });

  it('rejects page tokens that do not decode to a Graph /v1.0 URL', async () => {
    grantToken();
    const asToken = (url: string) =>
      Buffer.from(url, 'utf8').toString('base64url');
    const badTokens = [
      asToken('http://graph.microsoft.com/v1.0/me/messages'),
      asToken('https://evil.com/v1.0/me/messages'),
      asToken('https://graph.microsoft.com.evil.com/v1.0/me/messages'),
      asToken('https://graph.microsoft.com/beta/me/messages'),
      asToken(`https://graph.microsoft.com/v1.0/${'a'.repeat(8000)}`),
      'not$base64url!',
    ];
    for (const token of badTokens) {
      const response = await mailGET(
        new NextRequest(
          `http://localhost/api/m365/mail?pageToken=${encodeURIComponent(token)}`,
        ),
      );
      expect(response.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/m365/save', () => {
  function saveRequest(form: FormData): NextRequest {
    return new NextRequest('http://localhost/api/m365/save', {
      method: 'POST',
      body: form,
    });
  }

  it('returns 401 without a session', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const response = await savePOST(saveRequest(new FormData()));
    expect(response.status).toBe(401);
  });

  it('requires file and fileName', async () => {
    grantToken();
    const form = new FormData();
    form.append('fileName', 'report.md');
    const response = await savePOST(saveRequest(form));
    expect(response.status).toBe(400);
  });

  it('uploads small files via the content PUT and sanitizes the name', async () => {
    grantToken();
    fetchMock.mockResolvedValue(
      graphJsonResponse({
        id: 'new1',
        name: 'my-report.md',
        webUrl: 'https://contoso-my.sharepoint.com/my-report.md',
      }),
    );
    const form = new FormData();
    form.append('file', new Blob(['# hi'], { type: 'text/markdown' }));
    form.append('fileName', 'my/report.md');
    const response = await savePOST(saveRequest(form));
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.data.webUrl).toContain('my-report.md');
    // Default app-folder saves keep the folder label for the client.
    expect(body.data.folder).toBe('Apps/AI Assistant');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/me/drive/root:/Apps/AI%20Assistant/');
    expect(url).toContain('my-report.md');
    expect(url).toContain('conflictBehavior=rename');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('PUT');
  });

  function targetForm(fields: Record<string, string>): FormData {
    const form = new FormData();
    form.append('file', new Blob(['# hi'], { type: 'text/markdown' }));
    form.append('fileName', 'report.md');
    for (const [key, value] of Object.entries(fields)) {
      form.append(key, value);
    }
    return form;
  }

  it('targets a folder via id+path colon addressing and omits folder in the response', async () => {
    grantToken();
    fetchMock.mockResolvedValue(
      graphJsonResponse({ id: 'new1', name: 'report 1.md' }),
    );
    const response = await savePOST(
      saveRequest(targetForm({ driveId: 'd1', parentId: 'p1' })),
    );
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    // Server-returned name reflects a conflict-rename.
    expect(body.data.name).toBe('report 1.md');
    expect(body.data).not.toHaveProperty('folder');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/drives/d1/items/p1:/report.md:/content');
    expect(url).toContain('conflictBehavior=rename');
  });

  it('targets the drive root when only driveId is given', async () => {
    grantToken();
    fetchMock.mockResolvedValue(graphJsonResponse({ name: 'report.md' }));
    const response = await savePOST(saveRequest(targetForm({ driveId: 'd1' })));
    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0][0] as string).toContain(
      '/drives/d1/root:/report.md:/content',
    );
  });

  it('rejects parentId without driveId and malformed ids', async () => {
    grantToken();
    for (const fields of [
      { parentId: 'p1' },
      { driveId: 'a/b' },
      { driveId: 'd1', parentId: 'a b' },
    ]) {
      const response = await savePOST(saveRequest(targetForm(fields)));
      expect(response.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates the upload session on the targeted path for large files', async () => {
    grantToken();
    fetchMock
      .mockResolvedValueOnce(
        graphJsonResponse({ uploadUrl: 'https://upload.example/session' }),
      )
      .mockResolvedValue(graphJsonResponse({ name: 'big.md' }));
    const form = targetForm({ driveId: 'd1', parentId: 'p1' });
    form.set('file', new Blob([new Uint8Array(5 * 1024 * 1024)]));
    form.set('fileName', 'big.md');
    const response = await savePOST(saveRequest(form));
    expect(response.status).toBe(200);
    const sessionUrl = fetchMock.mock.calls[0][0] as string;
    expect(sessionUrl).toContain(
      '/drives/d1/items/p1:/big.md:/createUploadSession',
    );
    expect(fetchMock.mock.calls[0][1]?.body).toContain(
      '"@microsoft.graph.conflictBehavior":"rename"',
    );
  });

  it('maps a stale target to M365_NOT_FOUND / M365_FORBIDDEN', async () => {
    grantToken();
    fetchMock.mockResolvedValueOnce(graphJsonResponse({}, 404));
    const missing = await savePOST(
      saveRequest(targetForm({ driveId: 'd1', parentId: 'gone' })),
    );
    expect(missing.status).toBe(404);
    expect((await parseJsonResponse(missing)).code).toBe('M365_NOT_FOUND');

    fetchMock.mockResolvedValueOnce(graphJsonResponse({}, 403));
    const forbidden = await savePOST(
      saveRequest(targetForm({ driveId: 'd1', parentId: 'p1' })),
    );
    expect(forbidden.status).toBe(403);
    expect((await parseJsonResponse(forbidden)).code).toBe('M365_FORBIDDEN');
  });
});
