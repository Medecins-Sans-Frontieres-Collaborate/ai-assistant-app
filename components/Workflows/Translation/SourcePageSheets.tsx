'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { SourcePage } from '@/lib/utils/shared/translation/pageBatches';
import { nearestPage } from '@/lib/utils/shared/translation/pageSheets';

interface SourcePageSheetsProps {
  /** Pages to show, in document order; page numbers may have gaps. */
  pages: SourcePage[];
  /** Highest page number in the document, for "Page 3 of 409". */
  lastPage: number;
}

/**
 * How far below the pane's top edge a sheet must reach to count as the page
 * being read. Used only to find the current page, never to position one.
 */
const CURRENT_PAGE_PROBE_PX = 24;

/** Height a sheet is assumed to have until the browser has laid it out. */
const ESTIMATED_SHEET_SIZE = 'auto 14rem';

/**
 * A document's source text shown as separate page sheets rather than one
 * run of text: each page is a card with its number as a label outside the
 * text, so a page number can never be mistaken for content.
 *
 * A marker in the corner says which page is in view and of how many; it
 * opens a field to jump to a page. Sheets off screen are skipped by the
 * browser (`content-visibility`), so a document of hundreds of pages stays
 * quick to scroll. Read-only: editing happens in the text view.
 */
export function SourcePageSheets({ pages, lastPage }: SourcePageSheetsProps) {
  const t = useTranslations('workflows');
  const scrollerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  const [currentPage, setCurrentPage] = useState(pages[0]?.page ?? 1);
  const [jumping, setJumping] = useState(false);
  const [draft, setDraft] = useState('');

  const sheetFor = (page: number) =>
    scrollerRef.current?.querySelector<HTMLElement>(
      `[data-source-page="${page}"]`,
    ) ?? null;

  /** The first sheet that still reaches below the probe line is in view. */
  const measureCurrentPage = useCallback(() => {
    frameRef.current = null;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const probe = scroller.getBoundingClientRect().top + CURRENT_PAGE_PROBE_PX;
    for (const sheet of scroller.querySelectorAll<HTMLElement>(
      '[data-source-page]',
    )) {
      if (sheet.getBoundingClientRect().bottom > probe) {
        setCurrentPage(Number(sheet.dataset.sourcePage));
        return;
      }
    }
  }, []);

  const handleScroll = () => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(measureCurrentPage);
  };

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  const handleJump = (event: FormEvent) => {
    event.preventDefault();
    setJumping(false);
    const wanted = Number.parseInt(draft, 10);
    if (!Number.isFinite(wanted)) return;
    const target = nearestPage(pages, wanted);
    if (target === null) return;
    setCurrentPage(target);
    const scrollToTarget = () =>
      sheetFor(target)?.scrollIntoView?.({ block: 'start' });
    scrollToTarget();
    // Sheets above the target get their real height once scrolled past,
    // which moves it: settle on it again after that layout.
    requestAnimationFrame(scrollToTarget);
  };

  const shownPage = pages.some((page) => page.page === currentPage)
    ? currentPage
    : (pages[0]?.page ?? 1);

  return (
    <div
      ref={scrollerRef}
      onScroll={handleScroll}
      data-testid="source-page-sheets"
      className="relative min-h-0 flex-1 overflow-y-auto px-3 pb-3"
    >
      <div className="pointer-events-none sticky top-2 z-10 flex h-0 justify-end">
        {jumping ? (
          <form
            onSubmit={handleJump}
            className="pointer-events-auto flex h-7 items-center gap-1.5 rounded-full border border-gray-300 bg-white px-2.5 text-xs text-gray-700 shadow-sm dark:border-gray-600 dark:bg-surface-dark-elevated dark:text-gray-200"
          >
            <label htmlFor="source-page-jump">
              {t('translation.pageLabel')}
            </label>
            <input
              id="source-page-jump"
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => setJumping(false)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setJumping(false);
              }}
              inputMode="numeric"
              autoComplete="off"
              className="w-10 bg-transparent text-center text-gray-900 focus:outline-none dark:text-gray-100"
            />
            <span>{t('translation.pageOf', { total: String(lastPage) })}</span>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => {
              setDraft(String(shownPage));
              setJumping(true);
            }}
            title={t('translation.sourceJumpToPage')}
            className="pointer-events-auto h-7 rounded-full border border-gray-300 bg-white px-2.5 text-xs text-gray-700 shadow-sm hover:bg-gray-100 dark:border-gray-600 dark:bg-surface-dark-elevated dark:text-gray-200 dark:hover:bg-gray-700"
          >
            {t('translation.pageLabel')} {shownPage}{' '}
            {t('translation.pageOf', { total: String(lastPage) })}
          </button>
        )}
      </div>
      <ol className="space-y-4 pt-2">
        {pages.map((page) => (
          <li key={page.page} data-source-page={page.page}>
            <p className="mb-1 ps-1 text-xs text-gray-500 dark:text-gray-400">
              {t('translation.pageLabel')} {page.page}
            </p>
            <div
              dir="auto"
              style={{
                contentVisibility: 'auto',
                containIntrinsicSize: ESTIMATED_SHEET_SIZE,
              }}
              className="whitespace-pre-wrap rounded-lg border border-gray-200 bg-white px-5 py-4 text-sm leading-relaxed text-gray-900 shadow-sm dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100"
            >
              {page.text}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
