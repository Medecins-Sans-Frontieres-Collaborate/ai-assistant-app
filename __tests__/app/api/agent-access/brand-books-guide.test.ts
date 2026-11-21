import { NextRequest } from 'next/server';

import { BrandFileError } from '@/lib/services/brand/brandBooks';
import { storeBrandGuideUpload } from '@/lib/services/brand/brandGuideUpload';

import { parseJsonResponse } from '../helpers';

import { POST } from '@/app/api/agent-access/brand-books/guide/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The brand guide upload route: admins only, and a refused file is the
 * admin's to fix (400 with the reason), never a server error.
 */

const mockAuth = vi.hoisted(() => vi.fn());
const serviceIsEnabled = vi.hoisted(() => vi.fn());
const mockEnv = vi.hoisted(() => ({
  AGENT_ACCESS_CONTROL_ENABLED: true,
  AGENT_ACCESS_ADMINS: 'global@example.com',
}));

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/config/environment', () => ({ env: mockEnv }));
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: {
    getInstance: () => ({
      isEnabled: serviceIsEnabled,
      ensureFresh: vi.fn(),
      getSnapshot: () => ({
        config: {
          version: 1,
          localAdmins: [],
          updatedBy: 'global@example.com',
          updatedAt: '2026-07-23T00:00:00.000Z',
        },
      }),
    }),
  },
}));
vi.mock('@/lib/services/brand/brandGuideUpload', () => ({
  storeBrandGuideUpload: vi.fn(),
}));

const FILE = `/api/file/${'a'.repeat(64)}.pdf`;
const request = () =>
  new NextRequest(
    'https://app.example.com/api/agent-access/brand-books/guide',
    {
      method: 'POST',
      body: '%PDF-1.7',
    },
  );
const signedInAs = (mail: string) =>
  mockAuth.mockResolvedValue({ user: { id: 'u1', mail, email: mail } });

describe('POST /api/agent-access/brand-books/guide', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceIsEnabled.mockReturnValue(true);
    vi.mocked(storeBrandGuideUpload).mockResolvedValue({
      file: FILE,
      bytes: 8,
    });
  });

  it('keeps an admin’s guide and returns its reference', async () => {
    signedInAs('global@example.com');
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect((await parseJsonResponse(response)).data).toEqual({
      file: FILE,
      bytes: 8,
    });
  });

  it('refuses someone who is not an admin without reading the file', async () => {
    signedInAs('someone@example.com');
    expect((await POST(request())).status).toBe(403);
    expect(storeBrandGuideUpload).not.toHaveBeenCalled();
  });

  it('refuses a signed-out caller, and is absent when access control is off', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(401);
    serviceIsEnabled.mockReturnValue(false);
    expect((await POST(request())).status).toBe(404);
  });

  it('answers a refused file with 400 and the reason', async () => {
    signedInAs('global@example.com');
    vi.mocked(storeBrandGuideUpload).mockRejectedValue(
      new BrandFileError('A brand guide can be at most 250 MB.'),
    );
    const response = await POST(request());
    expect(response.status).toBe(400);
    expect((await parseJsonResponse(response)).error).toBe(
      'A brand guide can be at most 250 MB.',
    );
  });
});
