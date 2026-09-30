import { NextRequest } from 'next/server';

import {
  AgentAccessConflictError,
  createAgentAccessBlobStorage,
  deleteChannelSet,
  deleteRule,
  listAllChannelProfiles,
  listAllChannelSets,
  readChannelSet,
  readRule,
  writeChannelSet,
  writeChannelSetHistoryEntry,
  writeRule,
} from '@/lib/services/agentAccess/accessRulesStore';
import { delegateToCreator } from '@/lib/services/agentAccess/adminRouteHelpers';
import {
  AgentAccessConfig,
  ChannelRuleSet,
  ChannelSetData,
} from '@/lib/services/agentAccess/types';

import { parseJsonResponse } from '../helpers';

import {
  DELETE,
  GET,
  POST,
  PUT,
} from '@/app/api/agent-access/channel-sets/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const serviceIsEnabled = vi.hoisted(() => vi.fn());
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
      ensureFresh: vi.fn(),
      getSnapshot: serviceGetSnapshot,
      invalidate: serviceInvalidate,
    }),
  },
}));
vi.mock(
  '@/lib/services/agentAccess/accessRulesStore',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@/lib/services/agentAccess/accessRulesStore')
    >()),
    createAgentAccessBlobStorage: vi.fn(),
    listAllChannelProfiles: vi.fn(),
    listAllChannelSets: vi.fn(),
    readChannelSet: vi.fn(),
    writeChannelSet: vi.fn(),
    deleteChannelSet: vi.fn(),
    readRule: vi.fn(),
    deleteRule: vi.fn(),
    writeChannelSetHistoryEntry: vi.fn(),
    writeRule: vi.fn(),
  }),
);
vi.mock(
  '@/lib/services/agentAccess/adminRouteHelpers',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@/lib/services/agentAccess/adminRouteHelpers')
    >()),
    delegateToCreator: vi.fn(),
  }),
);

const ETAG = '"etag-1"';
const OWN_ID = 'set-abc123def456';
const data: ChannelSetData = {
  name: 'MSF Norge',
  language: 'Norwegian',
  description: 'Norwegian house rules',
  channels: { x: { enabled: true, guidance: 'Skriv kort.' } },
  defaults: { channelIds: ['x'], articleLink: true, guideIds: [] },
  isDefault: false,
};

function record(overrides: Partial<ChannelRuleSet> = {}): ChannelRuleSet {
  return {
    version: 1,
    id: OWN_ID,
    ...data,
    createdBy: 'local@example.com',
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedBy: 'local@example.com',
    updatedAt: '2026-09-22T00:00:00.000Z',
    ...overrides,
  };
}

const url = 'https://app.example.com/api/agent-access/channel-sets';
const post = (body: unknown) =>
  POST(new NextRequest(url, { method: 'POST', body: JSON.stringify(body) }));
const put = (body: unknown, ifMatch: string | null = ETAG) =>
  PUT(
    new NextRequest(url, {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: ifMatch === null ? {} : { 'if-match': ifMatch },
    }),
  );
