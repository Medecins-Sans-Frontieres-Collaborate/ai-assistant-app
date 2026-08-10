/**
 * Route tests for /api/m365/groups (Entra group search for the admin group
 * pickers). Auth and Graph token minting are mocked at the @/auth boundary;
 * Graph HTTP itself is stubbed via global fetch.
 */
import { NextRequest } from 'next/server';

import { parseJsonResponse } from './helpers';

import { GET as groupsGET } from '@/app/api/m365/groups/route';
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

function groupsRequest(query?: string): NextRequest {
  const qs = query === undefined ? '' : `?q=${encodeURIComponent(query)}`;
  return new NextRequest(`http://localhost/api/m365/groups${qs}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue(mockSession as never);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/m365/groups', () => {
  it('returns 401 without a session', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const response = await groupsGET(groupsRequest('marketing'));
    expect(response.status).toBe(401);
  });

  it('rejects missing and too-short queries (trimmed) without calling Graph', async () => {
    grantToken();
    for (const query of [undefined, '', 'a', '  a  ']) {
      const response = await groupsGET(groupsRequest(query));
      expect(response.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('doubles single quotes inside the $filter literal', async () => {
    grantToken();
    fetchMock.mockResolvedValue(graphJsonResponse({ value: [] }));
    const response = await groupsGET(groupsRequest("O'Brien"));
    expect(response.status).toBe(200);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/groups?$filter=');
    // A quote left unescaped would close the OData literal early.
    expect(url).toContain("startswith(displayName,'O''Brien')");
    expect(url).toContain('$select=id,displayName');
    expect(url).toContain('$top=20');
  });

  it('maps Graph results to {id, name}, dropping id-less rows', async () => {
    grantToken();
    fetchMock.mockResolvedValue(
      graphJsonResponse({
        value: [
          { id: 'g1', displayName: 'Marketing' },
          { displayName: 'no id — dropped' },
          { id: 'g2' },
        ],
      }),
    );
    const response = await groupsGET(groupsRequest('ma'));
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.data.groups).toEqual([
      { id: 'g1', name: 'Marketing' },
      // Name falls back to the id so the picker row is never blank.
      { id: 'g2', name: 'g2' },
    ]);
  });

  it('surfaces a consent gap with its code', async () => {
    vi.mocked(getGraphAccessToken).mockResolvedValue({
      accessToken: null,
      grantedScopes: [],
      error: 'AADSTS65001: consent required',
    });
    const response = await groupsGET(groupsRequest('marketing'));
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(403);
    expect(body.code).toBe('M365_CONSENT_MISSING');
  });
});
