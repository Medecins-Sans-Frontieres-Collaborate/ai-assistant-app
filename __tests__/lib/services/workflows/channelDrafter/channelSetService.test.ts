import { NextRequest } from 'next/server';

import { listAllChannelSets } from '@/lib/services/agentAccess/accessRulesStore';
import { ChannelRuleSet } from '@/lib/services/agentAccess/types';
import { ChannelProfilesUnavailableError } from '@/lib/services/workflows/channelDrafter/channelProfileService';
import {
  invalidateChannelSetCache,
  loadChannelSetFor,
  loadChannelSetsFor,
} from '@/lib/services/workflows/channelDrafter/channelSetService';

import { CHANNEL_PROFILES } from '@/lib/utils/shared/drafter/channels/channelProfiles';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const serviceIsEnabled = vi.hoisted(() => vi.fn());
const evaluateAccess = vi.hoisted(() => vi.fn());
const loadProfiles = vi.hoisted(() => vi.fn());

const snapshotFetchedAt = vi.hoisted(() => ({ value: 0 as number | null }));

vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: {
    getInstance: () => ({
      isEnabled: serviceIsEnabled,
      ensureFresh: vi.fn(),
      evaluateAccess,
      getSnapshot: () => ({ fetchedAt: snapshotFetchedAt.value }),
    }),
  },
}));
vi.mock('@/lib/services/m365/groupMembership', () => ({
  resolveUserGroupIds: vi.fn(),
}));
vi.mock(
  '@/lib/services/workflows/channelDrafter/channelProfileService',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@/lib/services/workflows/channelDrafter/channelProfileService')
    >()),
    loadChannelProfilesFor: loadProfiles,
  }),
);
vi.mock('@/lib/services/agentAccess/accessRulesStore', () => ({
  createAgentAccessBlobStorage: () => ({}),
  listAllChannelSets: vi.fn(),
}));

const request = new NextRequest('https://app.example.com/api/channel-sets');
const session = { user: { id: 'u1', mail: 'a@oslo.msf.org' }, expires: '' };

function stored(
  id: string,
  name: string,
  channels: ChannelRuleSet['channels'],
) {
  const record: ChannelRuleSet = {
    version: 1,
    id,
    name,
    language: 'Norwegian',
    description: '',
    channels,
    defaults: { channelIds: ['x'], articleLink: true, guideIds: [] },
    isDefault: false,
    createdBy: 'admin@msf.org',
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedBy: 'admin@msf.org',
    updatedAt: '2026-09-22T00:00:00.000Z',
  };
  return { canonicalKey: `channel-set::${id}`, record, etag: '"e"' };
}

