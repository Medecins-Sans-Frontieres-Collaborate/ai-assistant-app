import { SpecAdapter } from '@/lib/utils/shared/drafter/core/adapter';
import { countText } from '@/lib/utils/shared/drafter/core/counting';
import { LinkPolicy, linkSuffix } from '@/lib/utils/shared/drafter/core/links';
import {
  OverflowOptions,
  numberingSuffix,
} from '@/lib/utils/shared/drafter/core/segments';

import { ChannelProfile } from '@/types/drafter';

import { CHANNEL_CHECKS } from './channelChecks';
import {
  CHANNEL_PROFILES,
  getChannelProfile,
  isNumbered,
} from './channelProfiles';

/** The structural rules of a channel, in prose, for the model. */
export function channelPromptBlock(profile: ChannelProfile): string {
  const lines: string[] = [`Channel: ${profile.name}.`, profile.guidance];
  if (profile.maxSegments > 1) {
    lines.push(
      `This channel supports threads. Return one entry in "segments" per ` +
        `post, at most ${profile.maxSegments}. Use a single post unless the ` +
        `content truly needs more. Every post must make sense on its own.`,
    );
    if (isNumbered(profile)) {
      lines.push(
        'Do NOT number the posts yourself; numbering is added afterwards ' +
          'and already budgeted for.',
      );
    }
  } else {
    lines.push('Return exactly one entry in "segments".');
  }
  // The budget is what is left for WORDS: the numbering added afterwards is
  // taken off here, at its longest, instead of being promised and forgotten.
  // Then headroom, because a model's sense of length is approximate.
  const budget = channelSegmentBudget(profile);
  lines.push(
    `HARD LIMIT: the platform rejects a post over its limit. Each post must ` +
      `be under ${budget} characters, counting the full length of any ` +
      `quotation you place (its cost is stated beside its token). Aim for ` +
      `under ${Math.floor(budget * 0.9)}. A post that is too long is a ` +
      `failure; a shorter one is never a problem.`,
  );
  if (profile.counting === 'x-weighted') {
    lines.push(
      'On this platform every link counts as 23 characters, and emoji ' +
        'and CJK characters count double.',
    );
  }
  if (profile.counting === 'gsm7') {
    lines.push(
      'This is a text message. Use only plain keyboard characters: straight ' +
        'quotes and apostrophes, a hyphen rather than a dash, no emoji. Any ' +
        'other character cuts the room to 70.',
    );
  }
  for (const slot of profile.slots) {
    lines.push(
      `The first line of the first post is shown alone before a "see more" ` +
        `fold. Keep it under ${slot.maxChars} characters and make it carry ` +
        `the point by itself.`,
    );
  }
  if (profile.hashtags.placement === 'none' || profile.hashtags.max === 0) {
    lines.push('No hashtags.');
  } else {
    lines.push(
      `At most ${profile.hashtags.max} hashtags in total, placed ` +
        `${profile.hashtags.placement === 'end' ? 'at the end' : 'inline'}.`,
    );
  }
  if (!profile.links.allowed) {
    lines.push(
      'Links are not clickable here. Never write a URL. If the brief carries ' +
        'a link, point readers to the "link in bio" instead.',
    );
  }
  return lines.join('\n');
}

/** Characters one post has for words, its longest numbering taken off. */
export function channelSegmentBudget(profile: ChannelProfile): number {
  const numbering =
    isNumbered(profile) && profile.maxSegments > 1
      ? numberingSuffix(profile.maxSegments - 1, profile.maxSegments)
      : '';
  return profile.segmentLimit - countText(profile.counting, numbering);
}

/** How this channel's posts may be refitted; null where there is one post. */
export function channelFitOptions(
  profile: ChannelProfile,
): OverflowOptions | null {
  if (profile.maxSegments <= 1) return null;
  return {
    rule: profile.counting,
    limit: profile.segmentLimit,
    numbered: isNumbered(profile),
    maxSegments: profile.maxSegments,
  };
}

/**
 * Links go in the last post of a thread: that is where the closing call
 * lives, and a link in the opening post crowds the hook. Cost is counted
 * the way the platform counts it (a flat 23 on X).
 */
export function channelLinkPolicy(profile: ChannelProfile): LinkPolicy {
  return {
    allowed: profile.links.allowed,
    position: profile.links.position,
    cost: (url) => countText(profile.counting, linkSuffix(url)),
  };
}

export const channelAdapter: SpecAdapter<ChannelProfile> = {
  kind: 'channel',
  workflow: 'channel-drafter',
  resolveSpec: getChannelProfile,
  listSpecs: () => CHANNEL_PROFILES,
  promptBlock: channelPromptBlock,
  linkPolicy: channelLinkPolicy,
  cost: (profile, text) => countText(profile.counting, text),
  fitOptions: channelFitOptions,
  checks: () => CHANNEL_CHECKS,
};
