'use client';

import {
  IconChevronLeft,
  IconChevronRight,
  IconFileText,
} from '@tabler/icons-react';
import { FormEvent, useMemo, useState } from 'react';

import { useLocale, useTranslations } from 'next-intl';

import {
  SourcePage,
  parsePageSelection,
  selectBatch,
  selectBatchEndingBefore,
  selectionLength,
} from '@/lib/utils/shared/translation/pageBatches';

import { TranslationSourceDocument } from '@/types/workflow';

interface SourcePageSelectorProps {
  /** The large document the source text was taken from. */
  document: TranslationSourceDocument;
  /**
   * The document's pages, or null when they are not in memory (after a
   * reload) and must be fetched with `onLoadPages` before changing pages.
   */
  pages: SourcePage[] | null;
  /** Character budget of one translation batch. */
  maxChars: number;
  /** True while `onLoadPages` is running. */
  loading: boolean;
  /** Blocks every control (a run or an upload is in progress). */
  disabled: boolean;
  /** Called with a validated selection that fits the budget. */
  onSelect: (pages: number[]) => void;
  /** Fetches the document's pages again. */
  onLoadPages: () => void;
}

const BUTTON_CLASS =
  'inline-flex items-center gap-1 rounded-lg border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-surface-dark-elevated';

/**
 * Page selection for a document larger than one translation batch.
 *
 * Shows which pages are loaded as source text and lets the user load a
 * different range, or step to the previous or next batch. A selection is
 * applied only when it fits the batch budget; otherwise the strip says by
 * how much it is over.
 *
 * The page input starts from the applied selection. Callers remount the
 * component (a `key` on the selection) when the selection changes, so the
 * input never shows a stale range.
 */
export function SourcePageSelector({
  document,
  pages,
  maxChars,
  loading,
  disabled,
  onSelect,
  onLoadPages,
}: SourcePageSelectorProps) {
  const t = useTranslations('workflows');
  const locale = useLocale();
  const formatNumber = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  const [draft, setDraft] = useState(document.selectedPages);
  const [error, setError] = useState<string | null>(null);
  const applied = useMemo(() => {
    if (!pages) return null;
    const parsed = parsePageSelection(document.selectedPages, pages);
    return parsed.ok ? parsed.pages : null;
  }, [document.selectedPages, pages]);

  const previousBatch = useMemo(
    () =>
      pages && applied
        ? selectBatchEndingBefore(pages, maxChars, applied[0])
        : [],
    [pages, applied, maxChars],
  );
  const nextBatch = useMemo(
    () =>
      pages && applied
        ? selectBatch(pages, maxChars, applied[applied.length - 1] + 1)
        : [],
    [pages, applied, maxChars],
  );

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!pages) return;
    const parsed = parsePageSelection(draft, pages);
    if (!parsed.ok) {
      setError(
        parsed.reason === 'unavailable'
          ? t('translation.pagesUnavailable')
          : t('translation.pagesInvalid'),
      );
      return;
    }
    const length = selectionLength(pages, parsed.pages);
    if (length > maxChars) {
      setError(
        t('translation.pagesTooMany', {
          used: formatNumber.format(length),
          max: formatNumber.format(maxChars),
        }),
      );
      return;
    }
    setError(null);
    onSelect(parsed.pages);
  };

  const controlsDisabled = disabled || loading;

  return (
    <div className="border-b border-gray-200 px-3 py-2 dark:border-gray-700">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300">
          <IconFileText size={14} className="shrink-0" aria-hidden />
          <span className="truncate font-medium">{document.name}</span>
          <span className="shrink-0 text-gray-500 dark:text-gray-400">
            {t('translation.pagesLoaded', {
              selected: document.selectedPages,
              total: formatNumber.format(document.lastPage),
            })}
          </span>
        </span>

        {pages ? (
          <>
            <form onSubmit={handleSubmit} className="flex items-center gap-1.5">
              <label
                htmlFor="translation-source-pages"
                className="text-xs text-gray-500 dark:text-gray-400"
              >
                {t('translation.pagesLabel')}
              </label>
              <input
                id="translation-source-pages"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                disabled={controlsDisabled}
                inputMode="text"
                autoComplete="off"
                aria-invalid={error !== null}
                aria-describedby={
                  error ? 'translation-source-pages-error' : undefined
                }
                className="w-28 rounded-lg border border-gray-300 bg-transparent px-2 py-1 text-xs text-gray-900 focus:border-blue-500 focus:outline-none disabled:opacity-50 dark:border-gray-600 dark:text-gray-100"
              />
              <button
                type="submit"
                disabled={
                  controlsDisabled || draft.trim() === document.selectedPages
                }
                className={BUTTON_CLASS}
              >
                {t('translation.pagesApply')}
              </button>
            </form>

            <span className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => onSelect(previousBatch)}
                disabled={controlsDisabled || previousBatch.length === 0}
                className={BUTTON_CLASS}
              >
                <IconChevronLeft
                  size={13}
                  className="rtl:rotate-180"
                  aria-hidden
                />
                {t('translation.pagesPrevious')}
              </button>
              <button
                type="button"
                onClick={() => onSelect(nextBatch)}
                disabled={controlsDisabled || nextBatch.length === 0}
                className={BUTTON_CLASS}
              >
                {t('translation.pagesNext')}
                <IconChevronRight
                  size={13}
                  className="rtl:rotate-180"
                  aria-hidden
                />
              </button>
            </span>

            {applied && (
              <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400">
                {t('translation.pagesBudget', {
                  used: formatNumber.format(selectionLength(pages, applied)),
                  max: formatNumber.format(maxChars),
                })}
              </span>
            )}
          </>
        ) : (
          <button
            type="button"
            onClick={onLoadPages}
            disabled={controlsDisabled}
            className={BUTTON_CLASS}
          >
            {loading
              ? t('translation.pagesLoading')
              : t('translation.pagesChange')}
          </button>
        )}
      </div>
      {error && (
        <p
          id="translation-source-pages-error"
          role="alert"
          className="mt-1.5 text-xs text-red-700 dark:text-red-400"
        >
          {error}
        </p>
      )}
    </div>
  );
}
