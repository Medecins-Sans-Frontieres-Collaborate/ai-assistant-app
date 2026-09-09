/**
 * Route tests for /api/m365/share. Auth and Graph token minting are mocked
 * at the @/auth boundary; Graph HTTP itself is stubbed via global fetch.
 */
import { NextRequest } from 'next/server';

import { parseJsonResponse } from './helpers';

import { POST as sharePOST } from '@/app/api/m365/share/route';
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

function shareRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/m365/share', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('/api/m365/share', () => {
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
    const response = await sharePOST(
      shareRequest({ driveId: 'd1', itemId: 'i1' }),
    );
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['missing driveId', { itemId: 'i1' }],
    ['bad driveId charset', { driveId: 'd/../1', itemId: 'i1' }],
    ['missing itemId', { driveId: 'd1' }],
    ['non-array emails', { driveId: 'd1', itemId: 'i1', emails: 'a@b.co' }],
    [
      'invalid email entry',
      { driveId: 'd1', itemId: 'i1', emails: ['not-an-email'] },
    ],
  ])('400s on %s', async (_label, body) => {
    const response = await sharePOST(shareRequest(body));
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates an organization view link by default', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ link: { webUrl: 'https://share.example/x' } }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const response = await sharePOST(
      shareRequest({ driveId: 'd1', itemId: 'i1' }),
    );
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.data).toEqual({
      link: 'https://share.example/x',
      scope: 'organization',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/drives/d1/items/i1/createLink');
    expect(JSON.parse(init.body)).toEqual({
      type: 'view',
      scope: 'organization',
    });
  });

  it('invites specific people read-only without notification mail', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ value: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await sharePOST(
      shareRequest({
        driveId: 'd1',
        itemId: 'i1',
        emails: ['ana@msf.org', 'bo@msf.org'],
      }),
    );
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.data).toEqual({ scope: 'people', granted: 2 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/drives/d1/items/i1/invite');
    expect(JSON.parse(init.body)).toEqual({
      recipients: [{ email: 'ana@msf.org' }, { email: 'bo@msf.org' }],
      requireSignIn: true,
      sendInvitation: false,
      roles: ['read'],
    });
  });

  it('maps Graph policy rejections to typed M365 errors', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: 'Sharing is blocked by policy' } }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const response = await sharePOST(
      shareRequest({ driveId: 'd1', itemId: 'i1' }),
    );
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(403);
    expect(data.code).toBe('M365_FORBIDDEN');
    expect(data.error).toContain('policy');
  });
});
