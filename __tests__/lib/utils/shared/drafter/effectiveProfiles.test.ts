import { CHANNEL_PROFILES } from '@/lib/utils/shared/drafter/channels/channelProfiles';
import {
  effectiveChannelProfiles,
  isBuiltInChannelId,
  profileDataOf,
} from '@/lib/utils/shared/drafter/channels/effectiveProfiles';

import { describe, expect, it } from 'vitest';

const x = CHANNEL_PROFILES.find((profile) => profile.id === 'x')!;

describe('effectiveChannelProfiles', () => {
  it('is exactly the built-ins when an admin has changed nothing', () => {
    expect(effectiveChannelProfiles([])).toEqual([...CHANNEL_PROFILES]);
  });

  it('applies an admin’s correction to a built-in, keeping its place and id', () => {
    const corrected = effectiveChannelProfiles([
      {
        id: 'x',
        enabled: true,
        profile: {
          ...profileDataOf(x),
          segmentLimit: 4000,
          name: 'X (Premium)',
        },
      },
    ]);
    const at = CHANNEL_PROFILES.findIndex((profile) => profile.id === 'x');
    expect(corrected[at]).toMatchObject({
      id: 'x',
      kind: 'channel',
      name: 'X (Premium)',
      segmentLimit: 4000,
    });
    expect(corrected).toHaveLength(CHANNEL_PROFILES.length);
  });

  it('removes a channel the admin switched off, built-in or not', () => {
    const result = effectiveChannelProfiles([
      { id: 'x', enabled: false, profile: profileDataOf(x) },
      { id: 'chan-aaaaaaaaaaaa', enabled: false, profile: profileDataOf(x) },
    ]);
    expect(result.map((profile) => profile.id)).not.toContain('x');
    expect(result).toHaveLength(CHANNEL_PROFILES.length - 1);
  });

  it('adds the organisation’s own channels after the built-ins, by name', () => {
    const base = profileDataOf(x);
    const result = effectiveChannelProfiles([
      {
        id: 'chan-bbbbbbbbbbbb',
        enabled: true,
        profile: { ...base, name: 'Staff newsletter' },
      },
      {
        id: 'chan-aaaaaaaaaaaa',
        enabled: true,
        profile: { ...base, name: 'Intranet' },
      },
    ]);
    expect(result.slice(CHANNEL_PROFILES.length).map((p) => p.name)).toEqual([
      'Intranet',
      'Staff newsletter',
    ]);
    expect(result.every((profile) => profile.kind === 'channel')).toBe(true);
  });

  it('knows which ids are built in', () => {
    expect(isBuiltInChannelId('linkedin')).toBe(true);
    expect(isBuiltInChannelId('chan-aaaaaaaaaaaa')).toBe(false);
  });
});
