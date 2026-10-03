import { NextRequest } from 'next/server';

import {
  createContextBudgetConfigBlobStorage,
  readContextBudgetConfig,
  writeContextBudgetConfig,
  writeContextBudgetConfigHistory,
} from '@/lib/services/contextBudget/contextBudgetStore';
import { CONTEXT_BUDGET_DEFAULTS } from '@/lib/services/contextBudget/types';

import { parseJsonResponse } from '../helpers';

import { GET, PUT } from '@/app/api/admin/context-budget/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const serviceInvalidate = vi.hoisted(() => vi.fn());
const mockEnv = vi.hoisted(() => ({
  AGENT_ACCESS_ADMINS: 'global@example.com',
}));

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/config/environment', () => ({ env: mockEnv }));
vi.mock('@/lib/services/contextBudget/ContextBudgetService', () => ({
  ContextBudgetService: {
    getInstance: () => ({ invalidate: serviceInvalidate }),
  },
}));
vi.mock(
  '@/lib/services/contextBudget/contextBudgetStore',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@/lib/services/contextBudget/contextBudgetStore')
      >();
    return {
      ...actual,
      createContextBudgetConfigBlobStorage: vi.fn(),
      readContextBudgetConfig: vi.fn(),
      writeContextBudgetConfig: vi.fn(),
      writeContextBudgetConfigHistory: vi.fn(),
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
  return new NextRequest('http://localhost/api/admin/context-budget', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const validBody = {
  budget: { historyTokens: 64_000, modelOverrides: { 'gpt-5.4': 96_000 } },
};

describe('/api/admin/context-budget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(globalAdminSession);
    vi.mocked(createContextBudgetConfigBlobStorage).mockReturnValue(
      {} as never,
    );
    vi.mocked(writeContextBudgetConfig).mockResolvedValue('"etag-new"');
    vi.mocked(writeContextBudgetConfigHistory).mockResolvedValue(undefined);
  });

  it('401s without a session, 403s for non-admins and view-as-demoted admins', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    mockAuth.mockResolvedValue(normalSession);
    expect((await PUT(putRequest(validBody))).status).toBe(403);
    mockAuth.mockResolvedValue(demotedAdminSession);
    expect((await GET()).status).toBe(403);
  });

  it('GET returns the stored config with the code defaults, bounds and catalog', async () => {
    vi.mocked(readContextBudgetConfig).mockResolvedValue(null);
    const body = await parseJsonResponse(await GET());
    expect(body.data.config).toBeNull();
    expect(body.data.configUnavailable).toBe(false);
    expect(body.data.defaults).toEqual(CONTEXT_BUDGET_DEFAULTS);
    expect(body.data.bounds.historyTokens).toEqual({ min: 4000, max: 400000 });
    expect(body.data.families.map((f: { id: string }) => f.id)).toEqual(
      expect.arrayContaining(['gpt', 'claude']),
    );
    expect(
      body.data.models.find((m: { id: string }) => m.id === 'gpt-5.4'),
    ).toMatchObject({ maxLength: 128000, tokenLimit: 16000 });
  });

  it('GET reports configUnavailable on a read failure rather than "no config"', async () => {
    vi.mocked(readContextBudgetConfig).mockRejectedValue(new Error('down'));
    const body = await parseJsonResponse(await GET());
    expect(body.data.configUnavailable).toBe(true);
  });

  it('PUT rejects out-of-range values and unknown keys', async () => {
    for (const budget of [
      { historyTokens: 100 },
      { historyFraction: 2 },
      { minRecentMessages: 0 },
      { modelOverrides: { 'gpt-5.4': 'lots' } },
      { tokenLimit: 5 },
    ]) {
      expect((await PUT(putRequest({ budget }))).status).toBe(400);
    }
    expect(writeContextBudgetConfig).not.toHaveBeenCalled();
  });

  it('PUT writes with CAS, records history, invalidates the service', async () => {
    const response = await PUT(
      putRequest(validBody, { 'if-match': '"etag-1"' }),
    );
    expect(response.status).toBe(200);
    const body = await parseJsonResponse(response);
    expect(body.data.etag).toBe('"etag-new"');
    expect(body.data.config.budget).toEqual(validBody.budget);
    expect(body.data.config.updatedBy).toBe('global@example.com');
    expect(vi.mocked(writeContextBudgetConfig).mock.calls[0][2]).toBe(
      '"etag-1"',
    );
    expect(writeContextBudgetConfigHistory).toHaveBeenCalledTimes(1);
    expect(serviceInvalidate).toHaveBeenCalledTimes(1);
  });

  it('PUT maps a CAS conflict to 409', async () => {
    const { ContextBudgetConfigConflictError } =
      await import('@/lib/services/contextBudget/contextBudgetStore');
    vi.mocked(writeContextBudgetConfig).mockRejectedValue(
      new ContextBudgetConfigConflictError('conflict'),
    );
    expect(
      (await PUT(putRequest(validBody, { 'if-match': '"etag-1"' }))).status,
    ).toBe(409);
  });
});
