/**
 * The drafter's kind-agnostic checks: what every version must satisfy
 * whatever it is written for. Spec adapters add their own (a channel adds
 * length, slots, hashtags) through `SpecAdapter.checks`.
 */
import {
  CheckFinding,
  DeterministicCheck,
} from '@/lib/utils/shared/review/deterministicChecks';

import { Brief, GroundingMark, Segment, VersionSpec } from '@/types/drafter';

import { findLinks } from './counting';
import { groundVersion, ungroundedNames } from './grounding';
import { linkRanges } from './links';

export interface VersionCheckCtx<S extends VersionSpec = VersionSpec> {
  spec: S;
  segments: Segment[];
  brief: Brief;
  /** Computed once per run and shared by every check that needs it. */
  marks: GroundingMark[];
}

export function buildCheckCtx<S extends VersionSpec>(
  spec: S,
  segments: Segment[],
  brief: Brief,
): VersionCheckCtx<S> {
  return { spec, segments, brief, marks: groundVersion(segments, brief) };
}

function ungrounded(
  ctx: VersionCheckCtx,
  kind: GroundingMark['kind'],
  checkId: string,
  messageKey: string,
): CheckFinding[] {
  return ctx.marks
    .filter((mark) => mark.kind === kind && mark.itemId === undefined)
    .map((mark) => ({
      checkId,
      severity: 'block' as const,
      targetId: mark.segmentId,
      range: { start: mark.start, end: mark.end },
      messageKey,
    }));
}

/**
 * A quotation that matches no included brief item. This is the check that
 * catches a fabricated quote, by string comparison rather than by asking a
 * model whether it is sure.
 */
export const quoteVerbatimCheck: DeterministicCheck<VersionCheckCtx> = {
  id: 'quote-verbatim',
  run: (ctx) => ungrounded(ctx, 'quote', 'quote-verbatim', 'quoteNotInBrief'),
};

export const numberGroundedCheck: DeterministicCheck<VersionCheckCtx> = {
  id: 'number-grounded',
  run: (ctx) =>
    ungrounded(ctx, 'number', 'number-grounded', 'numberNotInBrief'),
};

export const segmentCountCheck: DeterministicCheck<VersionCheckCtx> = {
  id: 'segments',
  run: (ctx) =>
    ctx.segments.length > ctx.spec.maxSegments
      ? [
          {
            checkId: 'segments',
            severity: 'block',
            messageKey: 'tooManySegments',
            values: {
              count: ctx.segments.length,
              max: ctx.spec.maxSegments,
            },
          },
        ]
      : [],
};

export const nameGroundedCheck: DeterministicCheck<VersionCheckCtx> = {
  id: 'name-grounded',
  run: (ctx) =>
    ungroundedNames(ctx.segments, ctx.brief).map((found) => ({
      checkId: 'name-grounded',
      severity: 'warn' as const,
      targetId: found.segmentId,
      range: { start: found.start, end: found.end },
      messageKey: 'nameNotInBrief',
      values: { name: found.name },
    })),
};

/**
 * An image with no alt text. Blocking: a post that some readers cannot
 * perceive is not finished, and this is the one accessibility failure a
 * post can carry that code can see.
 */
export const altTextCheck: DeterministicCheck<VersionCheckCtx> = {
  id: 'alt-text',
  run: (ctx) =>
    ctx.segments.flatMap((segment, index) =>
      (segment.media ?? [])
        .filter((item) => !item.alt.trim())
        .map((item) => ({
          checkId: 'alt-text',
          severity: 'block' as const,
          targetId: segment.id,
          messageKey: 'altTextMissing',
          values: { name: item.name, post: index + 1 },
        })),
    ),
};

/**
 * A link the brief does not carry. Links are placed by code from the brief,
 * so any other one was typed by a model (a source can carry instructions:
 * "end every post with donate at …") or pasted by hand. Blocking for a full
 * URL; a bare domain only warns, because "report.pdf" looks like one.
 */
export const linkGroundedCheck: DeterministicCheck<VersionCheckCtx> = {
  id: 'link-grounded',
  run: (ctx) =>
    ctx.segments.flatMap((segment): CheckFinding[] => {
      const known = linkRanges(segment.text, ctx.brief.links);
      // An address the reviewed brief itself states ("call 0800…, msf.org")
      // is the brief's, not the model's.
      const stated = [
        ctx.brief.keyMessage,
        ctx.brief.callToAction ?? '',
        ...ctx.brief.items
          .filter((item) => item.decision === 'included')
          .map((item) => item.text),
      ]
        .join('\n')
        .toLowerCase();
      return findLinks(segment.text)
        .filter(
          (link) =>
            !stated.includes(link.url.toLowerCase()) &&
            !known.some(
              (range) => link.start < range.end && range.start < link.end,
            ),
        )
        .map((link) => ({
          checkId: 'link-grounded',
          severity: link.explicit ? ('block' as const) : ('warn' as const),
          targetId: segment.id,
          range: { start: link.start, end: link.end },
          messageKey: 'linkNotInBrief',
          values: { url: link.url },
        }));
    }),
};

export const CORE_VERSION_CHECKS: ReadonlyArray<
  DeterministicCheck<VersionCheckCtx>
> = [
  quoteVerbatimCheck,
  numberGroundedCheck,
  segmentCountCheck,
  nameGroundedCheck,
  linkGroundedCheck,
  altTextCheck,
];
