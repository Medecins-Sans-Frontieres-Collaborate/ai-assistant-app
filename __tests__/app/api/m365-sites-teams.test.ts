/**
 * Route tests for /api/m365/sites (browse/search/drives) and
 * /api/m365/teams (joined teams / team drive). Graph HTTP is stubbed via
 * global fetch; token minting via the @/auth boundary.
 */
import { NextRequest } from 'next/server';

import { decodeGraphPageToken } from '@/lib/services/m365/graphPageToken';

import { parseJsonResponse } from './helpers';

import { GET as sitesGET } from '@/app/api/m365/sites/route';
import { GET as teamsGET } from '@/app/api/m365/teams/route';
import { auth, getGraphAccessToken } from '@/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  getGraphAccessToken: vi.fn(),
}));

const mockSession = {
  user: { id: 'user-1', email: 'blaze@example.org' },
  expires: new Date(Date.now() + 86_400_000).toISOString(),
};

const fetchMock = vi.fn();

function graphJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function site(id: string, name: string) {
  return {
    id,
    displayName: name,
    webUrl: `https://contoso.sharepoint.com/sites/${name}`,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue(mockSession as never);
  vi.mocked(getGraphAccessToken).mockResolvedValue({
    accessToken: 'tok',
    grantedScopes: [],
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/m365/sites — browse listing', () => {
  it('returns followed sites first plus the deduped all-sites page with a nextToken', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/me/followedSites')) {
        return graphJsonResponse({ value: [site('s-fav', 'HR')] });
      }
      // all-sites listing (search=*)
      return graphJsonResponse({
        value: [site('s-fav', 'HR'), site('s-2', 'Logistics')],
        '@odata.nextLink':
          'https://graph.microsoft.com/v1.0/sites?search=*&$skiptoken=abc',
      });
    });

    const response = await sitesGET(
      new NextRequest('http://localhost/api/m365/sites'),
    );
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.data.followed).toEqual([
      expect.objectContaining({ siteId: 's-fav', name: 'HR' }),
    ]);
    // The followed site is deduped out of the all-sites list.
    expect(body.data.sites).toEqual([
      expect.objectContaining({ siteId: 's-2', name: 'Logistics' }),
    ]);
    expect(decodeGraphPageToken(body.data.nextToken)).toContain('$skiptoken');
    const urls = fetchMock.mock.calls.map(([u]) => u as string);
    expect(urls.some((u) => u.includes('/sites?search=*'))).toBe(true);
  });

  it('still browses when followedSites is unavailable (best-effort)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/me/followedSites')) {
        return graphJsonResponse({ error: { message: 'nope' } }, 403);
      }
      return graphJsonResponse({ value: [site('s-1', 'HR')] });
    });

    const response = await sitesGET(
      new NextRequest('http://localhost/api/m365/sites'),
    );
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.data.followed).toEqual([]);
    expect(body.data.sites).toHaveLength(1);
  });

  it('search returns matching sites without a followed section', async () => {
    fetchMock.mockResolvedValue(
      graphJsonResponse({ value: [site('s-1', 'HR')] }),
    );
    const response = await sitesGET(
      new NextRequest('http://localhost/api/m365/sites?q=hr'),
    );
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.data.sites).toHaveLength(1);
    expect(body.data.followed).toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toContain('/sites?search=hr');
  });

  it('follows drive paging to exhaustion for a site', async () => {
    fetchMock
      .mockResolvedValueOnce(
        graphJsonResponse({
          value: [{ id: 'd1', name: 'Documents' }],
          '@odata.nextLink':
            'https://graph.microsoft.com/v1.0/sites/x/drives?$skiptoken=n',
        }),
      )
      .mockResolvedValueOnce(
        graphJsonResponse({ value: [{ id: 'd2', name: 'Archive' }] }),
      );

    const response = await sitesGET(
      new NextRequest(
        'http://localhost/api/m365/sites?siteId=contoso.sharepoint.com,abc,def',
      ),
    );
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.data.drives).toEqual([
      { driveId: 'd1', name: 'Documents' },
      { driveId: 'd2', name: 'Archive' },
    ]);
  });

  it('rejects malformed siteId and page tokens', async () => {
    const badSite = await sitesGET(
      new NextRequest('http://localhost/api/m365/sites?siteId=a/b'),
    );
    expect(badSite.status).toBe(400);

    const badToken = await sitesGET(
      new NextRequest('http://localhost/api/m365/sites?pageToken=%%%'),
    );
    expect(badToken.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/m365/teams', () => {
  it('never sends $top to /me/joinedTeams and follows paging', async () => {
    fetchMock
      .mockResolvedValueOnce(
        graphJsonResponse({
          value: [{ id: 'g2', displayName: 'Zulu' }],
          '@odata.nextLink':
            'https://graph.microsoft.com/v1.0/me/joinedTeams?$skiptoken=n',
        }),
      )
      .mockResolvedValueOnce(
        graphJsonResponse({ value: [{ id: 'g1', displayName: 'Alpha' }] }),
      );

    const response = await teamsGET(
      new NextRequest('http://localhost/api/m365/teams'),
    );
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    // Sorted by name, both pages accumulated.
    expect(body.data.teams).toEqual([
      { groupId: 'g1', name: 'Alpha' },
      { groupId: 'g2', name: 'Zulu' },
    ]);
    const firstUrl = fetchMock.mock.calls[0][0] as string;
    expect(firstUrl).toContain('/me/joinedTeams');
    // The regression: joinedTeams rejects the Top query option.
    expect(firstUrl).not.toMatch(/\$top/i);
  });

  it('resolves a team drive by groupId', async () => {
    fetchMock.mockResolvedValue(
      graphJsonResponse({ id: 'd9', name: 'Documents' }),
    );
    const response = await teamsGET(
      new NextRequest('http://localhost/api/m365/teams?groupId=g1'),
    );
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.data.drive).toEqual({ driveId: 'd9', name: 'Documents' });
  });
});
