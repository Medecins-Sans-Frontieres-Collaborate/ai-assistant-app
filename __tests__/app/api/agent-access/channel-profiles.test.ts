import { NextRequest } from 'next/server';

import {
  createAgentAccessBlobStorage,
  deleteChannelProfile,
  listAllChannelProfiles,
  readChannelProfile,
  writeChannelProfile,
  writeChannelProfileHistoryEntry,
} from '@/lib/services/agentAccess/accessRulesStore';
import { AgentAccessConflictError } from '@/lib/services/agentAccess/accessRulesStore';
import {
  AdminChannelProfile,
  AgentAccessConfig,
  CHANNEL_PROFILE_SOURCE,
  canonicalAgentKey,
} from '@/lib/services/agentAccess/types';

import { CHANNEL_PROFILES } from '@/lib/utils/shared/drafter/channels/channelProfiles';
import { profileDataOf } from '@/lib/utils/shared/drafter/channels/effectiveProfiles';

import { parseJsonResponse } from '../helpers';

import {
  DELETE,
  GET,
  POST,
  PUT,
} from '@/app/api/agent-access/channel-profiles/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const serviceIsEnabled = vi.hoisted(() => vi.fn());
const serviceEnsureFresh = vi.hoisted(() => vi.fn());
const serviceGetSnapshot = vi.hoisted(() => vi.fn());
const serviceInvalidate = vi.hoisted(() => vi.fn());
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
      invalidate: serviceInvalidate,
    }),
  },
}));
vi.mock(
  '@/lib/services/agentAccess/accessRulesStore',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@/lib/services/agentAccess/accessRulesStore')
      >();
    return {
      ...actual,
      createAgentAccessBlobStorage: vi.fn(),
      listAllChannelProfiles: vi.fn(),
      readChannelProfile: vi.fn(),
      writeChannelProfile: vi.fn(),
      deleteChannelProfile: vi.fn(),
      writeChannelProfileHistoryEntry: vi.fn(),
    };
  },
);

const ETAG = '"etag-1"';
const OWN_ID = 'chan-abc123def456';
const x = CHANNEL_PROFILES.find((profile) => profile.id === 'x')!;
const validProfile = profileDataOf(x);

