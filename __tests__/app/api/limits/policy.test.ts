import { NextRequest } from 'next/server';

import {
  createLimitsBlobStorage,
  readPolicy,
  writeHistoryEntry,
  writePolicy,
} from '@/lib/services/limits/limitsStore';

import { parseJsonResponse } from '../helpers';

import { GET, PUT } from '@/app/api/limits/policy/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const serviceIsEnabled = vi.hoisted(() => vi.fn());
const serviceInvalidate = vi.hoisted(() => vi.fn());
const mockEnv = vi.hoisted(() => ({
  LIMITS_ENABLED: true,
  AGENT_ACCESS_ADMINS: 'global@example.com',
}));

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/config/environment', () => ({ env: mockEnv }));
vi.mock('@/lib/services/limits/LimitsService', () => ({
  LimitsService: {
    getInstance: () => ({
      isEnabled: serviceIsEnabled,
      invalidate: serviceInvalidate,
    }),
  },
}));

// Keep the conflict error class REAL so the instanceof → 409 mapping is
// genuinely exercised; mock only the blob accessors.
vi.mock('@/lib/services/limits/limitsStore', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/limits/limitsStore')>();
  return {
    ...actual,
    createLimitsBlobStorage: vi.fn(),
    readPolicy: vi.fn(),
    writePolicy: vi.fn(),
    writeHistoryEntry: vi.fn(),
  };
});

const globalAdminSession = {
  user: { id: 'oid-1', displayName: 'Global', mail: 'global@example.com' },
};
const normalSession = {
  user: { id: 'oid-2', displayName: 'User', mail: 'user@example.com' },
};

function putRequest(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/limits/policy', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const validBody = {
  defaults: [{ limitKey: 'chat.messagesPerDay', value: 100 }],
  overrides: [],
  mode: 'observe',
  failMode: 'open',
  timezone: 'UTC',
  countByomUsage: false,
  countAuxiliaryUsage: false,
};

