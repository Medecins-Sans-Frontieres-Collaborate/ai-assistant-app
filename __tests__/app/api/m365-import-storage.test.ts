/**
 * POST /api/m365/import/storage: request validation, error-code mapping
 * (the machine-readable code must ride `code`, not `details`), and the
 * quota rollback contract — a failed import must hand its reserved
 * daily-upload unit back.
 */
import { NextRequest } from 'next/server';

import { M365Error } from '@/lib/services/m365/graphApi';
import { M365ImportError } from '@/lib/services/m365/m365ImportService';

import { parseJsonResponse } from './helpers';

import { POST as importStoragePOST } from '@/app/api/m365/import/storage/route';
import { auth } from '@/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const guardLimitMock = vi.hoisted(() => vi.fn());
const importMock = vi.hoisted(() => vi.fn());
const rollbackMock = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  getGraphAccessToken: vi.fn(),
}));

vi.mock('@/lib/services/limits/routeGuard', () => ({
  guardLimit: guardLimitMock,
}));

vi.mock('@/lib/services/m365/m365ImportService', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/lib/services/m365/m365ImportService')
    >();
  return { ...actual, importDriveItemToStorage: importMock };
});

const mockSession = {
  user: { id: 'user-1', email: 'blaze@example.org' },
  expires: new Date(Date.now() + 86_400_000).toISOString(),
};

function request(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/m365/import/storage', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue(mockSession as never);
  guardLimitMock.mockResolvedValue({ allowed: true, rollback: rollbackMock });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/m365/import/storage', () => {
  it('returns 401 without a session', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const response = await importStoragePOST(
      request({ driveId: 'd1', itemId: 'i1' }),
    );
    expect(response.status).toBe(401);
  });

  it('rejects malformed ids without reserving quota', async () => {
    const response = await importStoragePOST(
      request({ driveId: 'a/b', itemId: 'i1' }),
    );
    expect(response.status).toBe(400);
    expect(guardLimitMock).not.toHaveBeenCalled();
  });

  it('returns the imported reference on success without rolling back', async () => {
    const imported = {
      uri: '/api/file/abc.mp3',
      name: 'clip.mp3',
      size: 42,
      mimeType: 'audio/mpeg',
      category: 'audio',
    };
    importMock.mockResolvedValue(imported);
    const response = await importStoragePOST(
      request({ driveId: 'd1', itemId: 'i1' }),
    );
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.data).toMatchObject(imported);
    expect(rollbackMock).not.toHaveBeenCalled();
  });

  it('carries import rejection codes in `code` and rolls the quota back', async () => {
    importMock.mockRejectedValue(
      new M365ImportError(
        'File exceeds the 25MB limit for audio files',
        'M365_FILE_TOO_LARGE',
      ),
    );
    const response = await importStoragePOST(
      request({ driveId: 'd1', itemId: 'i1' }),
    );
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(400);
    expect(body.code).toBe('M365_FILE_TOO_LARGE');
    expect(rollbackMock).toHaveBeenCalledTimes(1);
  });

  it('rolls the quota back on Graph faults too', async () => {
    importMock.mockRejectedValue(
      new M365Error('Graph request failed (503)', 'graph_error', 502),
    );
    const response = await importStoragePOST(
      request({ driveId: 'd1', itemId: 'i1' }),
    );
    expect(response.status).toBe(502);
    expect(rollbackMock).toHaveBeenCalledTimes(1);
  });

  it('returns the guard denial when the quota is exhausted', async () => {
    const denial = new Response(JSON.stringify({ error: 'quota' }), {
      status: 403,
    });
    guardLimitMock.mockResolvedValue({ allowed: false, response: denial });
    const response = await importStoragePOST(
      request({ driveId: 'd1', itemId: 'i1' }),
    );
    expect(response.status).toBe(403);
    expect(importMock).not.toHaveBeenCalled();
  });
});
