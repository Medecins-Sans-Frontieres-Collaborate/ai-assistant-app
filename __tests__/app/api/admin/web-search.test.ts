import { NextRequest } from 'next/server';

import {
  DEFAULT_ASSESSOR_MODEL_ID,
  MULTI_STEP_DEFAULTS,
} from '@/lib/services/webSearch/config/types';
import {
  createWebSearchConfigBlobStorage,
  readWebSearchConfig,
  writeWebSearchConfig,
  writeWebSearchConfigHistory,
} from '@/lib/services/webSearch/config/webSearchConfigStore';

import { parseJsonResponse } from '../helpers';

import { GET, PUT } from '@/app/api/admin/web-search/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const serviceInvalidate = vi.hoisted(() => vi.fn());
const mockEnv = vi.hoisted(() => ({
  AGENT_ACCESS_ADMINS: 'global@example.com',
}));

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/config/environment', () => ({ env: mockEnv }));
vi.mock('@/lib/services/webSearch/config/WebSearchConfigService', () => ({
  WebSearchConfigService: {
    getInstance: () => ({ invalidate: serviceInvalidate }),
  },
}));
vi.mock(
  '@/lib/services/webSearch/config/webSearchConfigStore',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@/lib/services/webSearch/config/webSearchConfigStore')
      >();
    return {
      ...actual,
      createWebSearchConfigBlobStorage: vi.fn(),
      readWebSearchConfig: vi.fn(),
      writeWebSearchConfig: vi.fn(),
      writeWebSearchConfigHistory: vi.fn(),
    };
  },
);

const globalAdminSession = {
  user: { id: 'oid-1', displayName: 'Global', mail: 'global@example.com' },
};
const demotedAdminSession = {
  user: {
    ...globalAdminSession.user,
    viewAs: { overrides: { adminRole: 'none' }, actual: {} },
  },
};
const normalSession = {
  user: { id: 'oid-2', displayName: 'User', mail: 'user@example.com' },
};

function putRequest(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/admin/web-search', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const validBody = {
  multiStep: { enabled: true, maxSteps: 4, assessorModelId: 'gpt-5.4-mini' },
};

describe('/api/admin/web-search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(globalAdminSession);
    vi.mocked(createWebSearchConfigBlobStorage).mockReturnValue({} as never);
    vi.mocked(writeWebSearchConfig).mockResolvedValue('"etag-new"');
    vi.mocked(writeWebSearchConfigHistory).mockResolvedValue(undefined);
  });

  it('401s without a session', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect((await PUT(putRequest(validBody))).status).toBe(401);
  });

  it('403s for a non-admin', async () => {
    mockAuth.mockResolvedValue(normalSession);
    expect((await GET()).status).toBe(403);
    expect((await PUT(putRequest(validBody))).status).toBe(403);
  });

  it('403s for a global admin currently viewing as a regular user', async () => {
    mockAuth.mockResolvedValue(demotedAdminSession);
    expect((await GET()).status).toBe(403);
    expect((await PUT(putRequest(validBody))).status).toBe(403);
  });

  it('GET returns the stored config with the code defaults and choices', async () => {
    vi.mocked(readWebSearchConfig).mockResolvedValue(null);
    const body = await parseJsonResponse(await GET());
    expect(body.data.config).toBeNull();
    expect(body.data.configUnavailable).toBe(false);
    expect(body.data.defaults).toEqual(MULTI_STEP_DEFAULTS);
    expect(body.data.bounds.maxSteps).toEqual({ min: 1, max: 8 });
    expect(
      body.data.assessorModels.map((model: { id: string }) => model.id),
    ).toContain(DEFAULT_ASSESSOR_MODEL_ID);
  });

  it('GET reports configUnavailable on a read failure rather than "no config"', async () => {
    vi.mocked(readWebSearchConfig).mockRejectedValue(new Error('down'));
    const body = await parseJsonResponse(await GET());
    expect(body.data.configUnavailable).toBe(true);
    expect(body.data.config).toBeNull();
  });

  it('PUT rejects out-of-range values, unknown keys and bad models', async () => {
    const bad = [
      { multiStep: { maxSteps: 0 } },
      { multiStep: { maxSteps: 99 } },
      { multiStep: { enabled: 'yes' } },
      { multiStep: { surprise: true } },
      { multiStep: { assessorModelId: 'claude-opus-4-6' } },
      { multiStep: { assessorModelId: 'not-a-model' } },
      { multiStep: { maxSteps: 5, maxStepsExploratory: 3 } },
      {},
    ];
    for (const body of bad) {
      expect((await PUT(putRequest(body))).status).toBe(400);
    }
    expect(
      (await PUT(putRequest(validBody, { 'if-match': 'W/"weak"' }))).status,
    ).toBe(400);
    expect(writeWebSearchConfig).not.toHaveBeenCalled();
  });

  it('PUT writes with CAS, stamps the author, audits, and invalidates', async () => {
    const response = await PUT(
      putRequest(validBody, { 'if-match': '"etag-1"' }),
    );
    expect(response.status).toBe(200);
    const body = await parseJsonResponse(response);
    expect(body.data.etag).toBe('"etag-new"');
    expect(body.data.config.updatedBy).toBe('global@example.com');
    expect(body.data.config.multiStep).toEqual(validBody.multiStep);
    expect(vi.mocked(writeWebSearchConfig).mock.calls[0][2]).toBe('"etag-1"');
    expect(writeWebSearchConfigHistory).toHaveBeenCalledTimes(1);
    expect(serviceInvalidate).toHaveBeenCalledTimes(1);
  });

  it('PUT accepts an empty override set (reset to the code defaults)', async () => {
    const response = await PUT(putRequest({ multiStep: {} }));
    expect(response.status).toBe(200);
    expect(vi.mocked(writeWebSearchConfig).mock.calls[0][1].multiStep).toEqual(
      {},
    );
    // No If-Match → creation-only write.
    expect(vi.mocked(writeWebSearchConfig).mock.calls[0][2]).toBeNull();
  });

  it('maps a CAS conflict to 409', async () => {
    const { WebSearchConfigConflictError } =
      await import('@/lib/services/webSearch/config/webSearchConfigStore');
    vi.mocked(writeWebSearchConfig).mockRejectedValue(
      new WebSearchConfigConflictError('conflict'),
    );
    const response = await PUT(putRequest(validBody, { 'if-match': '"old"' }));
    expect(response.status).toBe(409);
    expect((await parseJsonResponse(response)).code).toBe(
      'WEB_SEARCH_CONFIG_CONFLICT',
    );
  });
});
