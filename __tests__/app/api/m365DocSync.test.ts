/**
 * Route tests for the document-sync M365 surface: the drive-item metadata
 * read and the save route's overwrite mode. Graph mocking follows
 * __tests__/app/api/m365.test.ts — auth at the @/auth boundary, Graph HTTP
 * via a stubbed global fetch.
 */
import { NextRequest } from 'next/server';

import { parseJsonResponse } from './helpers';

import { GET as itemGET } from '@/app/api/m365/drive/item/route';
import { POST as savePOST } from '@/app/api/m365/save/route';
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

describe('GET /api/m365/drive/item', () => {
  function itemRequest(query: string): NextRequest {
    return new NextRequest(`http://localhost/api/m365/drive/item?${query}`);
  }

  it('returns 401 without a session', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const response = await itemGET(itemRequest('driveId=d1&itemId=i1'));
    expect(response.status).toBe(401);
  });

  it('rejects missing or malformed ids', async () => {
    grantToken();
    for (const query of ['driveId=d1', 'itemId=i1', 'driveId=a/b&itemId=i1']) {
      const response = await itemGET(itemRequest(query));
      expect(response.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects folders', async () => {
    grantToken();
    fetchMock.mockResolvedValue(
      graphJsonResponse({ name: 'Folder', folder: {} }),
    );
    const response = await itemGET(itemRequest('driveId=d1&itemId=i1'));
    expect(response.status).toBe(400);
  });

  it('returns metadata with the parent folder for keep-both copies', async () => {
    grantToken();
    fetchMock.mockResolvedValue(
      graphJsonResponse({
        name: 'report.md',
        size: 42,
        eTag: '"etag-1"',
        webUrl: 'https://contoso-my.sharepoint.com/report.md',
        file: { mimeType: 'text/markdown' },
        parentReference: { driveId: 'd1', id: 'folder-9' },
      }),
    );
    const response = await itemGET(itemRequest('driveId=d1&itemId=i1'));
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      name: 'report.md',
      eTag: '"etag-1"',
      webUrl: 'https://contoso-my.sharepoint.com/report.md',
      size: 42,
      parentFolder: { driveId: 'd1', itemId: 'folder-9' },
    });
    expect(fetchMock.mock.calls[0][0]).toContain('/drives/d1/items/i1');
  });

  it('surfaces a consent gap with its code', async () => {
    vi.mocked(getGraphAccessToken).mockResolvedValue({
      accessToken: null,
      grantedScopes: [],
      error: 'AADSTS65001: consent required',
    });
    const response = await itemGET(itemRequest('driveId=d1&itemId=i1'));
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(403);
    expect(body.code).toBe('M365_CONSENT_MISSING');
  });
});

