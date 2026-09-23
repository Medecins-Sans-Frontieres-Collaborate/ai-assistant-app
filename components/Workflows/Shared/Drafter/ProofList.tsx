'use client';

import { IconAlertTriangle } from '@tabler/icons-react';

import { useTranslations } from 'next-intl';

import {
  BRIEF_ITSELF,
  summarizeProof,
} from '@/lib/utils/shared/drafter/core/grounding';

import { Brief, DraftSource, GroundingMark, Segment } from '@/types/drafter';

import { ProofCard } from './ProofCard';

interface ProofListProps {
  marks: GroundingMark[];
  segments: Segment[];
  brief: Brief;
  sources: DraftSource[];
}

/**
 * "Show proof": every quote and number in a version, numbered as in the
 * text, each with its evidence and a way back to the source. The sentence on
 * top is the answer to "can I trust this post", readable in a second.
 */
export function ProofList({ marks, segments, brief, sources }: ProofListProps) {
  const t = useTranslations('workflows.drafter');
  const summary = summarizeProof(marks, brief);
  const itemsById = new Map(brief.items.map((item) => [item.id, item]));
  const textOf = (mark: GroundingMark): string =>
    segments
      .find((segment) => segment.id === mark.segmentId)
      ?.text.slice(mark.start, mark.end) ?? '';

  if (marks.length === 0) {
    return (
      <p className="text-xs text-gray-700 dark:text-gray-300">
        {t('proofNothing')}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p
        className={`text-xs font-medium ${
          summary.ungrounded > 0
            ? 'text-amber-900 dark:text-amber-300'
            : 'text-gray-900 dark:text-gray-100'
        }`}
      >
        {t('proofSummary', {
          traced: summary.traced + summary.vouched,
          total: summary.total,
        })}
        {summary.vouched > 0 &&
          ` · ${t('proofVouched', { count: summary.vouched })}`}
      </p>
      <ol className="space-y-2">
        {marks.map((mark, index) => {
          const item = mark.itemId ? itemsById.get(mark.itemId) : undefined;
          return (
            <li
              key={`${mark.segmentId}:${mark.start}`}
              className="rounded-lg border border-gray-200 p-2 dark:border-gray-700"
            >
              <p
                className="mb-1 text-xs text-gray-900 dark:text-gray-100"
                dir="auto"
              >
                <span className="me-1 font-semibold tabular-nums">
                  {index + 1}.
                </span>
                {textOf(mark)}
              </p>
              {item ? (
                <ProofCard item={item} sources={sources} />
              ) : mark.itemId === BRIEF_ITSELF ? (
                <p className="text-xs text-gray-700 dark:text-gray-300">
                  {t('fromKeyMessage')}
                </p>
              ) : (
                <p className="flex items-start gap-1 text-xs text-amber-900 dark:text-amber-300">
                  <IconAlertTriangle
                    size={14}
                    className="mt-0.5 shrink-0"
                    aria-hidden
                  />
                  {mark.kind === 'quote'
                    ? t('quoteNotInBrief')
                    : t('numberNotInBrief')}
                </p>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
