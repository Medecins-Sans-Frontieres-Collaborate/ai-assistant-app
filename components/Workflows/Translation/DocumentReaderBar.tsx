'use client';

import {
  IconChevronLeft,
  IconChevronRight,
  IconFileText,
} from '@tabler/icons-react';
import { FormEvent, useState } from 'react';

import { useLocale, useTranslations } from 'next-intl';

import {
  clampPage,
  parsePageInput,
} from '@/lib/utils/shared/translation/documentMode';

import { TranslationDocumentJob } from '@/types/workflow';

interface DocumentReaderBarProps {
  job: TranslationDocumentJob;
  /** Pages with a saved correction, ascending. */
  correctedPages: number[];
  saveState: 'idle' | 'saving' | 'saved' | 'error';
  /** Blocks navigation (an assessment is running on the page in view). */
  disabled: boolean;
  onGoToPage: (page: number) => void;
}

/** Corrected pages listed as buttons before the rest fold into a count. */
const MAX_CORRECTION_LINKS = 6;

const BUTTON_CLASS =
  'inline-flex h-7 items-center gap-1 rounded-lg border border-gray-300 px-2 text-xs text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-surface-dark-elevated';

/**
 * Navigation for the whole-document reader, in the strip under the
 * toolbar: which file, which page, the pages the user has corrected, when
 * the files expire, and whether the latest change is saved.
 *
 * The page field starts from the page in view; callers remount the bar (a
 * `key` on the page) when the page changes, so it never shows a stale one.
 */
export function DocumentReaderBar({
  job,
  correctedPages,
  saveState,
  disabled,
  onGoToPage,
}: DocumentReaderBarProps) {
  const t = useTranslations('workflows');
  const locale = useLocale();
  const [draft, setDraft] = useState(String(job.page));
  const [invalid, setInvalid] = useState(false);

  const lastPage = job.pageCount;
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const page = parsePageInput(draft, lastPage);
    setInvalid(page === undefined);
    if (page !== undefined && page !== job.page) onGoToPage(page);
  };

  const expiry = job.expiresAt ? new Date(job.expiresAt) : undefined;
  const saveLabel =
    saveState === 'saving'
      ? t('translation.correctionSaving')
      : saveState === 'saved'
        ? t('translation.correctionSaved')
        : saveState === 'error'
          ? t('translation.correctionSaveFailed')
          : null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-gray-200 px-3 py-2 dark:border-gray-700">
      <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300">
        <IconFileText size={14} className="shrink-0" aria-hidden />
        <span className="truncate font-medium">{job.sourceName}</span>
      </span>

      <form onSubmit={handleSubmit} className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onGoToPage(clampPage(job.page - 1, lastPage))}
          disabled={disabled || job.page <= 1}
          aria-label={t('translation.pagePrevious')}
          className={BUTTON_CLASS}
        >
          <IconChevronLeft size={13} className="rtl:rotate-180" aria-hidden />
        </button>
        <label
          htmlFor="translation-reader-page"
          className="text-xs text-gray-500 dark:text-gray-400"
        >
          {t('translation.pageLabel')}
        </label>
        <input
          id="translation-reader-page"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={disabled}
          inputMode="numeric"
          autoComplete="off"
          aria-invalid={invalid}
          className="h-7 w-14 rounded-lg border border-gray-300 bg-transparent px-2 text-center text-xs tabular-nums text-gray-900 focus:border-blue-500 focus:outline-none disabled:opacity-50 aria-[invalid=true]:border-red-500 dark:border-gray-600 dark:text-gray-100"
        />
        {lastPage !== undefined && (
          <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400">
            {t('translation.pageOf', { total: String(lastPage) })}
          </span>
        )}
        <button
          type="button"
          onClick={() => onGoToPage(clampPage(job.page + 1, lastPage))}
          disabled={
            disabled || (lastPage !== undefined && job.page >= lastPage)
          }
          aria-label={t('translation.pageNext')}
          className={BUTTON_CLASS}
        >
          <IconChevronRight size={13} className="rtl:rotate-180" aria-hidden />
        </button>
      </form>

      {correctedPages.length > 0 && (
        <span className="flex flex-wrap items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
          {t('translation.correctedPages')}
          {correctedPages.slice(0, MAX_CORRECTION_LINKS).map((page) => (
            <button
              key={page}
              type="button"
              onClick={() => onGoToPage(page)}
              disabled={disabled}
              aria-current={page === job.page ? 'page' : undefined}
              className="rounded-full border border-gray-300 px-2 py-0.5 tabular-nums text-gray-700 hover:bg-gray-100 disabled:opacity-40 aria-[current=page]:border-blue-500 aria-[current=page]:text-blue-700 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-surface-dark-elevated dark:aria-[current=page]:text-blue-300"
            >
              {page}
            </button>
          ))}
          {correctedPages.length > MAX_CORRECTION_LINKS && (
            <span>
              {t('translation.correctedPagesMore', {
                count: correctedPages.length - MAX_CORRECTION_LINKS,
              })}
            </span>
          )}
        </span>
      )}

      <span className="ms-auto flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
        {saveLabel && (
          <span
            role="status"
            className={
              saveState === 'error' ? 'text-red-700 dark:text-red-400' : ''
            }
          >
            {saveLabel}
          </span>
        )}
        {expiry && !Number.isNaN(expiry.getTime()) && (
          <span>
            {t('translation.documentAvailableUntil', {
              date: new Intl.DateTimeFormat(locale, {
                day: 'numeric',
                month: 'short',
              }).format(expiry),
            })}
          </span>
        )}
      </span>
    </div>
  );
}