describe('POST /api/m365/save — overwrite mode', () => {
  function saveRequest(form: FormData): NextRequest {
    return new NextRequest('http://localhost/api/m365/save', {
      method: 'POST',
      body: form,
    });
  }

  function overwriteForm(fields: Record<string, string>): FormData {
    const form = new FormData();
    form.append('file', new Blob(['# hi'], { type: 'text/markdown' }));
    form.append('fileName', 'report.md');
    for (const [key, value] of Object.entries(fields)) {
      form.append(key, value);
    }
    return form;
  }

  it('PUTs the existing item content with If-Match and no conflict rename', async () => {
    grantToken();
    fetchMock.mockResolvedValue(
      graphJsonResponse({
        id: 'i1',
        name: 'report.md',
        eTag: '"etag-2"',
        webUrl: 'https://contoso-my.sharepoint.com/report.md',
      }),
    );
    const response = await savePOST(
      saveRequest(
        overwriteForm({ driveId: 'd1', itemId: 'i1', ifMatch: '"etag-1"' }),
      ),
    );
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.data.name).toBe('report.md');
    expect(body.data.eTag).toBe('"etag-2"');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/drives/d1/items/i1/content');
    // An explicit overwrite: never the create-mode colon path or rename.
    expect(url).not.toContain(':/report.md:');
    expect(url).not.toContain('conflictBehavior');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>)['If-Match']).toBe(
      '"etag-1"',
    );
  });

  it('omits If-Match when none is given (keep-mine force push)', async () => {
    grantToken();
    fetchMock.mockResolvedValue(
      graphJsonResponse({ name: 'report.md', eTag: '"etag-3"' }),
    );
    const response = await savePOST(
      saveRequest(overwriteForm({ driveId: 'd1', itemId: 'i1' })),
    );
    expect(response.status).toBe(200);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(
      (init.headers as Record<string, string>)['If-Match'],
    ).toBeUndefined();
  });

  it('maps a Graph 412 to 409 M365_CONFLICT', async () => {
    grantToken();
    fetchMock.mockResolvedValue(graphJsonResponse({}, 412));
    const response = await savePOST(
      saveRequest(
        overwriteForm({ driveId: 'd1', itemId: 'i1', ifMatch: '"stale"' }),
      ),
    );
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(409);
    expect(body.code).toBe('M365_CONFLICT');
  });

  it('rejects itemId without driveId, itemId+parentId, and bad ifMatch', async () => {
    grantToken();
    for (const fields of [
      { itemId: 'i1' },
      { driveId: 'd1', itemId: 'i1', parentId: 'p1' },
      { driveId: 'd1', itemId: 'a/b' },
      { driveId: 'd1', itemId: 'i1', ifMatch: 'bad\netag' },
    ]) {
      const response = await savePOST(saveRequest(overwriteForm(fields)));
      expect(response.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects ifMatch without itemId', async () => {
    grantToken();
    const response = await savePOST(
      saveRequest(overwriteForm({ driveId: 'd1', ifMatch: '"e1"' })),
    );
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates the guarded upload session on the item path for large files', async () => {
    grantToken();
    fetchMock
      .mockResolvedValueOnce(
        graphJsonResponse({ uploadUrl: 'https://upload.example/session' }),
      )
      .mockResolvedValue(
        graphJsonResponse({ name: 'big.md', eTag: '"etag-4"' }),
      );
    const form = overwriteForm({
      driveId: 'd1',
      itemId: 'i1',
      ifMatch: '"etag-1"',
    });
    form.set('file', new Blob([new Uint8Array(5 * 1024 * 1024)]));
    form.set('fileName', 'big.md');
    const response = await savePOST(saveRequest(form));
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.data.eTag).toBe('"etag-4"');
    const sessionUrl = fetchMock.mock.calls[0][0] as string;
    expect(sessionUrl).toContain('/drives/d1/items/i1/createUploadSession');
    const sessionInit = fetchMock.mock.calls[0][1] as RequestInit;
    // If-Match travels on the createUploadSession request itself.
    expect((sessionInit.headers as Record<string, string>)['If-Match']).toBe(
      '"etag-1"',
    );
    expect(sessionInit.body).not.toContain('conflictBehavior');
  });

  it('maps a 412 from the guarded upload session to 409', async () => {
    grantToken();
    fetchMock.mockResolvedValueOnce(graphJsonResponse({}, 412));
    const form = overwriteForm({
      driveId: 'd1',
      itemId: 'i1',
      ifMatch: '"stale"',
    });
    form.set('file', new Blob([new Uint8Array(5 * 1024 * 1024)]));
    const response = await savePOST(saveRequest(form));
    expect(response.status).toBe(409);
    expect((await parseJsonResponse(response)).code).toBe('M365_CONFLICT');
  });

  it('leaves create mode intact and now returns eTag + binding ids', async () => {
    grantToken();
    fetchMock.mockResolvedValue(
      graphJsonResponse({
        id: 'new-1',
        name: 'report.md',
        eTag: '"etag-5"',
        webUrl: 'https://contoso-my.sharepoint.com/report.md',
        parentReference: { driveId: 'd1' },
      }),
    );
    const response = await savePOST(
      saveRequest(overwriteForm({ driveId: 'd1', parentId: 'p1' })),
    );
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.data.eTag).toBe('"etag-5"');
    expect(body.data.itemId).toBe('new-1');
    expect(body.data.driveId).toBe('d1');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/drives/d1/items/p1:/report.md:/content');
    expect(url).toContain('conflictBehavior=rename');
  });
});
