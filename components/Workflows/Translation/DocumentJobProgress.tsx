'use client';

import { useTranslations } from 'next-intl';

import {
  DOCUMENT_JOB_STEPS,
  DocumentJobStep,
  documentJobStep,
} from '@/lib/utils/shared/translation/documentMode';
import { buildProgressSteps } from '@/lib/utils/shared/translation/runProgress';

import { TranslationDocumentJob } from '@/types/workflow';

import { ElapsedTime } from '../Shared/Progress/ElapsedTime';
import { ProgressSteps } from '../Shared/Progress/ProgressSteps';

interface DocumentJobProgressProps {
  job: TranslationDocumentJob & { status: 'translating' | 'preparing' };
}

const STEP_LABEL_KEY: Record<DocumentJobStep, string> = {
  uploaded: 'translation.documentStepUploaded',
  translating: 'translation.stepTranslating',
  preparing: 'translation.documentStepPreparing',
  ready: 'translation.uploadStepReady',
};

/**
 * Progress of a whole-document translation, shown in the translation pane
 * where the result will appear. The job runs on the server, so the timer
 * counts from the submission and the note says the page can be left.
 */
export function DocumentJobProgress({ job }: DocumentJobProgressProps) {
  const t = useTranslations('workflows');
  const submittedAt = Date.parse(job.submittedAt);

  return (
    <div
      role="status"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <ProgressSteps
        label={t('translation.documentProgressLabel')}
        steps={buildProgressSteps(
          DOCUMENT_JOB_STEPS,
          documentJobStep(job.status),
        ).map((step) => ({ ...step, label: t(STEP_LABEL_KEY[step.id]) }))}
      />
      <p className="text-sm text-gray-700 dark:text-gray-300">
        <ElapsedTime
          since={Number.isFinite(submittedAt) ? submittedAt : undefined}
        />
        {' · '}
        {t('translation.documentTypicalDuration')}
      </p>
      <p className="max-w-[48ch] text-xs text-gray-500 dark:text-gray-400">
        {t('translation.documentCanLeave')}
      </p>
    </div>
  );
}
