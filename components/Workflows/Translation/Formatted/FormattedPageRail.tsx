'use client';

import { IconArrowBackUp, IconX } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { PdfPages } from '@/client/hooks/workflows/usePdfPages';

import {
  BatchPageState,
  BatchPlan,
  FormattedDocumentRun,
  batchPageState,
  removedPages,
  translatedPages,
} from '@/lib/utils/shared/translation/formattedDocument';

/** Width a source page is rendered at for its thumbnail, in CSS pixels. */
const THUMBNAIL_WIDTH = 176;

/** How far outside the list a thumbnail starts rendering. */
const THUMBNAIL_MARGIN = '240px';

/**
 * How a page's thumbnail looks, by what the download holds of it. The
 * three must not be mistaken for one another: a translated page is shown
 * in full, a page still in the source language is dimmed, and a removed
 * page is all but gone.
 */
const THUMBNAIL_LOOK = {
  translated: '',
  untranslated: 'opacity-55',
  removed: 'opacity-20 grayscale',
} as const;

interface SourceThumbnailProps {
  page: number;
  pdf: PdfPages;
  className: string;
}

/**
 * A page of the source document, rendered only once it is near the visible
 * part of the list: a long document has many pages that are never looked at.
 */
function SourceThumbnail({ page, pdf, className }: SourceThumbnailProps) {
  const holder = useRef<HTMLSpanElement>(null);
  // Without the observer (an old browser) every thumbnail simply renders.
  const [near, setNear] = useState(
    () => typeof IntersectionObserver === 'undefined',
  );
  const [image, setImage] = useState<string | null>(null);
  const { renderPage, status } = pdf;

  useEffect(() => {
    if (near || !holder.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: THUMBNAIL_MARGIN },
    );
    observer.observe(holder.current);
    return () => observer.disconnect();
  }, [near]);

  useEffect(() => {
    if (!near || status !== 'ready') return;
    let cancelled = false;
    void renderPage(page, THUMBNAIL_WIDTH).then((url) => {
      if (!cancelled) setImage(url);
    });
    return () => {
      cancelled = true;
    };
  }, [near, status, renderPage, page]);

  return image ? (
    // A rendered page of the user's own file, as a data URL.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={image} alt="" className={`w-full rounded-sm ${className}`} />
  ) : (
    <span
      ref={holder}
      className={`block aspect-[210/297] w-full rounded-sm bg-gray-200 dark:bg-surface-dark-elevated ${
        status === 'failed' ? '' : 'animate-pulse'
      }`}
    />
  );
}

export interface FormattedPageRailProps {
  run: FormattedDocumentRun;
  /** Pages in the source document. */
  pageCount: number;
  /** The source document, for pages that are not translated. */
  pdf: PdfPages;
  /** Loaded images of the translated pages, by preview URL. */
  previews: Record<string, string>;
  /** Laid out as a row above the page instead of a column beside it. */
  stacked: boolean;
  /**
   * The batch being ticked (planTickedBatch); null when pages cannot be
   * added, in which case no page can be ticked.
   */
  plan: BatchPlan | null;
  /** The pages "Select next" ticks: the next batch by default. */
  nextPages: number[];
  /** Why pages cannot be added, when `plan` is null for a reason to tell. */
  blocked?: string;
  /** A render is in progress: nothing can be removed or started. */
  busy: boolean;
  onOpenPage: (page: number) => void;
  onTickPage: (page: number) => void;
  onSelectNext: () => void;
  onClearTicked: () => void;
  /** Translates the ticked pages and adds them to the document. */
  onTranslateTicked: () => void;
  /** Leaves a page out of the download (`true`) or puts it back. */
  onRemovePage: (page: number, removed: boolean) => void;
}

/**
 * Every page of the document as the download will hold it: translated
 * pages, pages still in the source language, and pages removed from the
 * download. From here a person opens a page, removes it or puts it back,
 * and ticks untranslated pages to translate as the next batch.
 */
