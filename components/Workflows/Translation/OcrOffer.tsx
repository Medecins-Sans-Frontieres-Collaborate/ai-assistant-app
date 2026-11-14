'use client';

import { IconFileText, IconScan } from '@tabler/icons-react';

import { useTranslations } from 'next-intl';

/**
 * Why OCR is offered. `no-text`: extraction found nothing. `sparse`: it
 * found very little. `manual`: the user asked for it.
 */
export type OcrOfferReason = 'no-text' | 'sparse' | 'manual';

interface OcrOfferProps {
  fileName: string;
  reason: OcrOfferReason;
  /** False when the server has no OCR; the offer then has no OCR action. */
  canOcr: boolean;
  /**
   * Sends the file to whole-document translation instead, which reads
   * scanned pages itself. Offered when given.
   */
  onTranslateWhole?: () => void;
  /** OCR pages left today, when a limit applies to this user. */
  pagesLeft?: number;
  /** Failure of the last OCR attempt on this file, already localized. */
  error?: string | null;
  onRun: () => void;
  onDismiss: () => void;
}

const REASON_KEY: Record<OcrOfferReason, string> = {
  'no-text': 'translation.ocrReasonNoText',
  sparse: 'translation.ocrReasonSparse',
  manual: 'translation.ocrReasonManual',
};

/**
 * Offers the ways to work with an uploaded PDF whose text is missing or
 * poor, in the source pane where its text would be: read it with OCR, or
 * (for a file with no text) translate it whole. States what each does and
 * costs before anything runs.
 */
export function OcrOffer({
  fileName,
  reason,
  canOcr,
  onTranslateWhole,
  pagesLeft,
  error,
  onRun,
  onDismiss,
}: OcrOfferProps) {
  const t = useTranslations('workflows');

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <IconScan
        size={28}
        className="text-gray-500 dark:text-gray-400"
        aria-hidden
      />
      <p className="max-w-[44ch] text-sm font-medium text-gray-900 dark:text-gray-100">
        {t(REASON_KEY[reason], { name: fileName })}
      </p>
      <p className="max-w-[52ch] text-xs text-gray-600 dark:text-gray-400">
        {canOcr && t('translation.ocrExplanation')}
        {canOcr && pagesLeft !== undefined && (
          <> {t('translation.ocrPagesLeft', { count: pagesLeft })}</>
        )}
      </p>
      {onTranslateWhole && (
        <p className="max-w-[52ch] text-xs text-gray-600 dark:text-gray-400">
          {t('translation.scannedWholeExplanation')}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="max-w-[52ch] text-xs text-red-700 dark:text-red-400"
        >
          {error}
        </p>
      )}
      <span className="flex items-center gap-2">
        {canOcr && (
          <button
            type="button"
            onClick={onRun}
            className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg bg-gray-300 px-3 py-1 text-xs font-medium text-gray-900 hover:bg-gray-400 dark:bg-surface-dark-base dark:text-white dark:hover:bg-surface-dark-elevated"
          >
            <IconScan size={14} aria-hidden />
            {error ? t('translation.retry') : t('translation.ocrRun')}
          </button>
        )}
        {onTranslateWhole && (
          <button
            type="button"
            onClick={onTranslateWhole}
            className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg border border-gray-400 px-3 py-1 text-xs font-medium text-gray-900 hover:bg-gray-100 dark:border-gray-500 dark:text-gray-100 dark:hover:bg-surface-dark-elevated"
          >
            <IconFileText size={14} aria-hidden />
            {t('translation.scannedUseWholeDocument')}
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          className="min-h-[32px] rounded-lg border border-gray-300 px-3 py-1 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-surface-dark-elevated"
        >
          {t('translation.ocrDismiss')}
        </button>
      </span>
    </div>
  );
}
