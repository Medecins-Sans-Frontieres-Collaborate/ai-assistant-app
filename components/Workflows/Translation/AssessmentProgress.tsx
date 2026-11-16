'use client';

import { useTranslations } from 'next-intl';

import { ElapsedTime } from '../Shared/Progress/ElapsedTime';
import { SkeletonLines } from '../Shared/Progress/SkeletonLines';

interface AssessmentProgressProps {
  /** Display names of the criteria being assessed. */
  criteria: string[];
}

/**
 * The quality column while an assessment runs: which criteria are being
 * checked and where the suggested edits will appear.
 *
 * The assessment is one request, so every criterion is in progress at once
 * and they all finish together. Nothing here pretends otherwise.
 */
export function AssessmentProgress({ criteria }: AssessmentProgressProps) {
  const t = useTranslations('workflows');

  return (
    <div role="status" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2.5 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t('translation.assessmentTitle')}
        </h3>
        <ElapsedTime className="text-xs text-gray-500 dark:text-gray-400" />
      </div>
      <div className="space-y-3 px-3 py-3">
        <p className="text-xs text-gray-600 dark:text-gray-400">
          {t('translation.assessingCriteria', {
            count: criteria.length,
          })}
        </p>
        <ul className="space-y-1.5">
          {criteria.map((criterion) => (
            <li
              key={criterion}
              className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200"
            >
              <span
                aria-hidden
                className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-blue-600 border-t-transparent motion-safe:animate-spin dark:border-blue-400 dark:border-t-transparent"
              />
              {criterion}
            </li>
          ))}
        </ul>
        <div className="space-y-2 border-t border-gray-200 pt-3 dark:border-gray-700">
          <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-300">
            {t('translation.suggestedEdits')}
          </h4>
          {[0, 1].map((card) => (
            <div
              key={card}
              className="rounded-lg border border-gray-200 p-3 dark:border-gray-700"
            >
              <SkeletonLines widths={['85%', '45%']} />
            </div>
          ))}
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t('translation.editsPending')}
          </p>
        </div>
      </div>
    </div>
  );
}
