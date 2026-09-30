import { NextRequest } from 'next/server';

import {
  createAgentAccessBlobStorage,
  readGuide,
} from '@/lib/services/agentAccess/accessRulesStore';
import { hydrateGuide } from '@/lib/services/agentAccess/guidePayloadStore';
import { AgentAccessConfig, Guide } from '@/lib/services/agentAccess/types';

import { parseJsonResponse } from '../helpers';

import { GET } from '@/app/api/agent-access/guides/[id]/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const serviceIsEnabled = vi.hoisted(() => vi.fn());
const serviceEnsureFresh = vi.hoisted(() => vi.fn());
const serviceGetSnapshot = vi.hoisted(() => vi.fn());
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
      ensureFresh: serviceEnsureFresh,
      getSnapshot: serviceGetSnapshot,
    }),
  },
}));
vi.mock('@/lib/services/agentAccess/accessRulesStore', async (orig) => ({
  ...(await orig<
    typeof import('@/lib/services/agentAccess/accessRulesStore')
  >()),
  createAgentAccessBlobStorage: vi.fn(),
  readGuide: vi.fn(),
}));
vi.mock('@/lib/services/agentAccess/guidePayloadStore', () => ({
  hydrateGuide: vi.fn(),
}));

const GUIDE_ID = 'guide-abc123def456';

const config: AgentAccessConfig = {
  version: 1,
  localAdmins: [
    { email: 'local@example.com', agentKeys: [`guide::${GUIDE_ID}`] },
  ],
  updatedBy: 'global@example.com',
  updatedAt: '2026-07-23T00:00:00.000Z',
};

function meta(): Guide {
  return {
    version: 1,
    id: GUIDE_ID,
    kind: 'terminology',
    name: 'Org glossary',
    description: '',
    languages: [],
    payloadRef: 'abc123-0badf00d',
    payloadFormat: 'jsonl',
    entryCount: 1,
    workflows: ['translation'],
    createdBy: 'global@example.com',
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedBy: 'global@example.com',
    updatedAt: '2026-07-23T00:00:00.000Z',
  };
}

function get(id = GUIDE_ID) {
  return GET(
    new NextRequest(`https://app.example.com/api/agent-access/guides/${id}`),
    { params: Promise.resolve({ id }) },
  );
}

describe('GET /api/agent-access/guides/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceIsEnabled.mockReturnValue(true);
    serviceGetSnapshot.mockReturnValue({ config });
    mockAuth.mockResolvedValue({
      user: { id: 'u1', mail: 'global@example.com' },
    });
    vi.mocked(createAgentAccessBlobStorage).mockReturnValue({} as never);
    vi.mocked(readGuide).mockResolvedValue({ guide: meta(), etag: '"e1"' });
    vi.mocked(hydrateGuide).mockResolvedValue({
      ...meta(),
      entries: [{ source: 'IDP', target: 'PDI' }],
    });
  });

  it('404s before auth when the feature is off', async () => {
    serviceIsEnabled.mockReturnValue(false);
    expect((await get()).status).toBe(404);
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it('rejects a malformed id before any storage read', async () => {
    expect((await get('../config')).status).toBe(400);
    expect(readGuide).not.toHaveBeenCalled();
  });

  it('403s a non-admin and a local admin without the key', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u2', mail: 'x@example.com' } });
    expect((await get()).status).toBe(403);
    mockAuth.mockResolvedValue({
      user: { id: 'u3', mail: 'local@example.com' },
    });
    serviceGetSnapshot.mockReturnValue({
      config: { ...config, localAdmins: [] },
    });
    expect((await get()).status).toBe(403);
  });

  it('returns the hydrated guide with the CAS-fresh meta etag', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    const body = await parseJsonResponse(response);
    expect(body.data.guide.entries).toEqual([{ source: 'IDP', target: 'PDI' }]);
    expect(body.data.etag).toBe('"e1"');
    expect(body.data.payloadMissing).toBe(false);
  });

  it('reports a missing payload instead of 404ing so the admin can re-save', async () => {
    vi.mocked(hydrateGuide).mockResolvedValue(null);
    const body = await parseJsonResponse(await get());
    expect(body.data.payloadMissing).toBe(true);
    expect(body.data.guide.entries).toBeUndefined();
  });

  it('lets a delegated local admin read their key', async () => {
    mockAuth.mockResolvedValue({
      user: { id: 'u3', mail: 'local@example.com' },
    });
    expect((await get()).status).toBe(200);
  });
});
