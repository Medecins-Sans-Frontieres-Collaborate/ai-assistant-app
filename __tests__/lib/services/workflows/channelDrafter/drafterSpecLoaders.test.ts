import { NextRequest } from 'next/server';

import { ChannelProfilesUnavailableError } from '@/lib/services/workflows/channelDrafter/channelProfileService';
import { loadSpecResolver } from '@/lib/services/workflows/drafterSpecLoaders';

import { getSpecAdapter } from '@/lib/utils/shared/drafter/adapters';
import { getChannelProfile } from '@/lib/utils/shared/drafter/channels/channelProfiles';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadSet = vi.hoisted(() => vi.fn());

vi.mock('@/lib/services/workflows/channelDrafter/channelSetService', () => ({
  loadChannelSetFor: loadSet,
}));

const setWith = (channels: unknown[]) => ({
  id: 'set-abc',
  name: 'Norway',
  channels,
});

const adapter = getSpecAdapter('channel')!;
const request = new NextRequest(
  'https://app.example.com/api/workflows/drafter/generate',
);
const session = { user: { id: 'u1', mail: 'a@example.org' }, expires: '' };

describe('loadSpecResolver (channel)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves only the channels of the set this caller may write with', async () => {
    loadSet.mockResolvedValue(setWith([getChannelProfile('linkedin')!]));
    const loaded = await loadSpecResolver(
      adapter,
      request,
      session as never,
      'set-abc',
    );
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.resolve('linkedin')?.id).toBe('linkedin');
    // A built-in that the set does not offer does not resolve.
    expect(loaded.resolve('x')).toBeUndefined();
    expect(loadSet).toHaveBeenCalledWith(request, session, 'set-abc');
  });

  it('resolves nothing for a set the caller may not use, or a non-string id', async () => {
    loadSet.mockResolvedValue(undefined);
    const loaded = await loadSpecResolver(adapter, request, session as never, {
      evil: true,
    });
    expect(loaded.ok && loaded.resolve('linkedin')).toBeUndefined();
    expect(loadSet).toHaveBeenCalledWith(request, session, undefined);
  });

  it('is a 503, not the built-ins, when channel settings cannot be read', async () => {
    loadSet.mockRejectedValue(new ChannelProfilesUnavailableError());
    const loaded = await loadSpecResolver(adapter, request, session as never);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.response.status).toBe(503);
    expect((await loaded.response.json()).code).toBe(
      'CHANNEL_PROFILES_UNAVAILABLE',
    );
  });

  it('does not swallow any other failure', async () => {
    loadSet.mockRejectedValue(new Error('boom'));
    await expect(
      loadSpecResolver(adapter, request, session as never),
    ).rejects.toThrow('boom');
  });
});
