import { NextRequest } from 'next/server';

import { listAllChannelProfiles } from '@/lib/services/agentAccess/accessRulesStore';
import {
  ChannelProfilesUnavailableError,
  invalidateChannelProfileCache,
  loadChannelProfilesFor,
} from '@/lib/services/workflows/channelDrafter/channelProfileService';

import { CHANNEL_PROFILES } from '@/lib/utils/shared/drafter/channels/channelProfiles';
import { profileDataOf } from '@/lib/utils/shared/drafter/channels/effectiveProfiles';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const serviceIsEnabled = vi.hoisted(() => vi.fn());
const serviceEnsureFresh = vi.hoisted(() => vi.fn());
const evaluateAccess = vi.hoisted(() => vi.fn());

vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: {
    getInstance: () => ({
      isEnabled: serviceIsEnabled,
      ensureFresh: serviceEnsureFresh,
      evaluateAccess,
      getSnapshot: () => ({ fetchedAt: 0 }),
    }),
  },
}));
vi.mock('@/lib/services/m365/groupMembership', () => ({
  resolveUserGroupIds: vi.fn().mockResolvedValue(undefined),
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
      createAgentAccessBlobStorage: vi.fn().mockReturnValue({}),
      listAllChannelProfiles: vi.fn(),
    };
  },
);

const request = new NextRequest('https://app.example.com/api/channel-profiles');
const session = { user: { id: 'u1', mail: 'a@example.org' }, expires: '' };
const x = CHANNEL_PROFILES.find((profile) => profile.id === 'x')!;

function stored(id: string, enabled: boolean, name = 'X') {
  return {
    canonicalKey: `channel-profile::${id}`,
    blobPath: 'irrelevant',
    etag: '"e"',
    record: {
      version: 1 as const,
      id,
      enabled,
      profile: { ...profileDataOf(x), name },
      createdBy: 'a',
      createdAt: '',
      updatedBy: 'a',
      updatedAt: '',
    },
  };
}

describe('loadChannelProfilesFor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateChannelProfileCache();
    serviceIsEnabled.mockReturnValue(true);
    evaluateAccess.mockReturnValue({ decision: 'allow', reason: 'no-rule' });
    vi.mocked(listAllChannelProfiles).mockResolvedValue([]);
  });

  it('is the built-ins, without touching storage, when the subsystem is off', async () => {
    serviceIsEnabled.mockReturnValue(false);
    const profiles = await loadChannelProfilesFor(
      request,
      session as never,
      'invocation',
    );
    expect(profiles).toEqual([...CHANNEL_PROFILES]);
    expect(listAllChannelProfiles).not.toHaveBeenCalled();
  });

  it('applies admin records, and never filters a platform by rules', async () => {
    vi.mocked(listAllChannelProfiles).mockResolvedValue([
      stored('x', true, 'X (Premium)'),
      stored('linkedin', false),
    ]);
    evaluateAccess.mockImplementation(({ agentName }) =>
      agentName === 'bluesky'
        ? { decision: 'deny', reason: 'restricted' }
        : { decision: 'allow', reason: 'no-rule' },
    );
    const profiles = await loadChannelProfilesFor(
      request,
      session as never,
      'invocation',
    );
    const ids = profiles.map((profile) => profile.id);
    expect(ids).not.toContain('linkedin');
    // Platforms are global facts; who may write for what is the sets' job.
    expect(ids).toContain('bluesky');
    expect(profiles.find((p) => p.id === 'x')?.name).toBe('X (Premium)');
    expect(evaluateAccess).not.toHaveBeenCalled();
  });

  it('keeps serving the last list it loaded through a storage failure', async () => {
    vi.mocked(listAllChannelProfiles).mockResolvedValueOnce([
      stored('linkedin', false),
    ]);
    const first = await loadChannelProfilesFor(
      request,
      session as never,
      'invocation',
    );
    expect(first.map((p) => p.id)).not.toContain('linkedin');

    // Expire the cache by time, then fail the reload.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5 * 60_000);
    vi.mocked(listAllChannelProfiles).mockRejectedValueOnce(new Error('down'));
    const second = await loadChannelProfilesFor(
      request,
      session as never,
      'invocation',
    );
    vi.useRealTimers();
    // A channel an admin switched off must not come back because of an outage.
    expect(second.map((p) => p.id)).not.toContain('linkedin');
  });

  it('LISTS the built-ins when nothing was ever loaded', async () => {
    vi.mocked(listAllChannelProfiles).mockRejectedValue(new Error('down'));
    const profiles = await loadChannelProfilesFor(
      request,
      session as never,
      'discovery',
    );
    expect(profiles).toEqual([...CHANNEL_PROFILES]);
  });

  it('fails closed for writing when nothing was ever loaded', async () => {
    // Cold replica, storage down: whether an admin switched a built-in off
    // is unknown, so serving the built-ins would bring it back.
    vi.mocked(listAllChannelProfiles).mockRejectedValue(new Error('down'));
    const attempt = loadChannelProfilesFor(
      request,
      session as never,
      'invocation',
    );
    await expect(attempt).rejects.toBeInstanceOf(
      ChannelProfilesUnavailableError,
    );
    await expect(attempt).rejects.toMatchObject({
      status: 503,
      code: 'CHANNEL_PROFILES_UNAVAILABLE',
    });
  });

  it('recovers as soon as storage answers again', async () => {
    vi.mocked(listAllChannelProfiles).mockRejectedValueOnce(new Error('down'));
    await expect(
      loadChannelProfilesFor(request, session as never, 'invocation'),
    ).rejects.toBeInstanceOf(ChannelProfilesUnavailableError);

    vi.mocked(listAllChannelProfiles).mockResolvedValueOnce([
      stored('linkedin', false),
    ]);
    const profiles = await loadChannelProfilesFor(
      request,
      session as never,
      'invocation',
    );
    expect(profiles.map((p) => p.id)).not.toContain('linkedin');
    expect(profiles.map((p) => p.id)).toContain('x');
  });
});
