'use client';

import { useTranslations } from 'next-intl';

import {
  TranslationRunStage,
  translationRunSteps,
} from '@/lib/utils/shared/translation/runProgress';

import { TranslationTextMode } from '@/types/workflow';

import { ProgressSteps } from '../Shared/Progress/ProgressSteps';

interface TranslationRunStatusProps {
  mode: TranslationTextMode;
  /** The step in progress. */
  stage: TranslationRunStage;
  /** Review round in progress and the most rounds a run may take. */
  round?: string;
  totalRounds?: string;
}

const STEP_LABEL_KEY: Record<TranslationRunStage | 'done', string> = {
  analyzing: 'translation.stepAnalyzing',
  translating: 'translation.stepTranslating',
  reviewing: 'translation.stepReviewing',
  done: 'translation.stepDone',
};

/**
 * What a running translation is doing, shown at the top of the translation
 * pane. A Reviewed run has distinct phases, so it gets named steps and a
 * line saying what the current one does; a Quick run is a single pass, so
 * it gets a progress bar and no steps it does not have.
 */
export function TranslationRunStatus({
  mode,
  stage,
  round,
  totalRounds,
}: TranslationRunStatusProps) {
  const t = useTranslations('workflows');

  if (mode === 'quick') {
    return (
      <div role="status" className="px-3 pt-2">
        <div className="relative h-1 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
          <div className="absolute inset-y-0 rounded-full bg-blue-600 motion-safe:animate-indeterminate motion-reduce:inset-x-0 motion-reduce:opacity-60 dark:bg-blue-400" />
        </div>
        <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
          {t('translation.translating')}
        </p>
      </div>
    );
  }

  const hint =
    stage === 'analyzing'
      ? t('translation.runHintAnalyzing')
      : stage === 'translating'
        ? t('translation.runHintTranslating')
        : round && totalRounds
          ? t('translation.runHintReviewingRound', {
              round,
              total: totalRounds,
            })
          : t('translation.runHintReviewing');

  return (
    <div role="status" className="space-y-1.5 px-3 pt-2">
      <ProgressSteps
        label={t('translation.runProgressLabel')}
        steps={translationRunSteps(mode, stage).map((step) => ({
          ...step,
          label: t(STEP_LABEL_KEY[step.id]),
        }))}
      />
      <p className="text-xs text-gray-500 dark:text-gray-400">{hint}</p>
    </div>
  );
}
