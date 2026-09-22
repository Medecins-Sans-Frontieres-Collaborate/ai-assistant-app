'use client';

import { useQuery } from '@tanstack/react-query';

import { CHANNEL_PROFILES } from '@/lib/utils/shared/drafter/channels/channelProfiles';
import {
  DEFAULT_CHANNEL_SET_ID,
  channelsOfSet,
  defaultVoicesOfSet,
  virtualDefaultSet,
} from '@/lib/utils/shared/drafter/channels/channelSets';

import { ChannelSetSummary } from '@/types/drafter';

interface ChannelSetsResponse {
  success: boolean;
  data?: { sets: ChannelSetSummary[]; suggestedSetId: string | null };
}

/** The built-in default set over the built-in platforms, as the API would serve it. */
function virtualDefaultSummary(): ChannelSetSummary {
  const data = virtualDefaultSet(CHANNEL_PROFILES);
  return {
    id: DEFAULT_CHANNEL_SET_ID,
    name: data.name,
    language: data.language,
    description: data.description,
    isDefault: data.isDefault,
    grant: 'everyone',
    defaults: data.defaults,
    defaultVoices: defaultVoicesOfSet(data),
    channels: channelsOfSet(data, CHANNEL_PROFILES),
  };
}

const VIRTUAL_DEFAULT: ReadonlyArray<ChannelSetSummary> = [
  virtualDefaultSummary(),
];

export interface ChannelSetsHandle {
  /** The rule sets this user may draft in; empty only when `noSets`. */
  sets: ReadonlyArray<ChannelSetSummary>;
  /** The server's pick for a user with no set remembered; null while unknown. */
  suggestedSetId: string | null;
  /** False until the server's list has arrived at least once. */
  isAuthoritative: boolean;
  /** True once the request has either succeeded or given up. */
  isSettled: boolean;
  /** The server said so: this user may draft in no set at all. */
  noSets: boolean;
}

/**
 * The channel rule sets this user may draft in (GET /api/channel-sets),
 * each with its channels already merged with the platforms.
 *
 * FAILS OPEN TO ONE VIRTUAL DEFAULT SET while loading or on a failed
 * request, like the channel list before it: a set is not an entitlement the
 * client may guess at, because the server re-resolves every spec inside the
 * set on each write, and the built-in default keeps a storage blip from
 * leaving someone with no channels at all. An AUTHORITATIVE empty list is a
 * different thing: the default set was restricted to others, and serving
 * the virtual default would fix drafts to a set the server then refuses.
 */
export function useChannelSets(): ChannelSetsHandle {
  const { data, isError } = useQuery({
    queryKey: ['channel-sets'],
    queryFn: async (): Promise<NonNullable<ChannelSetsResponse['data']>> => {
      const response = await fetch('/api/channel-sets');
      if (!response.ok) {
        throw new Error(`Failed to load channel sets: ${response.status}`);
      }
      const json: ChannelSetsResponse = await response.json();
      return {
        sets: json.data?.sets ?? [],
        suggestedSetId: json.data?.suggestedSetId ?? null,
      };
    },
    staleTime: 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  const isAuthoritative = data !== undefined;
  const noSets = isAuthoritative && data.sets.length === 0;
  // Loading and failure fail open to the virtual default; the server's own
  // empty answer is kept empty, and the workspace says so.
  const sets = data ? data.sets : VIRTUAL_DEFAULT;
  return {
    sets,
    suggestedSetId: data?.suggestedSetId ?? null,
    isAuthoritative,
    isSettled: isAuthoritative || isError,
    noSets,
  };
}
