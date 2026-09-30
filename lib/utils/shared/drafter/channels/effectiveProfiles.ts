/**
 * The channels an organisation actually has: the built-in profiles, with an
 * admin's corrections applied, their own channels added, and anything they
 * switched off removed.
 *
 * Pure, and shared by the server (which resolves a spec id for a request)
 * and the client (which lists channels), so the two can never disagree about
 * what "LinkedIn" means today.
 */
import { ChannelProfile } from '@/types/drafter';

import { CHANNEL_PROFILES } from './channelProfiles';

/** The editable part of a profile: everything but its identity. */
export type ChannelProfileData = Omit<ChannelProfile, 'id' | 'kind'>;

/** An admin record, as far as merging is concerned. */
export interface ChannelProfileRecord {
  id: string;
  enabled: boolean;
  profile: ChannelProfileData;
}

export function isBuiltInChannelId(id: string): boolean {
  return CHANNEL_PROFILES.some((profile) => profile.id === id);
}

export function profileDataOf(profile: ChannelProfile): ChannelProfileData {
  const { id: _id, kind: _kind, ...data } = profile;
  return data;
}

/**
 * Built-ins first, in their own order, then the organisation's channels by
 * name. A record whose id is a built-in's replaces it; `enabled: false`
 * removes the channel for everyone.
 */
export function effectiveChannelProfiles(
  records: ReadonlyArray<ChannelProfileRecord>,
  builtIns: ReadonlyArray<ChannelProfile> = CHANNEL_PROFILES,
): ChannelProfile[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  const result: ChannelProfile[] = [];
  for (const builtIn of builtIns) {
    const record = byId.get(builtIn.id);
    if (!record) {
      result.push(builtIn);
    } else if (record.enabled) {
      result.push({ ...record.profile, id: builtIn.id, kind: 'channel' });
    }
    byId.delete(builtIn.id);
  }
  const added = [...byId.values()]
    .filter((record) => record.enabled)
    .map(
      (record): ChannelProfile => ({
        ...record.profile,
        id: record.id,
        kind: 'channel',
      }),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...result, ...added];
}