describe('loadChannelSetsFor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateChannelSetCache();
    serviceIsEnabled.mockReturnValue(true);
    loadProfiles.mockResolvedValue(CHANNEL_PROFILES);
    evaluateAccess.mockReturnValue({ decision: 'allow', reason: 'no-rule' });
  });

  it('is the implicit default over every platform when nothing is stored', async () => {
    vi.mocked(listAllChannelSets).mockResolvedValue([]);
    const sets = await loadChannelSetsFor(
      request,
      session as never,
      'discovery',
    );
    expect(sets.map((set) => set.id)).toEqual(['default']);
    expect(sets[0].channels.map((c) => c.id)).toEqual(
      CHANNEL_PROFILES.map((p) => p.id),
    );
    expect(sets[0].grant).toBe('everyone');
  });

  it('merges each set with the platforms and says how the user got it', async () => {
    vi.mocked(listAllChannelSets).mockResolvedValue([
      stored('set-no', 'MSF Norge', {
        x: {
          enabled: true,
          guidance: 'Skriv kort.',
          defaultVoiceGuideId: 'g1',
        },
        linkedin: { enabled: false },
      }),
    ]);
    evaluateAccess.mockImplementation(({ agentName }) =>
      agentName === 'set-no'
        ? { decision: 'allow', reason: 'allow-domain' }
        : { decision: 'allow', reason: 'no-rule' },
    );
    const sets = await loadChannelSetsFor(
      request,
      session as never,
      'invocation',
    );
    expect(sets.map((set) => set.id)).toEqual(['default', 'set-no']);
    const norway = sets[1];
    expect(norway.grant).toBe('domain');
    expect(norway.channels.map((c) => c.id)).toEqual(['x']);
    expect(norway.channels[0].guidance).toBe('Skriv kort.');
    expect(norway.channels[0].segmentLimit).toBe(280);
    expect(norway.defaultVoices).toEqual({ x: 'g1' });
    expect(evaluateAccess).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'channel-set', agentName: 'set-no' }),
    );
  });

  it('a stored default replaces the implicit one', async () => {
    vi.mocked(listAllChannelSets).mockResolvedValue([
      stored('default', 'MSF', { x: { enabled: true } }),
    ]);
    const sets = await loadChannelSetsFor(
      request,
      session as never,
      'discovery',
    );
    expect(sets).toHaveLength(1);
    expect(sets[0].name).toBe('MSF');
    expect(sets[0].channels.map((c) => c.id)).toEqual(['x']);
  });

  it('hides a set the user is denied, and lists but never writes with an undecidable one', async () => {
    vi.mocked(listAllChannelSets).mockResolvedValue([
      stored('set-no', 'Norway', { x: { enabled: true } }),
      stored('set-us', 'USA', { x: { enabled: true } }),
    ]);
    evaluateAccess.mockImplementation(({ agentName }) =>
      agentName === 'set-no'
        ? { decision: 'deny', reason: 'restricted' }
        : agentName === 'set-us'
          ? { decision: 'unavailable', reason: 'group-membership-degraded' }
          : { decision: 'allow', reason: 'no-rule' },
    );
    const listed = await loadChannelSetsFor(
      request,
      session as never,
      'discovery',
    );
    expect(listed.map((s) => s.id)).toEqual(['default', 'set-us']);
    const usable = await loadChannelSetsFor(
      request,
      session as never,
      'invocation',
    );
    expect(usable.map((s) => s.id)).toEqual(['default']);
    expect(
      await loadChannelSetFor(request, session as never, 'set-us'),
    ).toBeUndefined();
    expect(
      (await loadChannelSetFor(request, session as never, undefined))?.id,
    ).toBe('default');
  });

  it('fails closed for writing when the sets were never read', async () => {
    vi.mocked(listAllChannelSets).mockRejectedValue(new Error('storage down'));
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const listed = await loadChannelSetsFor(
      request,
      session as never,
      'discovery',
    );
    expect(listed.map((s) => s.id)).toEqual(['default']);
    await expect(
      loadChannelSetsFor(request, session as never, 'invocation'),
    ).rejects.toBeInstanceOf(ChannelProfilesUnavailableError);
    errorSpy.mockRestore();
  });

  it('never serves a custom set that has no audience rule: that is a replica behind, or a deleted set', async () => {
    vi.mocked(listAllChannelSets).mockResolvedValue([
      stored('set-no', 'Norway', { x: { enabled: true } }),
    ]);
    evaluateAccess.mockReturnValue({ decision: 'allow', reason: 'no-rule' });
    const listed = await loadChannelSetsFor(
      request,
      session as never,
      'discovery',
    );
    expect(listed.map((s) => s.id)).toEqual(['default']);
    const usable = await loadChannelSetsFor(
      request,
      session as never,
      'invocation',
    );
    expect(usable.map((s) => s.id)).toEqual(['default']);
  });

  it('drops its records cache when the rules snapshot is newer', async () => {
    vi.mocked(listAllChannelSets).mockResolvedValue([]);
    await loadChannelSetsFor(request, session as never, 'discovery');
    await loadChannelSetsFor(request, session as never, 'discovery');
    expect(listAllChannelSets).toHaveBeenCalledTimes(1);
    snapshotFetchedAt.value = Date.now() + 1;
    await loadChannelSetsFor(request, session as never, 'discovery');
    expect(listAllChannelSets).toHaveBeenCalledTimes(2);
    snapshotFetchedAt.value = 0;
  });

  it('is the implicit default, without reading storage, when the subsystem is off', async () => {
    serviceIsEnabled.mockReturnValue(false);
    const sets = await loadChannelSetsFor(
      request,
      session as never,
      'invocation',
    );
    expect(sets.map((s) => s.id)).toEqual(['default']);
    expect(listAllChannelSets).not.toHaveBeenCalled();
  });
});