const del = (id: string, ifMatch: string | null = ETAG) =>
  DELETE(
    new NextRequest(`${url}?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: ifMatch === null ? {} : { 'if-match': ifMatch },
    }),
  );

const configWith = (localAdmins: AgentAccessConfig['localAdmins']) => ({
  rules: [
    { canonicalKey: `publish::${OWN_ID}/x` },
    { canonicalKey: `publish::${OWN_ID}/linkedin` },
    { canonicalKey: 'publish::set-other000000/x' },
    { canonicalKey: 'publish::*' },
  ],
  config: {
    version: 1 as const,
    localAdmins,
    updatedBy: 'global@example.com',
    updatedAt: '2026-09-22T00:00:00.000Z',
  },
});
const asGlobal = () =>
  mockAuth.mockResolvedValue({ user: { id: 'g', mail: 'global@example.com' } });
const asLocal = (keys: string[] = []) => {
  mockAuth.mockResolvedValue({ user: { id: 'l', mail: 'local@example.com' } });
  serviceGetSnapshot.mockReturnValue(
    configWith([{ email: 'local@example.com', agentKeys: keys }]),
  );
};

describe('/api/agent-access/channel-sets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceIsEnabled.mockReturnValue(true);
    serviceGetSnapshot.mockReturnValue(configWith([]));
    vi.mocked(createAgentAccessBlobStorage).mockReturnValue({} as never);
    vi.mocked(listAllChannelProfiles).mockResolvedValue([]);
    vi.mocked(listAllChannelSets).mockResolvedValue([]);
    vi.mocked(readChannelSet).mockResolvedValue(null);
    vi.mocked(writeChannelSet).mockResolvedValue('"etag-2"');
    vi.mocked(writeRule).mockResolvedValue('"rule-etag"');
    vi.mocked(deleteChannelSet).mockResolvedValue(true);
    vi.mocked(readRule).mockResolvedValue({ etag: '"r"' } as never);
    vi.mocked(deleteRule).mockResolvedValue(true);
    vi.mocked(writeChannelSetHistoryEntry).mockResolvedValue();
    vi.mocked(delegateToCreator).mockResolvedValue(true);
    asGlobal();
  });

  it('is for admins: a plain user is refused, and a local admin may create', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u', mail: 'user@example.com' } });
    expect((await GET()).status).toBe(403);
    expect((await post({ data })).status).toBe(403);
    asLocal();
    expect((await post({ data })).status).toBe(200);
    expect(delegateToCreator).toHaveBeenCalledWith(
      'local@example.com',
      expect.stringMatching(/^channel-set::set-[a-f0-9]{12}$/u),
    );
  });

  it('lists every set with whether this admin may edit it, and the implicit default', async () => {
    vi.mocked(listAllChannelSets).mockResolvedValue([
      { canonicalKey: `channel-set::${OWN_ID}`, record: record(), etag: ETAG },
    ]);
    asLocal([`channel-set::${OWN_ID}`]);
    const json = await parseJsonResponse(await GET());
    expect(json.data.sets[0].canEdit).toBe(true);
    expect(json.data.virtualDefault.id).toBe('default');
    expect(json.data.virtualDefault.canEdit).toBe(false);
    expect(json.data.platforms.length).toBeGreaterThan(5);
  });

  it('creates a set restricted to its creator, audience rule BEFORE record', async () => {
    const order: string[] = [];
    vi.mocked(writeRule).mockImplementation(async () => {
      order.push('rule');
      return '"r"';
    });
    vi.mocked(writeChannelSet).mockImplementation(async () => {
      order.push('record');
      return '"etag-2"';
    });
    const json = await parseJsonResponse(await post({ data }));
    expect(json.data.record.id).toMatch(/^set-[a-f0-9]{12}$/u);
    expect(json.data.record.isDefault).toBe(false);
    expect(order).toEqual(['rule', 'record']);
    expect(writeRule).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        source: 'channel-set',
        access: expect.objectContaining({
          type: 'restricted',
          allowUsers: ['global@example.com'],
        }),
      }),
      null,
    );
    // Create-only: a caller cannot choose the id.
    expect((await post({ id: OWN_ID, data })).status).toBe(400);
  });

  it('removes the set again when it cannot be delegated to a local creator', async () => {
    asLocal();
    vi.mocked(delegateToCreator).mockResolvedValue(false);
    const response = await post({ data });
    expect(response.status).toBe(500);
    expect(deleteChannelSet).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/^set-/u),
      '"etag-2"',
    );
    // The audience rule written first goes too.
    expect(vi.mocked(deleteRule).mock.calls[0]?.[1]).toMatch(
      /^channel-set::set-/u,
    );
  });

  it('keeps Hootsuite profile ids and isDefault as global-admin facts', async () => {
    const withTarget: ChannelSetData = {
      ...data,
      isDefault: true,
      channels: { x: { enabled: true, publishTarget: 'usa-fundraising' } },
    };
    // A local admin's create gets neither.
    asLocal();
    const created = await parseJsonResponse(await post({ data: withTarget }));
    expect(created.data.record.channels.x.publishTarget).toBeUndefined();
    expect(created.data.record.isDefault).toBe(false);
    // Their edit keeps what a global admin stored, and cannot change it.
    vi.mocked(readChannelSet).mockResolvedValue({
      record: record({
        isDefault: true,
        channels: { x: { enabled: true, publishTarget: 'norway-x' } },
      }),
      etag: ETAG,
    } as never);
    asLocal([`channel-set::${OWN_ID}`]);
    const edited = await parseJsonResponse(
      await put({
        id: OWN_ID,
        data: {
          ...data,
          isDefault: false,
          channels: { x: { enabled: true, publishTarget: 'usa-fundraising' } },
        },
      }),
    );
    expect(edited.data.record.channels.x.publishTarget).toBe('norway-x');
    expect(edited.data.record.isDefault).toBe(true);
    // A global admin may set both.
    asGlobal();
    const byGlobal = await parseJsonResponse(
      await put({ id: OWN_ID, data: withTarget }),
    );
    expect(byGlobal.data.record.channels.x.publishTarget).toBe(
      'usa-fundraising',
    );
    expect(byGlobal.data.record.isDefault).toBe(true);
  });

  it('shows other teams’ sets without their Hootsuite ids', async () => {
    vi.mocked(listAllChannelSets).mockResolvedValue([
      {
        canonicalKey: `channel-set::${OWN_ID}`,
        record: record({
          channels: { x: { enabled: true, publishTarget: 'norway-x' } },
        }),
        etag: ETAG,
      },
    ]);
    asLocal([]);
    const json = await parseJsonResponse(await GET());
    expect(json.data.sets[0].canEdit).toBe(false);
    expect(json.data.sets[0].record.channels.x.publishTarget).toBeUndefined();
    asGlobal();
    const mine = await parseJsonResponse(await GET());
    expect(mine.data.sets[0].record.channels.x.publishTarget).toBe('norway-x');
  });

  it('refuses a bad set: unknown fields, a default channel not in the set, a bad donation address', async () => {
    expect((await post({ data: { ...data, extra: 1 } })).status).toBe(400);
    expect(
      (
        await post({
          data: {
            ...data,
            defaults: { ...data.defaults, channelIds: ['linkedin'] },
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post({
          data: {
            ...data,
            defaults: { ...data.defaults, donationUrl: 'javascript:alert(1)' },
          },
        })
      ).status,
    ).toBe(400);
  });

  it('updates only a set this admin holds, under If-Match', async () => {
    vi.mocked(readChannelSet).mockResolvedValue({
      record: record(),
      etag: ETAG,
    } as never);
    asLocal([]);
    expect((await put({ id: OWN_ID, data })).status).toBe(403);
    asLocal([`channel-set::${OWN_ID}`]);
    expect((await put({ id: OWN_ID, data }, null)).status).toBe(400);
    const json = await parseJsonResponse(await put({ id: OWN_ID, data }));
    expect(json.data.record.createdBy).toBe('local@example.com');
    expect(writeChannelSet).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      ETAG,
    );
  });

  it('stores the built-in default on its first edit, create-only', async () => {
    const json = await parseJsonResponse(
      await put({ id: 'default', data: { ...data, name: 'MSF' } }, null),
    );
    expect(json.data.record.id).toBe('default');
    expect(writeChannelSet).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      null,
    );
    expect((await put({ id: 'set-000000000000', data })).status).toBe(404);
    // Two admins editing the built-in default for the first time: the
    // second is a conflict to reload from, not a malformed request.
    vi.mocked(readChannelSet).mockResolvedValue({
      record: record({ id: 'default' }),
      etag: ETAG,
    } as never);
    expect((await put({ id: 'default', data }, null)).status).toBe(409);
    expect((await put({ id: 'evil', data })).status).toBe(400);
  });

  it('reports a concurrent edit as a conflict and drops the caches', async () => {
    vi.mocked(readChannelSet).mockResolvedValue({
      record: record(),
      etag: ETAG,
    } as never);
    vi.mocked(writeChannelSet).mockRejectedValue(
      new AgentAccessConflictError('x'),
    );
    expect((await put({ id: OWN_ID, data })).status).toBe(409);
    expect(serviceInvalidate).toHaveBeenCalled();
  });

  it('deletes under If-Match with history; the default record too (that restores the built-in)', async () => {
    expect((await del(OWN_ID)).status).toBe(200);
    // What hung off the set goes with it: its audience and its sending
    // rules, and nothing of any other set's.
    expect(vi.mocked(deleteRule).mock.calls.map((call) => call[1])).toEqual([
      `channel-set::${OWN_ID}`,
      `publish::${OWN_ID}/x`,
      `publish::${OWN_ID}/linkedin`,
    ]);
    vi.mocked(deleteRule).mockClear();
    expect((await del('default')).status).toBe(200);
    expect(deleteRule).not.toHaveBeenCalled();
    expect(writeChannelSetHistoryEntry).toHaveBeenCalledTimes(2);
    expect((await del(OWN_ID, null)).status).toBe(400);
    asLocal([]);
    expect((await del(OWN_ID)).status).toBe(403);
  });
});
