/**
 * Route tests for /api/m365/*. Auth and Graph token minting are mocked at
 * the @/auth boundary; Graph HTTP itself is stubbed via global fetch.
 */
import { NextRequest } from 'next/server';

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
    expect(body.data.features).toEqual({
      files: 'granted',
      sharepoint: 'granted',
      sharepointWrite: 'error',
      mail: 'consent_missing',
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

  it('lists root children folders-first', async () => {
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
    expect(body.data.entries.map((e: { name: string }) => e.name)).toEqual([
      'Alpha',
      'zeta.txt',
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
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/me/drive/root:/Apps/AI%20Assistant/');
    expect(url).toContain('my-report.md');
    expect(url).toContain('conflictBehavior=rename');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('PUT');
  });
});
