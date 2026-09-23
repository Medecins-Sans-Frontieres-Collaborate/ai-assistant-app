/**
 * Channel RULE SETS: one team's house rules over the global platforms.
 *
 * A platform (`ChannelProfile`) says what a channel IS: limits, counting,
 * threads, media. A set says how THIS team writes for it: guidance in its
 * own language, hashtag habits, where the link goes, the default voice, the
 * team's Hootsuite profile. The two are merged here, and only here, so the
 * server (resolving a spec for a request) and the client (listing channels)
 * cannot disagree about what "LinkedIn, for MSF Norway" means.
 *
 * Sets are FORKS, not layers: a new set starts as a copy of another and
 * diverges freely. What should propagate (the facts) lives on the platform
 * and does; what should not (house rules) is the set's own.
 */
import {
  ChannelProfile,
  ChannelRule,
  ChannelSetData,
  ChannelSetGrant,
} from '@/types/drafter';

export const DEFAULT_CHANNEL_SET_ID = 'default';

/** The platform with one team's rules applied. */
export function applyChannelRule(
  platform: ChannelProfile,
  rule: ChannelRule,
): ChannelProfile {
  const { publishTarget: own, ...base } = platform;
  // The team's Hootsuite profile when the rule names one; else the
  // platform's, a global-admin fact the default set needs in order to send.
  const publishTarget = rule.publishTarget ?? own;
  return {
    ...base,
    guidance: rule.guidance?.trim() || platform.guidance,
    hashtags: rule.hashtags ?? platform.hashtags,
    links: {
      ...platform.links,
      position: rule.linkPosition ?? platform.links.position,
    },
    ...(publishTarget ? { publishTarget } : {}),
  };
}

/**
 * The channels a set offers, in the platforms' order: each platform the set
 * lists and has enabled, merged with its rule. A rule for a platform that
 * no longer exists is ignored.
 */
export function channelsOfSet(
  set: Pick<ChannelSetData, 'channels'>,
  platforms: ReadonlyArray<ChannelProfile>,
): ChannelProfile[] {
  return platforms.flatMap((platform) => {
    const rule = set.channels[platform.id];
    return rule?.enabled ? [applyChannelRule(platform, rule)] : [];
  });
}

/** Default voice per channel id, from the set's rules. */
export function defaultVoicesOfSet(
  set: Pick<ChannelSetData, 'channels'>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [id, rule] of Object.entries(set.channels)) {
    if (rule.enabled && rule.defaultVoiceGuideId) {
      result[id] = rule.defaultVoiceGuideId;
    }
  }
  return result;
}

/**
 * The set everyone has until an admin edits it: every platform, with the
 * platform's own guidance. Exists implicitly, so the first day looks like
 * today; once stored under the same id it is an ordinary record.
 */
export function virtualDefaultSet(
  platforms: ReadonlyArray<ChannelProfile>,
): ChannelSetData {
  return {
    name: 'Default',
    language: '',
    description: '',
    channels: Object.fromEntries(
      platforms.map((platform) => [platform.id, { enabled: true }]),
    ),
    defaults: { channelIds: [], articleLink: true, guideIds: [] },
    isDefault: true,
  };
}

/**
 * A copy of a set's rules to start a new set from (a fork). Hootsuite
 * profiles are the source team's, not the new team's, so they stay behind.
 */
export function forkChannelSetData(
  source: ChannelSetData,
  name: string,
): ChannelSetData {
  return {
    ...source,
    name,
    isDefault: false,
    channels: Object.fromEntries(
      Object.entries(source.channels).map(([id, rule]) => {
        const { publishTarget: _theirs, ...rest } = rule;
        return [id, { ...rest }];
      }),
    ),
    defaults: {
      ...source.defaults,
      channelIds: [...source.defaults.channelIds],
      guideIds: [...source.defaults.guideIds],
    },
  };
}

/** The access-rule name for sending one set's channel: `<set>/<channel>`. */
export function publishRuleName(setId: string, channelId: string): string {
  return `${setId}/${channelId}`;
}

const GRANT_RANK: Record<ChannelSetGrant, number> = {
  user: 3,
  group: 2,
  domain: 1,
  everyone: 0,
};

/** The engine's reason for allowing, as the grant it expresses. */
export function grantOfReason(reason: string): ChannelSetGrant {
  if (reason === 'allow-user') return 'user';
  if (reason === 'allow-group') return 'group';
  if (reason === 'allow-domain') return 'domain';
  return 'everyone';
}

/**
 * Which set a user lands in, with nothing configured: the one they used
 * last if they still may; otherwise the most specifically granted (a set
 * shared with them by name beats one open to their whole domain); then the
 * one an admin marked as default; then the built-in default; then the
 * first by name. Null only when there are no sets at all.
 */
export function pickChannelSet<
  S extends {
    id: string;
    name: string;
    isDefault: boolean;
    grant: ChannelSetGrant;
  },
>(sets: ReadonlyArray<S>, lastUsedId?: string | null): S | null {
  if (sets.length === 0) return null;
  const last = lastUsedId ? sets.find((set) => set.id === lastUsedId) : null;
  if (last) return last;
  return [...sets].sort(
    (a, b) =>
      GRANT_RANK[b.grant] - GRANT_RANK[a.grant] ||
      Number(b.isDefault) - Number(a.isDefault) ||
      Number(b.id === DEFAULT_CHANNEL_SET_ID) -
        Number(a.id === DEFAULT_CHANNEL_SET_ID) ||
      a.name.localeCompare(b.name),
  )[0];
}