describe('/api/limits/policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.LIMITS_ENABLED = true;
    mockEnv.AGENT_ACCESS_ADMINS = 'global@example.com';
    serviceIsEnabled.mockReturnValue(true);
    mockAuth.mockResolvedValue(globalAdminSession);
    vi.mocked(createLimitsBlobStorage).mockReturnValue({} as never);
    vi.mocked(writePolicy).mockResolvedValue('"etag-new"');
    vi.mocked(writeHistoryEntry).mockResolvedValue(undefined);
  });

  describe('feature gate', () => {
    it('404s BEFORE auth when disabled, like a route that does not exist', async () => {
      serviceIsEnabled.mockReturnValue(false);
      const response = await GET();
      expect(response.status).toBe(404);
      expect(mockAuth).not.toHaveBeenCalled();
    });

    it('404s on PUT when disabled', async () => {
      serviceIsEnabled.mockReturnValue(false);
      const response = await PUT(putRequest(validBody));
      expect(response.status).toBe(404);
      expect(mockAuth).not.toHaveBeenCalled();
    });
  });

  describe('authorization', () => {
    it('401s without a session', async () => {
      mockAuth.mockResolvedValue(null);
      expect((await GET()).status).toBe(401);
    });

    it('403s for a non-global admin', async () => {
      mockAuth.mockResolvedValue(normalSession);
      expect((await GET()).status).toBe(403);
      expect((await PUT(putRequest(validBody))).status).toBe(403);
    });
  });

  describe('GET', () => {
    it('returns the stored policy and its ETag', async () => {
      vi.mocked(readPolicy).mockResolvedValue({
        policy: {
          ...validBody,
          version: 1,
          updatedBy: 'a',
          updatedAt: 'b',
        } as never,
        etag: '"etag-1"',
      });
      const body = await parseJsonResponse(await GET());
      expect(body.data.etag).toBe('"etag-1"');
      expect(body.data.policyUnavailable).toBe(false);
    });

    it('returns null policy when none has been authored', async () => {
      vi.mocked(readPolicy).mockResolvedValue(null);
      const body = await parseJsonResponse(await GET());
      expect(body.data.policy).toBeNull();
      expect(body.data.policyUnavailable).toBe(false);
    });

    it('reports policyUnavailable on a read failure — NEVER an empty policy', async () => {
      vi.mocked(readPolicy).mockRejectedValue(new Error('storage down'));
      const response = await GET();
      const body = await parseJsonResponse(response);
      // 200 with an explicit unavailable flag: rendering an outage as
      // "nothing configured" would tell an admin everything is unlimited.
      expect(response.status).toBe(200);
      expect(body.data.policyUnavailable).toBe(true);
      expect(body.data.policy).toBeNull();
    });
  });

  describe('PUT validation', () => {
    it('rejects an unknown limit key', async () => {
      const response = await PUT(
        putRequest({
          ...validBody,
          defaults: [{ limitKey: 'chat.notARealLimit', value: 5 }],
        }),
      );
      expect(response.status).toBe(400);
      expect(writePolicy).not.toHaveBeenCalled();
    });

    it('rejects an entry carrying BOTH modelId and series', async () => {
      const response = await PUT(
        putRequest({
          ...validBody,
          defaults: [
            {
              limitKey: 'model.requests',
              modelId: 'gpt-5.2',
              series: 'gpt',
              value: 5,
            },
          ],
        }),
      );
      expect(response.status).toBe(400);
    });

    it('rejects a model qualifier on a non-per-model limit', async () => {
      const response = await PUT(
        putRequest({
          ...validBody,
          defaults: [
            { limitKey: 'chat.messagesPerDay', modelId: 'gpt-5.2', value: 5 },
          ],
        }),
      );
      expect(response.status).toBe(400);
    });

    it('rejects a path-traversal model qualifier', async () => {
      const response = await PUT(
        putRequest({
          ...validBody,
          defaults: [
            { limitKey: 'model.requests', modelId: '../../etc', value: 5 },
          ],
        }),
      );
      expect(response.status).toBe(400);
    });

    it('rejects an unknown timezone rather than storing a silent UTC fallback', async () => {
      const response = await PUT(
        putRequest({ ...validBody, timezone: 'Not/AZone' }),
      );
      expect(response.status).toBe(400);
    });

    it('rejects duplicate override ids', async () => {
      const override = {
        id: 'lim-0123456789ab',
        scope: 'user',
        targets: ['a@example.org'],
        entries: [],
      };
      const response = await PUT(
        putRequest({ ...validBody, overrides: [override, { ...override }] }),
      );
      expect(response.status).toBe(400);
    });

    it('rejects more than 200 overrides', async () => {
      const overrides = Array.from({ length: 201 }, (_, i) => ({
        id: `lim-${i.toString(16).padStart(12, '0')}`,
        scope: 'user',
        targets: [`u${i}@example.org`],
        entries: [],
      }));
      const response = await PUT(putRequest({ ...validBody, overrides }));
      expect(response.status).toBe(400);
    });

    it('rejects a malformed If-Match header', async () => {
      const response = await PUT(putRequest(validBody, { 'if-match': '*' }));
      expect(response.status).toBe(400);
      expect(writePolicy).not.toHaveBeenCalled();
    });

    it('rejects an invalid JSON body', async () => {
      const request = new NextRequest('http://localhost/api/limits/policy', {
        method: 'PUT',
        body: 'not json',
        headers: { 'content-type': 'application/json' },
      });
      expect((await PUT(request)).status).toBe(400);
    });
  });

  describe('PUT writes', () => {
    it('clamps a value above the compiled hardCeiling at the write boundary', async () => {
      await PUT(
        putRequest({
          ...validBody,
          defaults: [{ limitKey: 'feature.mcp.roundsPerRequest', value: 9999 }],
        }),
      );
      const written = vi.mocked(writePolicy).mock.calls[0][1];
      // An admin must never see a stored number the resolver would silently
      // reduce.
      expect(written.defaults[0].value).toBe(25);
    });

    it('passes a quoted strong ETag through as the CAS condition', async () => {
      await PUT(putRequest(validBody, { 'if-match': '"etag-7"' }));
      expect(writePolicy).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        '"etag-7"',
      );
    });

    it('creates with a null ETag when If-Match is absent', async () => {
      await PUT(putRequest(validBody));
      expect(writePolicy).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        null,
      );
    });

    it('writes a history entry and invalidates the cache after a successful write', async () => {
      await PUT(putRequest(validBody));
      expect(writeHistoryEntry).toHaveBeenCalledTimes(1);
      expect(serviceInvalidate).toHaveBeenCalledTimes(1);
    });

    it('maps a CAS conflict to 409 with LIMITS_CONFLICT', async () => {
      const { LimitsConflictError } = await vi.importActual<
        typeof import('@/lib/services/limits/limitsStore')
      >('@/lib/services/limits/limitsStore');
      vi.mocked(writePolicy).mockRejectedValue(new LimitsConflictError());

      const response = await PUT(putRequest(validBody, { 'if-match': '"e"' }));
      const body = await parseJsonResponse(response);
      expect(response.status).toBe(409);
      expect(body.code).toBe('LIMITS_CONFLICT');
    });

    it('stamps the acting admin as updatedBy', async () => {
      await PUT(putRequest(validBody));
      const written = vi.mocked(writePolicy).mock.calls[0][1];
      expect(written.updatedBy).toBe('global@example.com');
    });

    it('preserves group-scoped overrides untouched even though they never evaluate', async () => {
      await PUT(
        putRequest({
          ...validBody,
          overrides: [
            {
              id: 'lim-0123456789ab',
              scope: 'group',
              targets: ['00000000-0000-0000-0000-000000000001'],
              entries: [{ limitKey: 'chat.messagesPerDay', value: 5 }],
            },
          ],
        }),
      );
      const written = vi.mocked(writePolicy).mock.calls[0][1];
      expect(written.overrides[0].scope).toBe('group');
      expect(written.overrides[0].targets).toEqual([
        '00000000-0000-0000-0000-000000000001',
      ]);
    });
  });
});
