/**
 * Route tests for /api/m365/people/search — recipient autocomplete. Ranked
 * /me/people results come first, the /users directory supplement fills the
 * remainder, duplicates collapse by email, and either Graph lookup failing
 * degrades to the other's results (never an error).
 */
import { NextRequest } from 'next/server';

import { parseJsonResponse } from './helpers';

import { GET as peopleGET } from '@/app/api/m365/people/search/route';
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

function request(q: string): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/m365/people/search?q=${encodeURIComponent(q)}`,
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('/api/m365/people/search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(getGraphAccessToken).mockResolvedValue({
      accessToken: 'tok',
      grantedScopes: [],
    } as never);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects unauthenticated callers', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const response = await peopleGET(request('ann'));
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects too-short queries without hitting Graph', async () => {
    const response = await peopleGET(request('a'));
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('merges ranked people with the directory supplement, deduped by email', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/me/people')) {
        return Promise.resolve(
          jsonResponse({
            value: [
              {
                displayName: 'Anna Alpha',
                scoredEmailAddresses: [{ address: 'Anna@x.org' }],
              },
            ],
          }),
        );
      }
      expect(url).toContain('/users');
      return Promise.resolve(
        jsonResponse({
          value: [
            // Duplicate of the ranked hit (case-insensitive) — dropped.
            { displayName: 'Anna Alpha', mail: 'anna@x.org' },
            { displayName: 'Annette Beta', mail: 'annette@x.org' },
            // No email — cannot be a recipient, dropped.
            { displayName: 'Ann NoMail' },
          ],
        }),
      );
    });

    const response = await peopleGET(request('ann'));
    const data = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(data.data.people).toEqual([
      { displayName: 'Anna Alpha', email: 'anna@x.org' },
      { displayName: 'Annette Beta', email: 'annette@x.org' },
    ]);
  });

  it('serves directory results when the ranked lookup fails', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/me/people')) {
        return Promise.resolve(new Response('nope', { status: 403 }));
      }
      return Promise.resolve(
        jsonResponse({
          value: [{ displayName: 'Annette Beta', mail: 'annette@x.org' }],
        }),
      );
    });

    const response = await peopleGET(request('ann'));
    const data = await parseJsonResponse(response);
    expect(data.data.people).toEqual([
      { displayName: 'Annette Beta', email: 'annette@x.org' },
    ]);
  });

  it('returns an empty list when both lookups fail', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 503 }));
    const response = await peopleGET(request('ann'));
    const data = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(data.data.people).toEqual([]);
  });
});
