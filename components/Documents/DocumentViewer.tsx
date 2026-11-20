'use client';

import {
  IconChevronLeft,
  IconChevronRight,
  IconZoomIn,
  IconZoomOut,
} from '@tabler/icons-react';
import {
  KeyboardEvent,
  ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { useTranslations } from 'next-intl';

import { usePagePan } from '@/client/hooks/documents/usePagePan';
import { usePageZoom } from '@/client/hooks/documents/usePageZoom';
import { usePdfPages } from '@/client/hooks/documents/usePdfPages';

import { groupKeyTarget, ownsKeyboard } from '@/lib/utils/client/keyboardScope';
import { PageSize } from '@/lib/utils/shared/documents/pageGeometry';

import { DocumentPage, PAGE_WIDTH, PageOverlay } from './DocumentPage';
import { PdfPageThumbnail } from './PageThumbnail';

/** What a page is called on screen: a slide for a presentation. */
export type DocumentUnit = 'page' | 'slide';

/** One version of the document the viewer can show. */
export interface ViewerSource {
  /** Identifies the file; a new key loads a new document. */
  key: string;
  /** Name of this version in the switch ("Original", "Translated"). */
  label: string;
  /** Returns the document as a PDF. */
  load: () => Promise<Blob>;
}

export interface DocumentViewerProps {
  /**
   * One version, or up to two shown one at a time with a switch between
   * them, on the same page.
   */
  sources: [ViewerSource] | [ViewerSource, ViewerSource];
  unit: DocumentUnit;
  /** Boxes over a page of a version (findings, text blocks). */
  overlaysOf?: (page: number, sourceKey: string) => PageOverlay[];
  selectedOverlayId?: string | null;
  onSelectOverlay?: (id: string | null) => void;
  /** The page shown; the viewer keeps its own when absent. */
  page?: number;
  onPageChange?: (page: number) => void;
  /** Shown on a page's thumbnail (a count of findings). */
  pageBadge?: (page: number) => ReactNode;
  /** Beside the page: a panel of the screen using the viewer. */
  aside?: ReactNode;
}

/** Width the page is rendered at when not zoomed, in CSS pixels. */
const PAGE_RENDER_WIDTH = 576;

/**
 * A document's pages, for reading: a list of pages beside the page itself,
 * which can be zoomed and dragged, with boxes over it when the screen using
 * the viewer gives some. Nothing here knows what the document is for.
 *
 * Keys, while the keyboard is in the viewer (see ownsKeyboard):
 *  - Ctrl/Cmd with +, - and 0 zoom the page, not the browser; so do
 *    Ctrl+wheel and a pinch over the page (usePageZoom);
 *  - PageDown and PageUp go to the next and previous page;
 *  - arrow keys, Home and End move within the page list and within the
 *    boxes of a page, each of which is one Tab stop.
 * A zoomed page can be dragged with the mouse (usePagePan).
 */
export function DocumentViewer({
  sources,
  unit,
  overlaysOf,
  selectedOverlayId = null,
  onSelectOverlay,
  page: shownPage,
  onPageChange,
  pageBadge,
  aside,
}: DocumentViewerProps) {
  const t = useTranslations('documents.viewer');
  const [ownPage, setOwnPage] = useState(1);
  const page = shownPage ?? ownPage;
  const [sourceIndex, setSourceIndex] = useState(0);
  const source = sources[Math.min(sourceIndex, sources.length - 1)];
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Each version is loaded once and kept, so switching is immediate.
  const first = usePdfPages(sources[0].load, sources[0].key);
  const second = usePdfPages(
    sources[1]?.load ?? sources[0].load,
    sources[1]?.key ?? null,
    { onDemand: true },
  );
  const pdf = sourceIndex === 1 && sources[1] ? second : first;
  const pageCount = pdf.pageCount;

  const pageZoom = usePageZoom(scrollerRef, rootRef);
  const zoom = pageZoom.zoom;
  const renderWidth = Math.round(PAGE_RENDER_WIDTH * Math.max(zoom, 1));

  const [shown, setShown] = useState<{
    key: string;
    image: string | null;
    size: PageSize | null;
  } | null>(null);
  const shownKey = `${source.key}:${page}:${renderWidth}`;
  useEffect(() => {
    if (pdf.status === 'failed') return;
    let cancelled = false;
    void Promise.all([
      pdf.renderPage(page, renderWidth),
      overlaysOf ? pdf.pageSize(page) : Promise.resolve(null),
    ]).then(([image, size]) => {
      if (!cancelled) setShown({ key: shownKey, image, size });
    });
    return () => {
      cancelled = true;
    };
  }, [pdf, page, renderWidth, overlaysOf, shownKey]);
  const image = shown?.key === shownKey ? shown.image : null;
  const size = shown?.key === shownKey ? shown.size : null;

  const goTo = useCallback(
    (next: number) => {
      const target = Math.min(Math.max(next, 1), Math.max(pageCount, 1));
      if (target === page) return;
      if (shownPage === undefined) setOwnPage(target);
      onPageChange?.(target);
      onSelectOverlay?.(null);
      scrollerRef.current?.scrollTo({ top: 0 });
    },
    [page, pageCount, shownPage, onPageChange, onSelectOverlay],
  );

  // PageDown and PageUp turn pages while the viewer has the keyboard.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || !ownsKeyboard(rootRef.current)) return;
      if (event.key !== 'PageDown' && event.key !== 'PageUp') return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('textarea, input, select, [contenteditable="true"]'))
        return;
      event.preventDefault();
      goTo(page + (event.key === 'PageDown' ? 1 : -1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goTo, page]);

  const { pannable, panning } = usePagePan(
    scrollerRef,
    () => onSelectOverlay?.(null),
    `${shownKey}:${image ? 'shown' : 'loading'}`,
  );

  /** Arrow keys, Home and End move within the page list (one Tab stop). */
  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('button'),
    );
    const from = buttons.indexOf(event.target as HTMLButtonElement);
    if (from < 0) return;
    const to = groupKeyTarget(event.key, from, buttons.length, 'vertical');
    if (to === null) return;
    event.preventDefault();
    buttons[to].focus();
    goTo(to + 1);
  };

  // The current page's thumbnail stays in view as pages are turned.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-page="${page}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [page]);

  const label = (key: string, values: Record<string, unknown> = {}) =>
    t(key, { unit, ...values } as never);

  return (
    <div
      ref={rootRef}
      className="flex h-full min-h-0 flex-col bg-gray-50 dark:bg-surface-dark-base"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-gray-200 px-4 py-2 text-sm dark:border-gray-700">
        {sources.length > 1 && (
          <div
            role="radiogroup"
            aria-label={t('showing')}
            className="inline-flex rounded-md bg-gray-200/70 p-0.5 dark:bg-surface-dark-elevated"
          >
            {sources.map((option, index) => (
              <button
                key={option.key}
                type="button"
                role="radio"
                aria-checked={index === sourceIndex}
                tabIndex={index === sourceIndex ? 0 : -1}
                onClick={() => setSourceIndex(index)}
                onKeyDown={(event) => {
                  const to = groupKeyTarget(
                    event.key,
                    index,
                    sources.length,
                    'horizontal',
                  );
                  if (to === null) return;
                  event.preventDefault();
                  setSourceIndex(to);
                  (
                    event.currentTarget.parentElement?.children[
                      to
                    ] as HTMLElement
                  )?.focus();
                }}
                className={`rounded px-3 py-1 font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 ${
                  index === sourceIndex
                    ? 'bg-white text-gray-900 shadow-sm dark:bg-surface-dark-base dark:text-gray-100'
                    : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => goTo(page - 1)}
            disabled={page <= 1}
            aria-label={label('previous')}
            className="rounded p-1 text-gray-600 hover:bg-gray-200 disabled:opacity-40 dark:text-gray-300 dark:hover:bg-surface-dark-elevated"
          >
            <IconChevronLeft size={18} className="rtl:rotate-180" />
          </button>
          <span
            aria-live="polite"
            className="min-w-[7rem] text-center tabular-nums text-gray-700 dark:text-gray-200"
          >
            {pageCount > 0 ? label('position', { page, count: pageCount }) : ''}
          </span>
          <button
            type="button"
            onClick={() => goTo(page + 1)}
            disabled={pageCount === 0 || page >= pageCount}
            aria-label={label('next')}
            className="rounded p-1 text-gray-600 hover:bg-gray-200 disabled:opacity-40 dark:text-gray-300 dark:hover:bg-surface-dark-elevated"
          >
            <IconChevronRight size={18} className="rtl:rotate-180" />
          </button>
        </div>
        <div className="ms-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => pageZoom.step(-1)}
            disabled={!pageZoom.canZoomOut}
            aria-label={t('zoomOut')}
            className="rounded p-1 text-gray-600 hover:bg-gray-200 disabled:opacity-40 dark:text-gray-300 dark:hover:bg-surface-dark-elevated"
          >
            <IconZoomOut size={18} />
          </button>
          <button
            type="button"
            onClick={pageZoom.reset}
            aria-label={t('zoomReset', { percent: Math.round(zoom * 100) })}
            className="min-w-[3.5rem] rounded px-1 py-0.5 tabular-nums text-gray-700 hover:bg-gray-200 dark:text-gray-200 dark:hover:bg-surface-dark-elevated"
          >
            {t('zoomLevel', { percent: Math.round(zoom * 100) })}
          </button>
          <button
            type="button"
            onClick={() => pageZoom.step(1)}
            disabled={!pageZoom.canZoomIn}
            aria-label={t('zoomIn')}
            className="rounded p-1 text-gray-600 hover:bg-gray-200 disabled:opacity-40 dark:text-gray-300 dark:hover:bg-surface-dark-elevated"
          >
            <IconZoomIn size={18} />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label={label('pageList')}
          className="hidden w-32 shrink-0 overflow-y-auto border-e border-gray-200 p-2 sm:block dark:border-gray-700"
        >
          <ul ref={listRef} onKeyDown={onListKeyDown} className="space-y-3">
            {Array.from({ length: pageCount }, (_, index) => index + 1).map(
              (number) => (
                <li key={number} data-page={number}>
                  <button
                    type="button"
                    onClick={() => goTo(number)}
                    aria-current={number === page ? 'page' : undefined}
                    tabIndex={number === page ? 0 : -1}
                    className={`block w-full rounded p-1 text-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 ${
                      number === page
                        ? 'bg-blue-100 dark:bg-blue-900/40'
                        : 'hover:bg-gray-200 dark:hover:bg-surface-dark-elevated'
                    }`}
                  >
                    <PdfPageThumbnail page={number} pdf={pdf} />
                    <span className="mt-1 flex items-center justify-between gap-1 text-xs text-gray-600 dark:text-gray-300">
                      <span>{label('pageLabel', { page: number })}</span>
                      {pageBadge?.(number)}
                    </span>
                  </button>
                </li>
              ),
            )}
          </ul>
        </nav>

        <div
          ref={scrollerRef}
          className={`min-w-0 flex-1 overflow-auto p-4 ${
            pannable ? (panning ? 'cursor-grabbing' : 'cursor-grab') : ''
          }`}
        >
          {pdf.status === 'failed' ? (
            <p
              role="alert"
              className="mx-auto mt-16 max-w-sm text-center text-sm text-gray-600 dark:text-gray-300"
            >
              {t('failed')}
            </p>
          ) : (
            <DocumentPage
              image={image}
              imageLabel={label('pageLabel', { page })}
              loadingLabel={label('loadingPage', { page })}
              size={size}
              overlays={overlaysOf?.(page, source.key) ?? []}
              selectedId={selectedOverlayId}
              onSelect={(id) => onSelectOverlay?.(id)}
              width={`calc(${PAGE_WIDTH} * ${zoom})`}
            />
          )}
        </div>

        {aside && (
          <aside className="w-80 shrink-0 overflow-y-auto border-s border-gray-200 dark:border-gray-700">
            {aside}
          </aside>
        )}
      </div>
    </div>
  );
}
