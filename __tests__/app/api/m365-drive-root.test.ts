/**
 * Route tests for /api/m365/drive/root — resolves a drive's root folder to
 * a real item so the picker can add a whole library / team's Files as one
 * agent source. Graph HTTP is stubbed via global fetch; token minting via
 * the @/auth boundary.
 */
import { NextRequest } from 'next/server';

import { parseJsonResponse } from './helpers';

import { GET } from '@/app/api/m365/drive/root/route';
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

describe('GET /api/m365/drive/root', () => {
  it('returns the real root item id with its metadata', async () => {
    fetchMock.mockResolvedValue(
      graphJsonResponse({
        id: 'root-1',
        name: 'root',
        webUrl: 'https://contoso.sharepoint.com/sites/hr/Policies',
        folder: { childCount: 7 },
      }),
    );
    const response = await GET(
      new NextRequest('http://localhost/api/m365/drive/root?driveId=lib-1'),
    );
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      itemId: 'root-1',
      name: 'root',
      webUrl: 'https://contoso.sharepoint.com/sites/hr/Policies',
      childCount: 7,
    });
    expect(fetchMock.mock.calls[0][0] as string).toContain(
      '/drives/lib-1/root?',
    );
  });

  it('rejects a malformed driveId before calling Graph', async () => {
    const response = await GET(
      new NextRequest('http://localhost/api/m365/drive/root?driveId=bad/../id'),
    );
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a Graph 403 to the shared M365 error response', async () => {
    fetchMock.mockResolvedValue(
      graphJsonResponse({ error: { code: 'accessDenied' } }, 403),
    );
    const response = await GET(
      new NextRequest('http://localhost/api/m365/drive/root?driveId=lib-1'),
    );
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(403);
    expect(body.code).toBe('M365_FORBIDDEN');
  });

  it('requires a session', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const response = await GET(
      new NextRequest('http://localhost/api/m365/drive/root?driveId=lib-1'),
    );
    expect(response.status).toBe(401);
  });
});