function record(
  overrides: Partial<AdminChannelProfile> = {},
): AdminChannelProfile {
  return {
    version: 1,
    id: 'x',
    enabled: true,
    profile: validProfile,
    createdBy: 'global@example.com',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedBy: 'global@example.com',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

const url = 'https://app.example.com/api/agent-access/channel-profiles';
const postRequest = (body: unknown) =>
  new NextRequest(url, { method: 'POST', body: JSON.stringify(body) });
const putRequest = (body: unknown, ifMatch: string | null = ETAG) =>
  new NextRequest(url, {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: ifMatch === null ? {} : { 'if-match': ifMatch },
  });
const deleteRequest = (id: string, ifMatch: string | null = ETAG) =>
  new NextRequest(`${url}?id=${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: ifMatch === null ? {} : { 'if-match': ifMatch },
  });

const emptyConfig: AgentAccessConfig = {
  version: 1,
  localAdmins: [],
  updatedBy: 'global@example.com',
  updatedAt: '2026-07-23T00:00:00.000Z',
};

describe('/api/agent-access/channel-profiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceIsEnabled.mockReturnValue(true);
    serviceGetSnapshot.mockReturnValue({ config: emptyConfig });
    mockAuth.mockResolvedValue({
      user: { id: 'u1', mail: 'global@example.com' },
    });
    vi.mocked(createAgentAccessBlobStorage).mockReturnValue({} as never);
    vi.mocked(listAllChannelProfiles).mockResolvedValue([]);
    vi.mocked(readChannelProfile).mockResolvedValue(null);
    vi.mocked(writeChannelProfile).mockResolvedValue('"etag-2"');
    vi.mocked(deleteChannelProfile).mockResolvedValue(true);
    vi.mocked(writeChannelProfileHistoryEntry).mockResolvedValue();
  });

  it('does not exist while the subsystem is off', async () => {
    serviceIsEnabled.mockReturnValue(false);
    expect((await GET()).status).toBe(404);
    expect((await POST(postRequest({}))).status).toBe(404);
  });

  it('is for global admins only: a local admin is refused on every verb', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);

    serviceGetSnapshot.mockReturnValue({
      config: {
        ...emptyConfig,
        localAdmins: [
          {
            email: 'local@example.com',
            agentKeys: [canonicalAgentKey(CHANNEL_PROFILE_SOURCE, 'x')],
          },
        ],
      },
    });
    mockAuth.mockResolvedValue({
      user: { id: 'u2', mail: 'local@example.com' },
    });
    const body = { id: 'x', enabled: true, profile: validProfile };
    expect((await GET()).status).toBe(403);
    expect((await POST(postRequest(body))).status).toBe(403);
    expect((await PUT(putRequest(body))).status).toBe(403);
    expect((await DELETE(deleteRequest('x'))).status).toBe(403);
    expect(writeChannelProfile).not.toHaveBeenCalled();
    expect(deleteChannelProfile).not.toHaveBeenCalled();
  });

  it('lists the built-in values beside the records', async () => {
    vi.mocked(listAllChannelProfiles).mockResolvedValue([
      {
        canonicalKey: canonicalAgentKey(CHANNEL_PROFILE_SOURCE, 'x'),
        blobPath: 'irrelevant',
        record: record(),
        etag: ETAG,
      },
    ]);
    const body = await parseJsonResponse(await GET());
    expect(body.data.builtIns).toHaveLength(CHANNEL_PROFILES.length);
    expect(body.data.builtIns[0]).not.toHaveProperty('profile.id');
    expect(body.data.records).toEqual([
      expect.objectContaining({ etag: ETAG, record: record() }),
    ]);
  });

  it('creates an override of a built-in, create-only', async () => {
    const response = await POST(
      postRequest({ id: 'x', enabled: true, profile: validProfile }),
    );
    expect(response.status).toBe(200);
    expect(writeChannelProfile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'x', createdBy: 'global@example.com' }),
      null,
    );
    expect(serviceInvalidate).toHaveBeenCalled();
    expect(writeChannelProfileHistoryEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'upsert' }),
    );
  });

  it('mints the id of an organisation’s own channel; a caller cannot choose one', async () => {
    const created = await parseJsonResponse(
      await POST(postRequest({ enabled: true, profile: validProfile })),
    );
    expect(created.data.record.id).toMatch(/^chan-[a-f0-9]{12}$/);

    const chosen = await POST(
      postRequest({
        id: '../rules/everything',
        enabled: true,
        profile: validProfile,
      }),
    );
    expect(chosen.status).toBe(400);
  });

  it('refuses a second record for the same channel', async () => {
    vi.mocked(readChannelProfile).mockResolvedValue({
      record: record(),
      etag: ETAG,
    });
    const response = await POST(
      postRequest({ id: 'x', enabled: true, profile: validProfile }),
    );
    expect(response.status).toBe(409);
    expect(writeChannelProfile).not.toHaveBeenCalled();
  });

  it('refuses limits that are out of bounds, unknown fields, or incoherent', async () => {
    const bad = [
      { ...validProfile, segmentLimit: 5 },
      { ...validProfile, maxSegments: 0 },
      { ...validProfile, name: '' },
      { ...validProfile, surprise: true },
      {
        ...validProfile,
        segmentLimit: 100,
        slots: [
          {
            id: 'opening-line',
            labelKey: 'openingLine',
            maxChars: 500,
            appliesTo: 'first-segment-first-line',
          },
        ],
      },
    ];
    for (const profile of bad) {
      const response = await POST(postRequest({ enabled: true, profile }));
      expect(response.status).toBe(400);
    }
    expect(writeChannelProfile).not.toHaveBeenCalled();
  });

  it('updates only under If-Match, and only a record that exists', async () => {
    const body = { id: 'x', enabled: false, profile: validProfile };
    expect((await PUT(putRequest(body, null))).status).toBe(400);
    expect((await PUT(putRequest(body, 'W/"weak"'))).status).toBe(400);
    expect((await PUT(putRequest(body))).status).toBe(404);

    vi.mocked(readChannelProfile).mockResolvedValue({
      record: record({ createdBy: 'first@example.com' }),
      etag: ETAG,
    });
    const response = await PUT(putRequest(body));
    expect(response.status).toBe(200);
    expect(writeChannelProfile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        enabled: false,
        createdBy: 'first@example.com',
        updatedBy: 'global@example.com',
      }),
      ETAG,
    );
  });

  it('reports a concurrent edit as a conflict and drops its caches', async () => {
    vi.mocked(readChannelProfile).mockResolvedValue({
      record: record(),
      etag: ETAG,
    });
    vi.mocked(writeChannelProfile).mockRejectedValue(
      new AgentAccessConflictError(),
    );
    const response = await PUT(
      putRequest({ id: 'x', enabled: true, profile: validProfile }),
    );
    expect(response.status).toBe(409);
    expect(serviceInvalidate).toHaveBeenCalled();
  });

  it('deletes under If-Match, with history; an unknown id shape is refused', async () => {
    expect((await DELETE(deleteRequest('x', null))).status).toBe(400);
    expect((await DELETE(deleteRequest('../config'))).status).toBe(400);

    const response = await DELETE(deleteRequest(OWN_ID));
    expect(response.status).toBe(200);
    expect(deleteChannelProfile).toHaveBeenCalledWith(
      expect.anything(),
      OWN_ID,
      ETAG,
    );
    expect(writeChannelProfileHistoryEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'delete', record: null }),
    );

    vi.mocked(deleteChannelProfile).mockResolvedValue(false);
    expect((await DELETE(deleteRequest(OWN_ID))).status).toBe(404);
  });
});
