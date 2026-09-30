/**
 * Channel-only checks, all read from the profile table: per-post length
 * under the platform's counting rule, slots (the opening line before the
 * fold), hashtags and links.
 */
import { VersionCheckCtx } from '@/lib/utils/shared/drafter/core/checks';
import {
  countText,
  nonGsmCharacters,
} from '@/lib/utils/shared/drafter/core/counting';
import {
  linkRanges,
  linkSegmentIndex,
} from '@/lib/utils/shared/drafter/core/links';
import { segmentOverflow } from '@/lib/utils/shared/drafter/core/segments';
import {
  CheckFinding,
  DeterministicCheck,
} from '@/lib/utils/shared/review/deterministicChecks';

import { ChannelProfile } from '@/types/drafter';

import { isNumbered } from './channelProfiles';

type ChannelCtx = VersionCheckCtx<ChannelProfile>;

const HASHTAG_PATTERN = /(^|\s)#[\p{L}\p{N}_]+/gu;
const LINK_PATTERN = /\b(?:https?:\/\/|www\.)\S+/giu;

export const lengthCheck: DeterministicCheck<ChannelCtx> = {
  id: 'length',
  run: (ctx) => {
    const findings: CheckFinding[] = [];
    ctx.segments.forEach((segment, index) => {
      const { over, overflowAt } = segmentOverflow(ctx.segments, index, {
        rule: ctx.spec.counting,
        limit: ctx.spec.segmentLimit,
        numbered: isNumbered(ctx.spec),
      });
      if (over <= 0) return;
      findings.push({
        checkId: 'length',
        severity: 'block',
        targetId: segment.id,
        range:
          overflowAt === null
            ? undefined
            : { start: overflowAt, end: segment.text.length },
        messageKey: 'overLimit',
        scope: 'kind',
        values: { count: over, post: index + 1 },
      });
    });
    return findings;
  },
};

/** The first line of the first segment, which is what a slot budgets. */
export function firstLine(text: string): string {
  return text.split(/\r?\n/u, 1)[0] ?? '';
}

export const slotCheck: DeterministicCheck<ChannelCtx> = {
  id: 'slot',
  run: (ctx) => {
    const first = ctx.segments[0];
    if (!first) return [];
    const line = firstLine(first.text);
    return ctx.spec.slots
      .filter((slot) => slot.appliesTo === 'first-segment-first-line')
      .flatMap((slot): CheckFinding[] => {
        const count = countText(ctx.spec.counting, line);
        if (count <= slot.maxChars) return [];
        return [
          {
            checkId: 'slot',
            severity: 'warn',
            targetId: first.id,
            range: { start: 0, end: line.length },
            messageKey: 'slotOver',
            scope: 'kind',
            values: { count: count - slot.maxChars, max: slot.maxChars },
          },
        ];
      });
  },
};

export const hashtagCheck: DeterministicCheck<ChannelCtx> = {
  id: 'hashtags',
  run: (ctx) => {
    const total = ctx.segments.reduce(
      (sum, segment) =>
        sum + [...segment.text.matchAll(HASHTAG_PATTERN)].length,
      0,
    );
    const max =
      ctx.spec.hashtags.placement === 'none' ? 0 : ctx.spec.hashtags.max;
    return total > max
      ? [
          {
            checkId: 'hashtags',
            severity: 'warn',
            messageKey: 'tooManyHashtags',
            scope: 'kind',
            values: { count: total, max },
          },
        ]
      : [];
  },
};

export const linkCheck: DeterministicCheck<ChannelCtx> = {
  id: 'links',
  run: (ctx) => {
    if (ctx.spec.links.allowed) return [];
    return ctx.segments.flatMap((segment): CheckFinding[] =>
      [...segment.text.matchAll(LINK_PATTERN)].map((match) => ({
        checkId: 'links',
        severity: 'warn' as const,
        targetId: segment.id,
        range: {
          start: match.index ?? 0,
          end: (match.index ?? 0) + match[0].length,
        },
        messageKey: 'linkNotClickable',
        scope: 'kind',
      })),
    );
  },
};

/**
 * A link the brief includes should be in the version, in the post that
 * carries links on this channel. Editing can drop or strand it (a split
 * leaves it mid-thread), so this is checked, as a warning: the user may
 * have moved it on purpose.
 */
export const briefLinkCheck: DeterministicCheck<ChannelCtx> = {
  id: 'brief-links',
  run: (ctx) => {
    if (!ctx.spec.links.allowed || ctx.segments.length === 0) return [];
    const expected = linkSegmentIndex(ctx.segments.length, {
      allowed: true,
      position: ctx.spec.links.position,
      cost: () => 0,
    });
    return ctx.brief.links.flatMap((link): CheckFinding[] => {
      const at = ctx.segments.findIndex(
        (s) => linkRanges(s.text, [link]).length > 0,
      );
      if (at === expected) return [];
      return [
        {
          checkId: 'brief-links',
          severity: 'warn',
          targetId: ctx.segments[at < 0 ? expected : at].id,
          messageKey:
            at < 0
              ? link.role === 'donation'
                ? 'donationLinkMissing'
                : 'articleLinkMissing'
              : 'linkNotInLastPost',
          scope: 'kind',
          values: { post: expected + 1 },
        },
      ];
    });
  },
};

/**
 * Images per post and alt text length, where the profile states them. A
 * channel whose profile says nothing about images is not checked: better
 * silent than wrong about a platform.
 */
export const mediaCheck: DeterministicCheck<ChannelCtx> = {
  id: 'media',
  run: (ctx) => {
    const rules = ctx.spec.media;
    if (!rules) return [];
    return ctx.segments.flatMap((segment, index): CheckFinding[] => {
      const media = segment.media ?? [];
      const findings: CheckFinding[] = [];
      if (media.length > rules.maxImages) {
        findings.push({
          checkId: 'media',
          severity: 'block',
          targetId: segment.id,
          messageKey:
            rules.maxImages === 0 ? 'imagesNotCarried' : 'tooManyImages',
          scope: 'kind',
          values: {
            count: media.length,
            max: rules.maxImages,
            post: index + 1,
          },
        });
      }
      const limit = rules.altLimit;
      if (limit !== undefined) {
        for (const item of media) {
          const length = countText('graphemes', item.alt);
          if (length > limit) {
            findings.push({
              checkId: 'media',
              severity: 'warn',
              targetId: segment.id,
              messageKey: 'altTooLong',
              scope: 'kind',
              values: { name: item.name, count: length - limit, max: limit },
            });
          }
        }
      }
      return findings;
    });
  },
};

/**
 * A text message with a character outside the GSM alphabet is sent as
 * Unicode and holds 70, not 160. The counter already charges for that; this
 * names the characters, because "“" costing ninety is not guessable.
 */
export const encodingCheck: DeterministicCheck<ChannelCtx> = {
  id: 'encoding',
  run: (ctx) => {
    if (ctx.spec.counting !== 'gsm7') return [];
    return ctx.segments.flatMap((segment): CheckFinding[] => {
      const characters = nonGsmCharacters(segment.text);
      if (characters.length === 0) return [];
      return [
        {
          checkId: 'encoding',
          severity: 'warn',
          targetId: segment.id,
          messageKey: 'unicodeSms',
          scope: 'kind',
          values: { characters: characters.slice(0, 8).join(' ') },
        },
      ];
    });
  },
};

export const CHANNEL_CHECKS: ReadonlyArray<DeterministicCheck<ChannelCtx>> = [
  lengthCheck,
  slotCheck,
  hashtagCheck,
  linkCheck,
  briefLinkCheck,
  mediaCheck,
  encodingCheck,
];
