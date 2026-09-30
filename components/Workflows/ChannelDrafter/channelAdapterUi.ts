import {
  channelFitOptions,
  channelLinkPolicy,
} from '@/lib/utils/shared/drafter/channels/channelAdapter';
import { firstLine } from '@/lib/utils/shared/drafter/channels/channelChecks';
import { buildChannelPreview } from '@/lib/utils/shared/drafter/channels/channelPreview';
import { isNumbered } from '@/lib/utils/shared/drafter/channels/channelProfiles';
import { countText } from '@/lib/utils/shared/drafter/core/counting';
import {
  dropTrailingHashtags,
  fitByMoving,
} from '@/lib/utils/shared/drafter/core/fit';
import {
  linkRanges,
  linkSegmentIndex,
  linksCost,
  placeLinks,
  stripLinks,
} from '@/lib/utils/shared/drafter/core/links';
import { protectedRanges } from '@/lib/utils/shared/drafter/core/revisions';
import {
  numberingSuffix,
  renderedSegmentText,
  segmentOverflow,
} from '@/lib/utils/shared/drafter/core/segments';

import { ChannelProfile } from '@/types/drafter';

import { SpecAdapterUi } from '@/components/Workflows/Shared/Drafter/adapterUi';

/**
 * What a channel adds to the shared drafter UI: per-post counters under the
 * platform's counting rule, the opening-line slot with its fold, copying a
 * thread one post at a time, and the deterministic overflow fix. All of it
 * read from the same profile table as the checks, so they cannot disagree.
 */
export const channelAdapterUi: SpecAdapterUi<ChannelProfile> = {
  namespace: 'workflows.channelDrafter',

  segmentMeta(profile, segments, index) {
    const numbered = isNumbered(profile);
    const { count, over, overflowAt } = segmentOverflow(segments, index, {
      rule: profile.counting,
      limit: profile.segmentLimit,
      numbered,
    });
    return {
      count,
      limit: profile.segmentLimit,
      over,
      overflowAt,
      numbering: numbered
        ? numberingSuffix(index, segments.length).trim() || undefined
        : undefined,
    };
  },

  firstSegmentSlot(profile, segments) {
    const slot = profile.slots.find(
      (entry) => entry.appliesTo === 'first-segment-first-line',
    );
    const first = segments[0];
    if (!slot || !first) return null;
    return {
      labelKey: slot.labelKey,
      foldLabelKey: slot.foldLabelKey,
      count: countText(profile.counting, firstLine(first.text)),
      max: slot.maxChars,
    };
  },

  copyPlan(profile, version) {
    const numbered = isNumbered(profile);
    return version.segments.map((segment, index) => ({
      segmentId: segment.id,
      text: renderedSegmentText(version.segments, index, numbered),
    }));
  },

  preview(profile, segments, links) {
    return buildChannelPreview(profile, segments, links);
  },

  fit(profile, segments, brief, mintId) {
    const options = channelFitOptions(profile);
    if (!options) return segments;
    const policy = channelLinkPolicy(profile);
    // Links that lead a thread are appended to the FIRST post, which is the
    // one overflow leaves: take them out, keep their room free, put them
    // back. At the end of the last post they simply travel with the text.
    const lifted = policy.allowed && policy.position === 'first';
    const input = lifted
      ? segments.map((segment) => ({
          ...segment,
          text: stripLinks(segment.text, brief.links),
        }))
      : segments;
    const report = fitByMoving(
      input,
      {
        ...options,
        protectedRanges: (segment) => protectedRanges(segment, brief),
        reserve: lifted
          ? (index, total) =>
              index === linkSegmentIndex(total, policy)
                ? linksCost(brief.links, policy)
                : 0
          : undefined,
      },
      mintId,
    );
    if (report.segments === input) return segments;
    if (!lifted) return report.segments;
    const placed = placeLinks(
      report.segments.map((segment) => segment.text),
      brief.links,
      policy,
    );
    return report.segments.map((segment, index) => ({
      ...segment,
      text: placed[index],
    }));
  },

  dropHashtags(profile, segments, segmentId, brief) {
    const index = segments.findIndex((segment) => segment.id === segmentId);
    if (index < 0) return segments;
    const { text } = segments[index];
    // Links placed by code close the post; hashtags "at the end" sit just
    // before them, so the links are held in place while tags are dropped.
    let tailStart = text.length;
    for (const range of linkRanges(text, brief.links).reverse()) {
      if (text.slice(range.end, tailStart).trim()) break;
      tailStart = range.start;
    }
    while (tailStart > 0 && /\s/u.test(text[tailStart - 1])) tailStart -= 1;
    const suffix = isNumbered(profile)
      ? numberingSuffix(index, segments.length)
      : '';
    const next = dropTrailingHashtags(
      text,
      (candidate) =>
        countText(profile.counting, `${candidate}${suffix}`) <=
        profile.segmentLimit,
      tailStart < text.length ? text.slice(tailStart) : '',
    );
    return next === text
      ? segments
      : segments.map((segment, at) =>
          at === index ? { ...segment, text: next } : segment,
        );
  },
};
