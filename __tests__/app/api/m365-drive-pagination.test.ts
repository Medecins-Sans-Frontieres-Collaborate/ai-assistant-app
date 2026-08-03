/**
 * Pagination, sort and search re-ranking tests for /api/m365/drive. Auth and
 * Graph token minting are mocked at the @/auth boundary; Graph HTTP itself is
 * stubbed via global fetch (same pattern as m365.test.ts).
 */
import { NextRequest } from 'next/server';

import { parseJsonResponse } from './helpers';

import { GET as driveGET } from '@/app/api/m365/drive/route';
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

function driveItem(id: string, name: string, folder = false) {
  return {
    id,
    name,
    parentReference: { driveId: 'd1' },
    ...(folder
      ? { folder: { childCount: 1 } }
      : { file: { mimeType: 'application/octet-stream' } }),
  };
}

function driveRequest(qs: string): NextRequest {
  return new NextRequest(`http://localhost/api/m365/drive?${qs}`);
}

function toToken(nextLink: string): string {
  return Buffer.from(nextLink, 'utf8').toString('base64url');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue(mockSession as never);
  vi.stubGlobal('fetch', fetchMock);
  grantToken();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/m365/drive sort', () => {
  it('rejects unknown sort and dir values', async () => {
    const badSort = await driveGET(driveRequest('view=children&sort=evil'));
    expect(badSort.status).toBe(400);
    const badDir = await driveGET(
      driveRequest('view=children&sort=name&dir=up'),
    );
    expect(badDir.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('defaults children to $orderby=name asc', async () => {
    fetchMock.mockResolvedValue(graphJsonResponse({ value: [] }));
    await driveGET(driveRequest('view=children'));
    expect(fetchMock.mock.calls[0][0]).toContain('$orderby=name%20asc');
  });

  it('maps sort fields with per-field default directions', async () => {
    fetchMock.mockResolvedValue(graphJsonResponse({ value: [] }));
    await driveGET(driveRequest('view=children&sort=lastModified'));
    expect(fetchMock.mock.calls[0][0]).toContain(
      '$orderby=lastModifiedDateTime%20desc',
    );
    await driveGET(driveRequest('view=children&sort=size'));
    expect(fetchMock.mock.calls[1][0]).toContain('$orderby=size%20desc');
    await driveGET(driveRequest('view=children&sort=size&dir=asc'));
    expect(fetchMock.mock.calls[2][0]).toContain('$orderby=size%20asc');
  });

  it('retries without $orderby when Graph rejects it and flags sortApplied', async () => {
    fetchMock
      .mockResolvedValueOnce(
        graphJsonResponse(
          { error: { message: 'The orderby field is not supported' } },
          400,
        ),
      )
      .mockResolvedValueOnce(
        graphJsonResponse({ value: [driveItem('f1', 'a.txt')] }),
      );
    const response = await driveGET(
      driveRequest('view=children&sort=size&dir=desc'),
    );
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).not.toContain('$orderby');
    expect(body.data.sortApplied).toBe(false);
    expect(body.data.entries).toHaveLength(1);
  });

  it('does not retry when the Graph error is unrelated to $orderby', async () => {
    fetchMock.mockResolvedValue(
      graphJsonResponse({ error: { message: 'boom' } }, 500),
    );
    const response = await driveGET(driveRequest('view=children&sort=size'));
    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/m365/drive pageToken', () => {
  const nextLink =
    'https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=abc';

  it('round-trips @odata.nextLink as an opaque token', async () => {
    fetchMock.mockResolvedValueOnce(
      graphJsonResponse({
        value: [driveItem('f1', 'a.txt')],
        '@odata.nextLink': nextLink,
      }),
    );
    const first = await driveGET(driveRequest('view=children'));
    const firstBody = await parseJsonResponse(first);
    expect(first.status).toBe(200);
    const token = firstBody.data.nextToken as string;
    expect(token).toBe(toToken(nextLink));

    fetchMock.mockResolvedValueOnce(
      graphJsonResponse({ value: [driveItem('f2', 'b.txt')] }),
    );
    const second = await driveGET(
      driveRequest(`view=children&pageToken=${token}`),
    );
    const secondBody = await parseJsonResponse(second);
    expect(second.status).toBe(200);
    // The decoded link is replayed verbatim.
    expect(fetchMock.mock.calls[1][0]).toBe(nextLink);
    expect(secondBody.data.nextToken).toBeUndefined();
    expect(secondBody.data.entries).toHaveLength(1);
  });

  it('rejects tokens outside https://graph.microsoft.com/v1.0/', async () => {
    const badLinks = [
      'http://graph.microsoft.com/v1.0/me/drive/root/children',
      'https://evil.com/v1.0/me/drive/root/children',
      'https://graph.microsoft.com.evil.com/v1.0/x',
      'https://graph.microsoft.com/beta/me/drive',
    ];
    for (const link of badLinks) {
      const response = await driveGET(
        driveRequest(`view=children&pageToken=${toToken(link)}`),
      );
      expect(response.status).toBe(400);
    }
    const garbage = await driveGET(
      driveRequest('view=children&pageToken=%21%21%21'),
    );
    expect(garbage.status).toBe(400);
    const oversize = await driveGET(
      driveRequest(`view=children&pageToken=${'A'.repeat(7000)}`),
    );
    expect(oversize.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops an outbound nextLink pointing away from Graph', async () => {
    fetchMock.mockResolvedValue(
      graphJsonResponse({
        value: [driveItem('f1', 'a.txt')],
        '@odata.nextLink': 'https://evil.com/v1.0/steal',
      }),
    );
    const response = await driveGET(driveRequest('view=recent'));
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.data.nextToken).toBeUndefined();
  });
});

describe('GET /api/m365/drive search re-ranking', () => {
  it('rejects queries shorter than 2 characters', async () => {
    const response = await driveGET(driveRequest('view=search&q=g'));
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('orders exact > stem > token-match > substring > content, stable within tiers', async () => {
    // Fresh Response per call: the route now issues a parallel
    // /search/query filename lookup alongside the content search.
    fetchMock.mockImplementation((url: string | URL) =>
      String(url).includes('/search/query')
        ? graphJsonResponse({ value: [] })
        : graphJsonResponse({
            value: [
              driveItem('c1', 'quarterly-report.docx'),
              driveItem('s1', 'my-geo-notes.txt'),
              driveItem('p1', 'geography.docx'),
              driveItem('c2', 'summary.pdf'),
              driveItem('e1', 'geo.pptx'),
              driveItem('x1', 'geo', true),
              driveItem('p2', 'geothermal', true),
            ],
          }),
    );
    const response = await driveGET(driveRequest('view=search&q=geo'));
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.data.entries.map((e: { name: string }) => e.name)).toEqual([
      // Exact > stem; then the token tier ("geo" matches a whole filename
      // token in my-geo-notes, and prefixes geography/geothermal) in stable
      // input order; content-only matches last.
      'geo',
      'geo.pptx',
      'my-geo-notes.txt',
      'geography.docx',
      'geothermal',
      'quarterly-report.docx',
      'summary.pdf',
    ]);
    // Sectioning metadata for the picker: name vs content match kinds.
    expect(body.data.entries.map((e: { match?: string }) => e.match)).toEqual([
      'name',
      'name',
      'name',
      'name',
      'name',
      'content',
      'content',
    ]);
  });

  it('widens the first page to a two-page window and keeps the last nextLink', async () => {
    const page1Link =
      'https://graph.microsoft.com/v1.0/me/drive/root/search?$skiptoken=p2';
    const page2Link =
      'https://graph.microsoft.com/v1.0/me/drive/root/search?$skiptoken=p3';
    let contentCall = 0;
    fetchMock.mockImplementation((url: string | URL) => {
      if (String(url).includes('/search/query')) {
        return graphJsonResponse({ value: [] });
      }
      contentCall += 1;
      return contentCall === 1
        ? graphJsonResponse({
            value: [driveItem('c1', 'notes.txt')],
            '@odata.nextLink': page1Link,
          })
        : graphJsonResponse({
            value: [driveItem('e1', 'geo.pptx')],
            '@odata.nextLink': page2Link,
          });
    });
    const response = await driveGET(driveRequest('view=search&q=geo'));
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    const contentUrls = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => !url.includes('/search/query'));
    expect(contentUrls).toHaveLength(2);
    expect(contentUrls[1]).toBe(page1Link);
    // Whole merged window is returned, re-ranked across both pages.
    expect(body.data.entries.map((e: { name: string }) => e.name)).toEqual([
      'geo.pptx',
      'notes.txt',
    ]);
    expect(body.data.nextToken).toBe(toToken(page2Link));
  });

  it('keeps raw Graph order on continuation pages (no per-page tiering)', async () => {
    const searchLink =
      'https://graph.microsoft.com/v1.0/me/drive/root/search?$skiptoken=p9';
    fetchMock.mockResolvedValue(
      graphJsonResponse({
        value: [driveItem('c1', 'zebra.txt'), driveItem('e1', 'geo.pptx')],
      }),
    );
    const response = await driveGET(
      driveRequest(`view=search&q=geo&pageToken=${toToken(searchLink)}`),
    );
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe(searchLink);
    expect(body.data.entries.map((e: { name: string }) => e.name)).toEqual([
      'zebra.txt',
      'geo.pptx',
    ]);
  });

  it('deduplicates nothing server-side but appends pages via distinct tokens', async () => {
    // Guard: a continuation page response still surfaces its own nextToken.
    const link1 =
      'https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=a';
    const link2 =
      'https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=b';
    fetchMock.mockResolvedValue(
      graphJsonResponse({
        value: [driveItem('f9', 'c.txt')],
        '@odata.nextLink': link2,
      }),
    );
    const response = await driveGET(
      driveRequest(`view=children&pageToken=${toToken(link1)}`),
    );
    const body = await parseJsonResponse(response);
    expect(body.data.nextToken).toBe(toToken(link2));
  });
});