export function FormattedPageRail({
  run,
  pageCount,
  pdf,
  previews,
  stacked,
  plan,
  nextPages,
  blocked,
  busy,
  onOpenPage,
  onTickPage,
  onSelectNext,
  onClearTicked,
  onTranslateTicked,
  onRemovePage,
}: FormattedPageRailProps) {
  const t = useTranslations('workflows');
  const translated = new Set(translatedPages(run));
  const removed = new Set(removedPages(run));
  const pages = Array.from({ length: pageCount }, (_, index) => index + 1);
  // The last page left stays: a download needs a page.
  const canRemove = pageCount - removed.size > 1;
  const untranslatedLeft = pages.some(
    (page) => !translated.has(page) && !removed.has(page),
  );

  const ticked = plan?.pages ?? [];
  const batchControls = plan ? (
    !untranslatedLeft ? null : plan.allowance === 0 ? (
      <p className="text-[11px] text-gray-500 dark:text-gray-400">
        {t('translation.formatted.pagesLimitReached', {
          max: plan.limits.maxDocumentPages,
        })}
      </p>
    ) : ticked.length > 0 ? (
      <>
        <button
          type="button"
          disabled={busy}
          onClick={onTranslateTicked}
          className="min-h-[32px] rounded-lg bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {t('translation.formatted.translatePages', {
            count: ticked.length,
          })}
        </button>
        <span
          data-testid="rail-batch-summary"
          className="text-[11px] text-gray-500 dark:text-gray-400"
        >
          {t('translation.formatted.batchSummary', {
            selected: ticked.length,
            capacity: plan.capacity,
          })}
        </span>
        <button
          type="button"
          onClick={onClearTicked}
          className="self-start text-[11px] text-blue-700 hover:underline dark:text-blue-300"
        >
          {t('translation.formatted.railClear')}
        </button>
      </>
    ) : (
      nextPages.length > 0 && (
        <>
          <button
            type="button"
            onClick={onSelectNext}
            className="min-h-[32px] rounded-lg border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-surface-dark-elevated"
          >
            {t('translation.formatted.railSelectNext', {
              count: nextPages.length,
            })}
          </button>
          <span className="text-[11px] text-gray-500 dark:text-gray-400">
            {t('translation.formatted.railTickHint')}
          </span>
        </>
      )
    )
  ) : blocked && untranslatedLeft ? (
    <p className="text-[11px] text-gray-500 dark:text-gray-400">{blocked}</p>
  ) : null;

  return (
    <nav
      aria-label={t('translation.formatted.pages')}
      className={`flex shrink-0 gap-3.5 border-gray-200 p-3 dark:border-gray-700 ${
        stacked
          ? 'flex-row overflow-x-auto border-b'
          : 'w-[136px] flex-col overflow-y-auto border-e'
      }`}
    >
      {batchControls && (
        <div
          className={`flex shrink-0 flex-col gap-1.5 ${
            stacked
              ? 'w-28 justify-center'
              : 'sticky top-0 z-10 -mx-3 -mt-3 border-b border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-surface-dark'
          }`}
        >
          {batchControls}
        </div>
      )}
      {pages.map((page) => {
        const current = page === run.page;
        const isRemoved = removed.has(page);
        const isTranslated = translated.has(page);
        const state: BatchPageState | null = plan
          ? batchPageState(plan, page)
          : null;
        const tickable =
          !isRemoved && (state === 'selected' || state === 'available');
        const waiting = !isRemoved && (state === 'later' || state === 'locked');
        const look = isRemoved
          ? 'removed'
          : isTranslated
            ? 'translated'
            : 'untranslated';
        const url = run.pageImages.find(
          (image) => image.page === page,
        )?.previewUrl;
        const edits = run.units.filter(
          (unit) => unit.page === page && unit.id in run.edits,
        ).length;
        const label =
          edits > 0
            ? t('translation.formatted.pageEdits', { page, count: edits })
            : t('translation.formatted.pageLabel', { page });
        const outline = current
          ? 'outline outline-2 outline-offset-2 outline-blue-500'
          : state === 'selected'
            ? 'outline outline-2 outline-offset-2 outline-blue-300 dark:outline-blue-700'
            : '';
        return (
          <div
            key={page}
            data-page={page}
            data-page-look={look}
            data-page-state={state ?? undefined}
            className={`group flex shrink-0 flex-col gap-1 text-[11px] ${
              stacked ? 'w-20' : ''
            }`}
          >
            <span className="relative block">
              <button
                type="button"
                aria-current={current ? 'page' : undefined}
                aria-label={t('translation.formatted.pageLabel', { page })}
                onClick={() => onOpenPage(page)}
                className={`block w-full rounded-sm ${outline}`}
              >
                {isTranslated && url ? (
                  previews[url] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={previews[url]}
                      alt=""
                      className={`w-full rounded-sm ${THUMBNAIL_LOOK[look]}`}
                    />
                  ) : (
                    <span className="block aspect-[210/297] w-full animate-pulse rounded-sm bg-gray-200 dark:bg-surface-dark-elevated" />
                  )
                ) : (
                  <SourceThumbnail
                    page={page}
                    pdf={pdf}
                    className={THUMBNAIL_LOOK[look]}
                  />
                )}
              </button>
              {look !== 'translated' && (
                <span
                  className={`pointer-events-none absolute bottom-1 start-1 rounded-full px-1.5 py-px text-[10px] font-medium ${
                    isRemoved
                      ? 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
                      : 'bg-gray-700 text-white dark:bg-gray-200 dark:text-gray-900'
                  }`}
                >
                  {isRemoved
                    ? t('translation.formatted.pageState.removed')
                    : t('translation.formatted.pageUntranslated')}
                </span>
              )}
              {isRemoved ? (
                <button
                  type="button"
                  disabled={busy}
                  title={t('translation.formatted.restorePage', { page })}
                  aria-label={t('translation.formatted.restorePage', { page })}
                  onClick={() => onRemovePage(page, false)}
                  className="absolute end-1 top-1 rounded-full bg-white p-1 text-gray-700 shadow ring-1 ring-gray-300 hover:bg-gray-100 disabled:opacity-50 dark:bg-surface-dark-elevated dark:text-gray-200 dark:ring-gray-600"
                >
                  <IconArrowBackUp size={12} aria-hidden />
                </button>
              ) : (
                canRemove && (
                  <button
                    type="button"
                    disabled={busy}
                    title={t('translation.formatted.removePage', { page })}
                    aria-label={t('translation.formatted.removePage', { page })}
                    onClick={() => onRemovePage(page, true)}
                    className="absolute end-1 top-1 rounded-full bg-gray-900/70 p-1 text-white opacity-0 hover:bg-gray-900 focus:opacity-100 disabled:opacity-0 group-hover:opacity-100 max-sm:opacity-100"
                  >
                    <IconX size={12} aria-hidden />
                  </button>
                )
              )}
            </span>
            {tickable ? (
              <label className="flex cursor-pointer items-center gap-1.5 text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={state === 'selected'}
                  onChange={() => onTickPage(page)}
                />
                {label}
              </label>
            ) : (
              <span
                title={
                  waiting && plan
                    ? state === 'locked'
                      ? t('translation.formatted.pageReason.locked', {
                          max: plan.limits.maxDocumentPages,
                        })
                      : t('translation.formatted.pageReason.later')
                    : undefined
                }
                className={
                  isRemoved
                    ? 'text-gray-400 line-through dark:text-gray-500'
                    : edits > 0
                      ? 'text-amber-700 dark:text-amber-400'
                      : current
                        ? 'font-semibold text-gray-900 dark:text-gray-100'
                        : 'text-gray-500 dark:text-gray-400'
                }
              >
                {label}
              </span>
            )}
          </div>
        );
      })}
    </nav>
  );
}
