'use client';

import { IconCheck } from '@tabler/icons-react';

import { useTranslations } from 'next-intl';

import { FormattedRunProgress } from '@/client/hooks/workflows/useFormattedDocument';

import { ElapsedTime } from '../../Shared/Progress/ElapsedTime';

interface FormattedProgressProps {
  progress: FormattedRunProgress;
  /** Display label of the target language. */
  language: string;
}

const MARKER = {
  done: 'border-green-600 bg-green-600 text-white dark:border-green-500 dark:bg-green-500 dark:text-gray-900',
  skipped: 'border-gray-400 text-gray-500 dark:border-gray-500',
  active:
    'border-blue-600 border-t-transparent motion-safe:animate-spin dark:border-blue-400 dark:border-t-transparent',
  upcoming: 'border-gray-300 dark:border-gray-600',
} as const;

/**
 * A formatted translation in progress: its fixed steps in order, each with
 * what it did and how long it took once it has ended.
 */
export function FormattedProgress({
  progress,
  language,
}: FormattedProgressProps) {
  const t = useTranslations('workflows');
  return (
    <div className="flex min-h-0 flex-1 justify-center overflow-y-auto px-5 py-10">
      <div className="w-full max-w-xl">
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          {t('translation.formatted.progressTitle', {
            count: progress.pageCount,
            language,
          })}
        </h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {progress.parts > 1
            ? t('translation.formatted.progressNoteParts')
            : t('translation.formatted.progressNote')}
        </p>
        {(progress.parts > 1 || progress.assembling) && (
          <p
            role="status"
            className="mt-3 text-sm font-medium text-gray-900 dark:text-gray-100"
          >
            {progress.assembling
              ? t('translation.formatted.progressAssembling')
              : t('translation.formatted.progressPart', {
                  part: progress.part,
                  parts: progress.parts,
                })}
          </p>
        )}
        <ol
          aria-label={t('translation.formatted.progressLabel')}
          className={`mt-6 ${progress.assembling ? 'hidden' : ''}`}
        >
          {progress.steps.map((step) => (
            <li
              key={step.id}
              aria-current={step.status === 'active' ? 'step' : undefined}
              data-status={step.status}
              className="flex gap-3.5 border-b border-gray-200 py-3 dark:border-gray-700"
            >
              <span
                aria-hidden
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${MARKER[step.status]}`}
              >
                {step.status === 'done' && <IconCheck size={12} stroke={3} />}
              </span>
              <div className="min-w-0 flex-1">
                <div
                  className={`text-sm font-medium ${
                    step.status === 'upcoming'
                      ? 'text-gray-500 dark:text-gray-400'
                      : 'text-gray-900 dark:text-gray-100'
                  }`}
                >
                  {t(`translation.formatted.step.${step.id}.title`)}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {step.detail ??
                    (step.status === 'active'
                      ? t('translation.formatted.stepRunning')
                      : t('translation.formatted.stepWaiting'))}
                </div>
              </div>
              <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400">
                {step.durationMs !== undefined
                  ? t('translation.formatted.seconds', {
                      seconds: (step.durationMs / 1000).toFixed(1),
                    })
                  : step.status === 'active' && <ElapsedTime />}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
