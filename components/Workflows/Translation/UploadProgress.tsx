'use client';

import { IconFileText } from '@tabler/icons-react';

import { useTranslations } from 'next-intl';

import { UploadStage } from '@/client/services/workflows/fileTextExtraction';

import { formatBytes } from '@/lib/utils/app/storage/storageUtils';
import { buildProgressSteps } from '@/lib/utils/shared/translation/runProgress';

import { ElapsedTime } from '../Shared/Progress/ElapsedTime';
import { ProgressSteps } from '../Shared/Progress/ProgressSteps';

interface UploadProgressProps {
  fileName: string;
  /** File size in bytes. */
  fileSize: number;
  /** The step in progress. */
  stage: UploadStage;
  onCancel: () => void;
}

const UPLOAD_STEP_ORDER = ['uploading', 'reading', 'ready'] as const;

const STEP_LABEL_KEY: Record<(typeof UPLOAD_STEP_ORDER)[number], string> = {
  uploading: 'translation.uploadStepUploading',
  reading: 'translation.uploadStepReading',
  ready: 'translation.uploadStepReady',
};

/**
 * Progress of a document upload, shown in the source pane where the text
 * will land: the file, the step it is on, how long it has taken, and a way
 * to give up on it.
 */
export function UploadProgress({
  fileName,
  fileSize,
  stage,
  onCancel,
}: UploadProgressProps) {
  const t = useTranslations('workflows');

  return (
    <div
      role="status"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <span className="inline-flex max-w-full items-center gap-2 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-800 dark:border-gray-600 dark:text-gray-200">
        <IconFileText size={16} className="shrink-0" aria-hidden />
        <span className="truncate font-medium">{fileName}</span>
        <span className="shrink-0 text-gray-500 dark:text-gray-400">
          {formatBytes(fileSize)}
        </span>
      </span>
      <ProgressSteps
        label={t('translation.uploadProgressLabel')}
        steps={buildProgressSteps(UPLOAD_STEP_ORDER, stage).map((step) => ({
          ...step,
          label: t(STEP_LABEL_KEY[step.id]),
        }))}
      />
      <ElapsedTime className="text-xs text-gray-500 dark:text-gray-400" />
      <button
        type="button"
        onClick={onCancel}
        className="rounded-lg border border-gray-300 px-3 py-1 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-surface-dark-elevated"
      >
        {t('translation.uploadCancel')}
      </button>
    </div>
  );
}
