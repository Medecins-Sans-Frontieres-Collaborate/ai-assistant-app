'use client';

import { IconZoomIn, IconZoomOut } from '@tabler/icons-react';
import { KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { FormattedDocumentController } from '@/client/hooks/workflows/useFormattedDocument';
import { usePagePan } from '@/client/hooks/workflows/usePagePan';
import { usePageZoom } from '@/client/hooks/workflows/usePageZoom';
import { PdfPages } from '@/client/hooks/workflows/usePdfPages';
import {
  usePrefetchRunImages,
  useRunImage,
} from '@/client/hooks/workflows/useRunImage';

import { downloadRunFile } from '@/client/services/workflows/nativeRunStorage';
import { prefetchOrder } from '@/client/services/workflows/runImageLoader';

import {
  isEditableTarget,
  ownsKeyboard,
} from '@/lib/utils/client/keyboardScope';
import { isRtlElement } from '@/lib/utils/client/textDirection';
import {
  FormattedDocumentRun,
  batchPageState,
  changedUnits,
  currentTranslation,
  fitEstimate,
  issueKey,
  openIssues,
  plainText,
  planBatch,
  planTickedBatch,
  removalPending,
  removedPages,
  restyledUnits,
  retagEditedText,
  stalePages,
  textRows,
  translatedPages,
  unitStyle,
  withPageRemoved,
  withUnitEdit,
  withUnitStyle,
} from '@/lib/utils/shared/translation/formattedDocument';
import { translatedFileName } from '@/lib/utils/shared/translation/languages';
import { NATIVE_SOURCE_CONTENT_TYPES } from '@/lib/utils/shared/translation/nativeFormats';
import {
  NATIVE_PDF_EXPORT_FORMATS,
  NativePdfIssue,
  NativePdfLimits,
  NativePdfStepInstructions,
  NativePdfUnitAction,
  NativePdfUnitResult,
  SCALE_EPSILON,
} from '@/lib/utils/shared/translation/nativePdf';
import { NativeRunRef } from '@/lib/utils/shared/translation/nativeRunStorage';

import { FormattedBlockActions } from './FormattedBlockActions';
import { FormattedBlockStyle } from './FormattedBlockStyle';
import {
  FormattedDownloadFormat,
  FormattedDownloadMenu,
  downloadFormatsOf,
} from './FormattedDownloadMenu';
import { FormattedPageRail } from './FormattedPageRail';
import {
  FormattedPageView,
  PAGE_WIDTH,
  UNIT_ATTRIBUTE,
  UNIT_PLACE_ATTRIBUTE,
} from './FormattedPageView';
import {
  FormattedRunExpiryWarning,
  FormattedRunStorageLine,
} from './FormattedRunStorageNotice';
import { useFormattedUnit, useUnitWording } from './formattedWording';

import { formatKeys } from '@/lib/constants/keyboardShortcuts';

type Filter = 'all' | 'shrunk' | 'kept' | 'edited';
type PageSide = 'translated' | 'original';
/**
 * Where a block was chosen: on the page, in the block list, or from a
 * finding. Its field opens with the keyboard on the side it was chosen
 * from, and closing it puts the keyboard back there.
 */
type ChosenFrom = 'page' | 'list';

/** Width the original page is rendered at, in CSS pixels. */
const ORIGINAL_WIDTH = 576;

/** What the page list needs to translate more pages of the document. */
export interface FormattedReviewBatch {
  /** The person's limits. */
  limits: NativePdfLimits;
  /** Pages per batch the person chose, if any. */
  batchPages?: number;
  /** Translates the pages and adds them to this run. */
  onTranslate: (pages: number[]) => void;
}

interface FormattedReviewProps {
  run: FormattedDocumentRun;
  /** Pages in the source document, as far as the workspace knows. */
  pageCount: number;
  /** Present when pages can be added to the run from the page list. */
  batch?: FormattedReviewBatch;
  /** Why pages cannot be added, when there is a reason worth telling. */
  batchBlocked?: string;
  controller: FormattedDocumentController;
  /** The source document, for the Original view. */
  pdf: PdfPages;
  /** Step instructions of the run; the layout check's applies to re-renders. */
  instructions: NativePdfStepInstructions;
  glossaryCount: number;
  /** Not enough width for page and blocks side by side. */
  stacked: boolean;
  /** Where the run is stored, and what keeps it there. */
  storage?: {
    runRef: NativeRunRef;
    /** The last save did not reach storage. */
    saveFailed: boolean;
    /** A keep request is in flight. */
    keeping: boolean;
    /** Keeps the run's files for another retention period. */
    onKeep: () => void;
  };
  onUpdateRun: (
    update: (run: FormattedDocumentRun) => FormattedDocumentRun,
  ) => void;
  /** Opens the setup again, to translate with other choices. */
  onChangeOptions: () => void;
}

/** Scroll left at the end of the page pane that still counts as the end. */
const SCROLL_END_TOLERANCE_PX = 2;

/**
 * A block's element inside `container`, marked UNIT_ATTRIBUTE: its button
 * on the page or in the list (`place`), or anything of it when no place.
 */
function unitElement(
  container: HTMLElement | null,
  id: string,
  place?: ChosenFrom,
): HTMLElement | null {
  const marked = container?.querySelectorAll<HTMLElement>(
    `[${UNIT_ATTRIBUTE}]`,
  );
  return (
    Array.from(marked ?? []).find(
      (element) =>
        element.getAttribute(UNIT_ATTRIBUTE) === id &&
        (!place || element.getAttribute(UNIT_PLACE_ATTRIBUTE) === place),
    ) ?? null
  );
}

/**
 * A block's number in the block list. Its colour carries the block's state,
 * as the page does: blue when selected (the badge beside it on the page),
 * amber when changed (its amber outline there).
 */
const BLOCK_NUMBER =
  'inline-flex min-w-[1.25rem] justify-center rounded px-1 py-px text-[11px] font-semibold tabular-nums';

const isShrunk = (unit: NativePdfUnitResult): boolean =>
  unit.scale !== null && unit.scale < 1 - SCALE_EPSILON;

/**
 * A finished formatted translation: its pages, the text blocks of the page
 * in view, and everything a person can do to them. Text is typed either on
 * the page or in the block list (one edit, two places); edits wait in a
 * banner until the pages are re-rendered.
 *
 * The page list shows the whole document as the download will hold it.
 * Pages can be removed from the download or put back (pending in the same
 * banner as edits), and untranslated pages can be ticked and translated as
 * the next batch.
 *
 * Keys, while the keyboard is in the review (see ownsKeyboard):
 *  - Ctrl/Cmd with +, - and 0 zoom the page, not the browser; so do
 *    Ctrl+wheel and a pinch over the page (usePageZoom);
 *  - Escape closes a block's field, back to the block it was opened from;
 *  - PageDown and PageUp scroll the page, and past its end go to the next
 *    or previous page;
 *  - arrow keys move within the page list, the blocks of a page, and the
 *    Original/Translated switch, each of which is one Tab stop.
 * A zoomed page can be dragged with the mouse (usePagePan).
 */
export function FormattedReview({
  run,
  pageCount,
  batch,
  batchBlocked,
  controller,
  pdf,
  instructions,
  glossaryCount,
  stacked,
  storage,
  onUpdateRun,
  onChangeOptions,
}: FormattedReviewProps) {
  const t = useTranslations('workflows');
  const unitT = useUnitWording();
  const unitIsSlide = useFormattedUnit() === 'slide';
  const [side, setSide] = useState<PageSide>('translated');
  const [outlines, setOutlines] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [chosenFrom, setChosenFrom] = useState<ChosenFrom>('page');
  const [draft, setDraft] = useState<{ id: string; text: string } | null>(null);
  const [checkAfter, setCheckAfter] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [original, setOriginal] = useState<{
    page: number;
    image: string | null;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const sideRefs = useRef<Record<PageSide, HTMLButtonElement | null>>({
    original: null,
    translated: null,
  });
  // The block whose button gets the keyboard back once its field closes.
  const returnFocus = useRef<{ id: string; place: ChosenFrom } | null>(null);
  const pageZoom = usePageZoom(scrollerRef, rootRef);
  const zoom = pageZoom.zoom;
  const [download, setDownload] = useState<FormattedDownloadFormat | null>(
    null,
  );
  const [downloadFailed, setDownloadFailed] = useState(false);
  // Untranslated pages ticked in the page list for the next batch.
  const [ticked, setTicked] = useState<number[]>([]);

  const pageStats = run.pages.find((page) => page.page === run.page);
  // A page without a translation has only its original to show.
  const untranslated = !pageStats;
  const showOriginal = side === 'original' || untranslated;
  const pageTotal = Math.max(pageCount, run.pageCount, pdf.pageCount);
  const donePages = useMemo(() => translatedPages(run), [run]);
  const removed = useMemo(() => removedPages(run), [run]);
  const batchInput = batch && {
    pageCount: pageTotal,
    translated: donePages,
    removed,
    batchPages: batch.batchPages,
    limits: batch.limits,
  };
  const tickedPlan = batchInput
    ? planTickedBatch({ ...batchInput, ticked })
    : null;
  const nextPages = batchInput
    ? planBatch({ ...batchInput, spec: '' }).pages
    : [];
  const pagesPending = removalPending(run);
  const pageWidth = `calc(${PAGE_WIDTH} * ${zoom})`;
  // Zoomed in, the original is rendered with more pixels to stay sharp.
  const originalWidth = Math.round(ORIGINAL_WIDTH * Math.max(zoom, 1));

  useEffect(() => {
    // The source document loads on this first use (see usePdfPages).
    if (!showOriginal || pdf.status === 'failed') return;
    let cancelled = false;
    void pdf.renderPage(run.page, originalWidth).then((image) => {
      if (!cancelled) setOriginal({ page: run.page, image });
    });
    return () => {
      cancelled = true;
    };
  }, [showOriginal, pdf, run.page, originalWidth]);

  const pageUnits = useMemo(
    () => run.units.filter((unit) => unit.page === run.page),
    [run.units, run.page],
  );
  const previewUrl = run.pageImages.find(
    (image) => image.page === run.page,
  )?.previewUrl;
  // PAGE IMAGES (runImageLoader.ts): the page on screen first; once it is
  // there, the pages either side, then the rest of the document.
  const translatedImage = useRunImage(previewUrl, 'now');
  const pageImageShown = !previewUrl || translatedImage !== null;
  const prefetch = useMemo(
    () =>
      prefetchOrder(
        run.pageImages.map((image) => ({
          page: image.page,
          url: image.previewUrl,
        })),
        run.page,
      ),
    [run.pageImages, run.page],
  );
  usePrefetchRunImages(prefetch.near, 'soon', pageImageShown);
  usePrefetchRunImages(prefetch.rest, 'later', pageImageShown);
  const image = showOriginal
    ? original?.page === run.page
      ? original.image
      : null
    : translatedImage;

  const stale = stalePages(run);
  const pdfBehind = stale.length > 0 || pagesPending;
  // Blocks that differ from the page, in their text or their look.
  const editCount = changedUnits(run).length;
  const restyled = useMemo(
    () => new Set(restyledUnits(run).map((unit) => unit.id)),
    [run],
  );
  const isChanged = (unit: NativePdfUnitResult): boolean =>
    unit.id in run.edits || restyled.has(unit.id);
  const issues = openIssues(run, run.page);
  const selected = pageUnits.find((unit) => unit.id === selectedId) ?? null;
  const counts = {
    all: pageUnits.length,
    shrunk: pageUnits.filter((unit) => !isChanged(unit) && isShrunk(unit))
      .length,
    kept: pageUnits.filter((unit) => currentTranslation(run, unit) === null)
      .length,
    edited: pageUnits.filter(isChanged).length,
  };
  const matches: Record<Filter, (unit: NativePdfUnitResult) => boolean> = {
    all: () => true,
    shrunk: (unit) => !isChanged(unit) && isShrunk(unit),
    kept: (unit) => currentTranslation(run, unit) === null,
    edited: isChanged,
  };

  /** Text of a block as shown in a field: its translation, or its source. */
  const fieldText = (unit: NativePdfUnitResult): string =>
    draft?.id === unit.id
      ? draft.text
      : plainText(currentTranslation(run, unit) ?? unit.source);
  /** Records what was typed, putting the block's formatting tags back. */
  const type = (unit: NativePdfUnitResult, text: string) => {
    setDraft({ id: unit.id, text });
    const base = currentTranslation(run, unit) ?? unit.source;
    onUpdateRun((latest) =>
      withUnitEdit(
        latest,
        unit.id,
        text.trim() ? retagEditedText(base, text).text : null,
      ),
    );
  };
  const select = (id: string | null, from: ChosenFrom = 'page') => {
    setSelectedId(id);
    setChosenFrom(from);
    setDraft(null);
  };
  /** Closes the selected block's field; the keyboard goes back to it. */
  const deselect = (place: ChosenFrom) => {
    if (selectedId) returnFocus.current = { id: selectedId, place };
    select(null);
  };
  const ask = async (
    unit: NativePdfUnitResult,
    action: NativePdfUnitAction,
    instruction?: string,
  ) => {
    await controller.reviseUnit(
      unit,
      action,
      currentTranslation(run, unit),
      instruction,
    );
    setDraft(null);
  };
  const goToPage = (page: number) => {
    select(null);
    onUpdateRun((latest) => ({ ...latest, page }));
  };
  const dismiss = (issue: NativePdfIssue) =>
    onUpdateRun((latest) => ({
      ...latest,
      dismissed: [...latest.dismissed, issueKey(issue)],
    }));
  const discard = () => {
    setDraft(null);
    onUpdateRun((latest) => ({
      ...latest,
      edits: {},
      styles: latest.pdfStyles,
    }));
  };
  /** Ticks a page for the next batch, or unticks it. */
  const tickPage = (page: number) =>
    setTicked((current) => {
      const kept = tickedPlan?.pages ?? current;
      return kept.includes(page)
        ? kept.filter((other) => other !== page)
        : [...kept, page];
    });
  const removePage = (page: number, remove: boolean) => {
    if (remove) setTicked((current) => current.filter((p) => p !== page));
    onUpdateRun((latest) => withPageRemoved(latest, page, remove, pageTotal));
  };
  /** Puts the page list back to what the download holds. */
  const undoPageChanges = () =>
    onUpdateRun((latest) => ({
      ...latest,
      removedPages: latest.pdfRemovedPages,
    }));
  const pageRemoved = removed.includes(run.page);
  const pageBatchState = tickedPlan
    ? batchPageState(tickedPlan, run.page)
    : null;
  const pageTranslatable =
    untranslated &&
    (pageBatchState === 'selected' || pageBatchState === 'available');

  // A closed field hands the keyboard back to its block's button.
  useEffect(() => {
    const target = returnFocus.current;
    if (!target || selectedId !== null) return;
    returnFocus.current = null;
    unitElement(rootRef.current, target.id, target.place)?.focus();
  }, [selectedId]);

  // A block chosen on one side is brought into sight on the other.
  useEffect(() => {
    if (!selectedId) return;
    const other =
      chosenFrom === 'list'
        ? unitElement(scrollerRef.current, selectedId)
        : stacked
          ? null
          : unitElement(listRef.current, selectedId);
    other?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [selectedId, chosenFrom, stacked]);

  const zoomInKeys = formatKeys(['ctrl'], '+');
  const zoomOutKeys = formatKeys(['ctrl'], '-');
  const zoomResetKeys = formatKeys(['ctrl'], '0');

  /** Escape closes a field (see the keys above), once nothing nearer did. */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape' && selectedId) {
      event.preventDefault();
      const inList = listRef.current?.contains(event.target as Node);
      deselect(inList ? 'list' : 'page');
      return;
    }
    if (event.key === 'PageDown' || event.key === 'PageUp') {
      turnPage(event, event.key === 'PageDown' ? 1 : -1);
    }
  };
  /**
   * PageDown/PageUp in the page pane: the browser scrolls the page; at its
   * end, the next (or previous) page opens at its top.
   */
  const turnPage = (event: KeyboardEvent, direction: 1 | -1) => {
    const scroller = scrollerRef.current;
    if (stacked || !scroller || event.altKey || event.ctrlKey) return;
    if (event.metaKey || event.shiftKey || isEditableTarget(event.target)) {
      return;
    }
    if (!scroller.contains(event.target as Node)) return;
    if (!ownsKeyboard(rootRef.current)) return;
    const atEnd =
      direction > 0
        ? scroller.scrollTop + scroller.clientHeight >=
          scroller.scrollHeight - SCROLL_END_TOLERANCE_PX
        : scroller.scrollTop <= SCROLL_END_TOLERANCE_PX;
    const next = run.page + direction;
    if (!atEnd || next < 1 || next > pageTotal) return;
    event.preventDefault();
    goToPage(next);
    scroller.scrollTop = 0;
    scroller.focus({ preventScroll: true });
  };
  /** Arrow keys move the Original/Translated switch, as a radio group does. */
  const onSideKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const forward = ['ArrowRight', 'ArrowDown'].includes(event.key);
    const back = ['ArrowLeft', 'ArrowUp'].includes(event.key);
    if (!forward && !back) return;
    event.preventDefault();
    const rtl = isRtlElement(event.currentTarget);
    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
    const toTranslated = horizontal && rtl ? back : forward;
    const next: PageSide = toTranslated ? 'translated' : 'original';
    if (sideRefs.current[next]?.disabled) return;
    setSide(next);
    sideRefs.current[next]?.focus();
  };
  const { pannable, panning } = usePagePan(
    scrollerRef,
    () => {
      if (selectedId) select(null);
    },
    `${run.page}:${zoom}:${side}`,
  );

  const actionsFor = (unit: NativePdfUnitResult, compact: boolean) => (
    <FormattedBlockActions
      compact={compact}
      kept={currentTranslation(run, unit) === null}
      edited={unit.id in run.edits}
      busy={controller.busyUnitId === unit.id}
      disabled={controller.busyUnitId !== null || controller.rendering}
      onShorten={() => void ask(unit, 'shorten')}
      onChange={(instruction) => void ask(unit, 'change', instruction)}
      onTranslate={() => void ask(unit, 'translate')}
      onKeep={() => {
        setDraft(null);
        onUpdateRun((latest) => withUnitEdit(latest, unit.id, null));
      }}
      onRestore={() => {
        setDraft(null);
        onUpdateRun((latest) =>
          withUnitEdit(latest, unit.id, unit.translation),
        );
      }}
      onDone={compact ? () => deselect('page') : undefined}
    />
  );

  const duration = run.steps.reduce((sum, step) => sum + step.durationMs, 0);
  const pill = (active: boolean) =>
    `rounded-full border px-2.5 py-1 text-xs ${
      active
        ? 'border-blue-500 bg-blue-50 text-blue-900 dark:bg-blue-950 dark:text-blue-100'
        : 'border-gray-300 text-gray-700 dark:border-gray-600 dark:text-gray-300'
    }`;
  const segment = (active: boolean) =>
    `rounded-md px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${
      active
        ? 'bg-white text-gray-900 dark:bg-surface-dark dark:text-gray-100'
        : 'text-gray-600 dark:text-gray-400'
    }`;

  /**
   * Saves the run in a format. The PDF is the stored one. An editable
   * format (EDITABLE DOWNLOADS in nativePdf.ts) is the stored one too while
   * it describes the page as it stands; otherwise it is built first, by a
   * render with the person's pending changes.
   */
  const downloadAs = async (format: FormattedDownloadFormat) => {
    setDownload(format);
    setDownloadFailed(false);
    const named = (extension: string): string =>
      translatedFileName(run.sourceName, run.targetLanguage, extension);
    try {
      if (format === 'pdf') {
        if (!run.pdfUrl) {
          setDownloadFailed(true);
          return;
        }
        await downloadRunFile(run.pdfUrl, named('pdf'));
        return;
      }
      if (format === 'document') {
        // A presentation's deck is rebuilt by every render, so changes not
        // on the page yet are put in by one first.
        const url = pdfBehind
          ? (await controller.rerender(false, {}))?.documentUrl
          : run.documentUrl;
        const kind = run.format;
        if (!url || !kind || kind === 'pdf') {
          setDownloadFailed(true);
          return;
        }
        await downloadRunFile(
          url,
          named(kind),
          NATIVE_SOURCE_CONTENT_TYPES[kind],
        );
        return;
      }
      const stored = pdfBehind ? undefined : run.exportUrls?.[format];
      const url =
        stored ??
        (await controller.rerender(false, {}, [format]))?.exportUrls?.[format];
      if (!url) {
        setDownloadFailed(true);
        return;
      }
      const { extension, contentType } = NATIVE_PDF_EXPORT_FORMATS[format];
      await downloadRunFile(url, named(extension), contentType);
    } catch {
      setDownloadFailed(true);
    } finally {
      setDownload(null);
    }
  };

  return (
    <div
      ref={rootRef}
      onKeyDown={onKeyDown}
      className="flex min-h-0 flex-1 flex-col"
    >
      {storage && (
        <FormattedRunExpiryWarning
          expiresAt={storage.runRef.expiresAt}
          keeping={storage.keeping}
          onKeep={storage.onKeep}
        />
      )}
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 border-b border-gray-200 px-3 py-1.5 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
        <span className="max-w-[16rem] truncate font-medium text-gray-700 dark:text-gray-300">
          {run.sourceName}
        </span>
        <span>
          {run.depth === 'reviewed'
            ? t('translation.formatted.summaryReviewed', {
                language: run.targetLanguage,
              })
            : t('translation.formatted.summaryQuick', {
                language: run.targetLanguage,
              })}
        </span>
        {glossaryCount > 0 && (
          <span>
            {t('translation.glossariesButton', {
              count: String(glossaryCount),
            })}
          </span>
        )}
        <button
          type="button"
          onClick={onChangeOptions}
          className="text-blue-700 hover:underline dark:text-blue-300"
        >
          {t('translation.formatted.changeOptions')}
        </button>
        {storage && (
          <FormattedRunStorageLine
            runRef={storage.runRef}
            saveFailed={storage.saveFailed}
          />
        )}
        {pdfBehind && (
          <span className="ms-auto text-amber-700 dark:text-amber-400">
            {stale.length > 0
              ? t('translation.formatted.pdfBehind')
              : t('translation.formatted.pdfBehindPages')}
          </span>
        )}
        {downloadFailed && (
          <span role="alert" className="text-red-700 dark:text-red-400">
            {t('translation.formatted.downloadFailed')}
          </span>
        )}
        <FormattedDownloadMenu
          formats={downloadFormatsOf(run)}
          documentExtension={run.format}
          busy={download}
          disabled={controller.rendering && download === null}
          behind={pdfBehind}
          onSelect={(format) => void downloadAs(format)}
          className={pdfBehind || downloadFailed ? '' : 'ms-auto'}
        />
      </div>

      <div
        className={`flex min-h-0 flex-1 ${
          stacked ? 'flex-col overflow-y-auto' : 'flex-row'
        }`}
      >
        <FormattedPageRail
          run={run}
          pageCount={pageTotal}
          pdf={pdf}
          stacked={stacked}
          plan={tickedPlan}
          nextPages={nextPages}
          blocked={batchBlocked}
          busy={controller.rendering}
          onOpenPage={goToPage}
          onTickPage={tickPage}
          onSelectNext={() => setTicked(nextPages)}
          onClearTicked={() => setTicked([])}
          onTranslateTicked={() =>
            tickedPlan && batch?.onTranslate(tickedPlan.pages)
          }
          onRemovePage={removePage}
        />

        <section
          className={`flex min-w-0 flex-col border-gray-200 dark:border-gray-700 ${
            stacked ? 'border-b' : 'min-h-0 flex-1 border-e'
          }`}
        >
          <div className="flex flex-wrap items-center gap-2.5 px-3 py-2">
            <div
              role="radiogroup"
              aria-label={t('translation.formatted.viewLabel')}
              onKeyDown={onSideKeyDown}
              className="flex rounded-lg bg-gray-100 p-0.5 dark:bg-surface-dark-elevated"
            >
              <button
                type="button"
                role="radio"
                ref={(element) => {
                  sideRefs.current.original = element;
                }}
                aria-checked={showOriginal}
                tabIndex={showOriginal ? 0 : -1}
                disabled={pdf.status === 'failed'}
                title={
                  pdf.status === 'failed'
                    ? unitT('previewsUnavailable')
                    : undefined
                }
                onClick={() => setSide('original')}
                className={segment(showOriginal)}
              >
                {t('translation.formatted.viewOriginal')}
              </button>
              <button
                type="button"
                role="radio"
                ref={(element) => {
                  sideRefs.current.translated = element;
                }}
                aria-checked={!showOriginal}
                tabIndex={showOriginal ? -1 : 0}
                disabled={untranslated}
                onClick={() => setSide('translated')}
                className={segment(!showOriginal)}
              >
                {t('translation.formatted.viewTranslated')}
              </button>
            </div>
            <div
              role="group"
              aria-label={t('translation.formatted.zoom')}
              className="flex items-center rounded-lg bg-gray-100 p-0.5 dark:bg-surface-dark-elevated"
            >
              <button
                type="button"
                aria-label={t('translation.formatted.zoomOut')}
                aria-keyshortcuts="Control+Minus Meta+Minus"
                title={`${t('translation.formatted.zoomOut')} (${zoomOutKeys})`}
                disabled={!pageZoom.canZoomOut}
                onClick={() => pageZoom.step(-1)}
                className="rounded-md p-1 text-gray-600 hover:bg-white disabled:opacity-40 dark:text-gray-300 dark:hover:bg-surface-dark"
              >
                <IconZoomOut size={15} aria-hidden />
              </button>
              <button
                type="button"
                title={`${t('translation.formatted.zoomReset')} (${zoomResetKeys})`}
                aria-label={t('translation.formatted.zoomReset')}
                aria-keyshortcuts="Control+0 Meta+0"
                onClick={pageZoom.reset}
                className="min-w-[3rem] rounded-md px-1 py-1 text-xs tabular-nums text-gray-700 hover:bg-white dark:text-gray-200 dark:hover:bg-surface-dark"
              >
                <span data-testid="zoom-level">
                  {t('translation.formatted.zoomLevel', {
                    percent: Math.round(zoom * 100),
                  })}
                </span>
              </button>
              <button
                type="button"
                aria-label={t('translation.formatted.zoomIn')}
                aria-keyshortcuts="Control+Plus Meta+Plus"
                title={`${t('translation.formatted.zoomIn')} (${zoomInKeys})`}
                disabled={!pageZoom.canZoomIn}
                onClick={() => pageZoom.step(1)}
                className="rounded-md p-1 text-gray-600 hover:bg-white disabled:opacity-40 dark:text-gray-300 dark:hover:bg-surface-dark"
              >
                <IconZoomIn size={15} aria-hidden />
              </button>
              <span aria-live="polite" className="sr-only">
                {t('translation.formatted.zoomLevel', {
                  percent: Math.round(zoom * 100),
                })}
              </span>
            </div>
            <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
              <input
                type="checkbox"
                checked={outlines}
                onChange={(event) => setOutlines(event.target.checked)}
              />
              {t('translation.formatted.outlines')}
            </label>
            <span
              className={`ms-auto text-xs ${
                stale.includes(run.page)
                  ? 'text-amber-700 dark:text-amber-400'
                  : 'text-gray-500 dark:text-gray-400'
              }`}
            >
              {untranslated
                ? ''
                : pageRemoved
                  ? unitT('pageRemovedNote')
                  : stale.includes(run.page)
                    ? t('translation.formatted.lastRender')
                    : t('translation.formatted.clickToEdit')}
            </span>
          </div>
          <div
            ref={scrollerRef}
            data-testid="page-scroller"
            role="region"
            aria-label={unitT('pageLabel', {
              page: run.page,
            })}
            tabIndex={0}
            className={`flex bg-gray-100 px-4 pb-5 pt-2 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-600 dark:bg-black/20 ${
              stacked ? '' : 'min-h-0 flex-1 overflow-auto'
            } ${panning ? 'cursor-grabbing select-none' : pannable ? 'cursor-grab' : ''}`}
          >
            {untranslated &&
              (image ? (
                // A rendered page of the user's own file, as a data URL.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={image}
                  alt={unitT('pageLabel', {
                    page: run.page,
                  })}
                  data-testid="untranslated-page"
                  style={{ width: pageWidth }}
                  className={`mx-auto h-fit shrink-0 shadow ${
                    pageRemoved ? 'opacity-40 grayscale' : ''
                  }`}
                />
              ) : (
                <span
                  style={{ width: pageWidth }}
                  className="mx-auto block aspect-[210/297] shrink-0 animate-pulse bg-gray-200 dark:bg-surface-dark-elevated"
                />
              ))}
            {pageStats && (
              <FormattedPageView
                image={image}
                page={pageStats}
                units={pageUnits}
                edits={run.edits}
                styles={run.styles}
                restyled={restyled}
                width={pageWidth}
                selectedId={selectedId}
                outlines={outlines}
                draft={
                  selected && side === 'translated' ? fieldText(selected) : null
                }
                toolbar={selected ? actionsFor(selected, true) : undefined}
                focusField={chosenFrom === 'page'}
                onSelect={(id) => select(id, 'page')}
                onDraftChange={(text) => selected && type(selected, text)}
              />
            )}
          </div>
        </section>

        <section
          className={`flex min-w-0 flex-col ${
            stacked ? '' : 'min-h-0 w-[26rem] max-w-[40%] shrink-0'
          }`}
        >
          {(editCount > 0 || pagesPending) && (
            <div
              data-testid="pending-changes"
              className="border-b border-amber-300 bg-amber-50 px-3 py-2.5 dark:border-amber-700/60 dark:bg-amber-950/40"
            >
              <div className="flex flex-wrap items-center gap-2.5">
                <div className="min-w-[11rem] flex-1">
                  {editCount > 0 && (
                    <div className="text-sm font-medium text-amber-900 dark:text-amber-200">
                      {t('translation.formatted.editsPending', {
                        count: editCount,
                      })}
                    </div>
                  )}
                  {pagesPending && (
                    <div className="text-sm font-medium text-amber-900 dark:text-amber-200">
                      {t('translation.formatted.pagesPending')}
                    </div>
                  )}
                  <div className="text-xs text-amber-800 dark:text-amber-200/80">
                    {t('translation.formatted.rerenderNote')}
                  </div>
                </div>
                {editCount > 0 && (
                  <button
                    type="button"
                    disabled={controller.rendering}
                    onClick={discard}
                    className="min-h-[36px] rounded-lg px-2.5 text-[13px] text-amber-900 hover:underline disabled:opacity-50 dark:text-amber-200"
                  >
                    {t('translation.formatted.discard')}
                  </button>
                )}
                {pagesPending && (
                  <button
                    type="button"
                    disabled={controller.rendering}
                    onClick={undoPageChanges}
                    className="min-h-[36px] rounded-lg px-2.5 text-[13px] text-amber-900 hover:underline disabled:opacity-50 dark:text-amber-200"
                  >
                    {t('translation.formatted.undoPageChanges')}
                  </button>
                )}
                <button
                  type="button"
                  disabled={controller.rendering}
                  onClick={() =>
                    void controller.rerender(
                      checkAfter && editCount > 0,
                      instructions,
                    )
                  }
                  className="min-h-[36px] rounded-lg bg-amber-400 px-3.5 text-sm font-semibold text-gray-900 hover:bg-amber-300 disabled:opacity-60"
                >
                  {controller.rendering
                    ? t('translation.formatted.rerendering')
                    : editCount > 0
                      ? t('translation.formatted.rerender')
                      : t('translation.formatted.updateDownload')}
                </button>
              </div>
              {editCount > 0 && (
                <label className="mt-1.5 flex items-center gap-2 text-xs text-amber-900 dark:text-amber-200/80">
                  <input
                    type="checkbox"
                    checked={checkAfter}
                    onChange={(event) => setCheckAfter(event.target.checked)}
                  />
                  {t('translation.formatted.checkAfter')}
                </label>
              )}
            </div>
          )}
          {untranslated && (
            <div
              data-testid="untranslated-panel"
              className="flex flex-col items-start gap-2 border-b border-gray-200 px-3 py-3 dark:border-gray-700"
            >
              <p className="text-[13px] text-gray-700 dark:text-gray-300">
                {pageRemoved
                  ? unitT('pageRemovedNote')
                  : unitT('pageUntranslatedNote')}
              </p>
              {pageRemoved ? (
                <button
                  type="button"
                  disabled={controller.rendering}
                  onClick={() => removePage(run.page, false)}
                  className="min-h-[36px] rounded-lg border border-gray-300 px-3 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-surface-dark-elevated"
                >
                  {t('translation.formatted.restore')}
                </button>
              ) : (
                pageTranslatable && (
                  <button
                    type="button"
                    disabled={controller.rendering}
                    onClick={() => batch?.onTranslate([run.page])}
                    className="min-h-[36px] rounded-lg bg-blue-600 px-3 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {unitT('translateThisPage')}
                  </button>
                )
              )}
            </div>
          )}
          {(controller.renderError || controller.unitError) && (
            <p
              role="alert"
              className="border-b border-gray-200 px-3 py-2 text-xs text-red-700 dark:border-gray-700 dark:text-red-400"
            >
              {controller.renderError
                ? t('translation.formatted.renderFailed', {
                    message: controller.renderError,
                  })
                : t('translation.formatted.unitFailed', {
                    message: controller.unitError ?? '',
                  })}
            </p>
          )}

          {run.uncheckedPages?.includes(run.page) && (
            <p className="border-b border-gray-200 px-3 py-2 text-xs text-amber-700 dark:border-gray-700 dark:text-amber-400">
              {unitT('unchecked')}
            </p>
          )}
          {issues.length > 0 && (
            <div className="border-b border-gray-200 px-3 py-2.5 dark:border-gray-700">
              <h3 className="text-xs font-medium text-gray-700 dark:text-gray-300">
                {t('translation.formatted.findings', { count: issues.length })}
              </h3>
              <ul className="mt-1.5 flex flex-col gap-2">
                {issues.map((issue) => {
                  const unit = pageUnits.find(
                    (candidate) => candidate.n === issue.n,
                  );
                  return (
                    <li key={issueKey(issue)} className="flex gap-2.5">
                      <span className="shrink-0 self-start rounded bg-amber-100 px-1.5 py-px text-[11px] text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
                        {unit
                          ? t('translation.formatted.blockLabel', { n: unit.n })
                          : unitT('wholePage')}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] text-gray-900 dark:text-gray-100">
                          {t(`translation.formatted.issue.${issue.kind}`)}
                        </p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {issue.note}
                        </p>
                        <div className="mt-1 flex flex-wrap gap-3 text-xs">
                          {unit && (
                            <button
                              type="button"
                              onClick={() => select(unit.id, 'list')}
                              className="text-blue-700 hover:underline dark:text-blue-300"
                            >
                              {t('translation.formatted.showBlock')}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => dismiss(issue)}
                            className="text-gray-600 hover:underline dark:text-gray-400"
                          >
                            {t('translation.formatted.dismiss')}
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div
            className={`flex flex-wrap items-center gap-1.5 border-b border-gray-200 px-3 py-2 dark:border-gray-700 ${
              untranslated ? 'hidden' : ''
            }`}
          >
            <h3 className="me-1.5 text-xs font-medium text-gray-700 dark:text-gray-300">
              {t('translation.formatted.blocks')}
            </h3>
            {(['all', 'shrunk', 'kept', 'edited'] as const).map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={filter === id}
                onClick={() => setFilter(id)}
                className={pill(filter === id)}
              >
                {t(`translation.formatted.filter.${id}`, { count: counts[id] })}
              </button>
            ))}
          </div>

          <ul
            ref={listRef}
            className={stacked ? '' : 'min-h-0 flex-1 overflow-y-auto'}
          >
            {pageUnits.filter(matches[filter]).map((unit) => {
              const current = currentTranslation(run, unit);
              const edited = isChanged(unit);
              const isSelected = unit.id === selectedId;
              const chips = (
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <span className="text-[11px] text-gray-500 dark:text-gray-400">
                    {t(`translation.formatted.role.${unit.role}`)}
                  </span>
                  {edited && (
                    <span className="rounded bg-amber-100 px-1.5 py-px text-[11px] text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
                      {t('translation.formatted.edited')}
                    </span>
                  )}
                  {!edited && isShrunk(unit) && (
                    <span className="rounded bg-amber-100 px-1.5 py-px text-[11px] tabular-nums text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
                      {t('translation.formatted.sizeChip', {
                        percent: Math.round((unit.scale ?? 1) * 100),
                      })}
                    </span>
                  )}
                  {!edited && run.pdfStyles?.[unit.id] && (
                    <span
                      data-testid="adjusted-chip"
                      title={t('translation.formatted.adjustedHint')}
                      className="rounded bg-blue-50 px-1.5 py-px text-[11px] text-blue-800 dark:bg-blue-900/30 dark:text-blue-200"
                    >
                      {t('translation.formatted.adjusted')}
                    </span>
                  )}
                  {current === null && (
                    <span className="rounded bg-gray-100 px-1.5 py-px text-[11px] text-gray-700 dark:bg-surface-dark-elevated dark:text-gray-300">
                      {t('translation.formatted.keptAsWritten')}
                    </span>
                  )}
                </span>
              );
              if (!isSelected) {
                return (
                  <li key={unit.id}>
                    <button
                      type="button"
                      {...{
                        [UNIT_ATTRIBUTE]: unit.id,
                        [UNIT_PLACE_ATTRIBUTE]: 'list',
                      }}
                      onClick={() => select(unit.id, 'list')}
                      className="flex w-full gap-2.5 border-b border-gray-200 px-3 py-2.5 text-start hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-surface-dark-elevated"
                    >
                      <span className="w-6 shrink-0">
                        <span
                          data-number-look={edited ? 'edited' : 'plain'}
                          className={`${BLOCK_NUMBER} ${
                            edited
                              ? 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200'
                              : 'text-gray-500 dark:text-gray-400'
                          }`}
                        >
                          {unit.n}
                        </span>
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        {current !== null && (
                          <span className="line-clamp-1 whitespace-pre-line text-xs text-gray-500 dark:text-gray-400">
                            {plainText(unit.source)}
                          </span>
                        )}
                        <span
                          className={`line-clamp-2 whitespace-pre-line text-[13px] ${
                            current === null
                              ? 'text-gray-500 dark:text-gray-400'
                              : 'text-gray-900 dark:text-gray-100'
                          }`}
                        >
                          {plainText(current ?? unit.source)}
                        </span>
                      </span>
                      {chips}
                    </button>
                  </li>
                );
              }
              const text = fieldText(unit);
              const fit = fitEstimate(text, unit.budgetChars);
              const dropped =
                unit.id in run.edits &&
                retagEditedText(unit.translation ?? unit.source, text).dropped >
                  0;
              return (
                <li
                  key={unit.id}
                  {...{ [UNIT_ATTRIBUTE]: unit.id }}
                  className="flex flex-col gap-2.5 border border-blue-300 bg-blue-50/60 p-3 dark:border-blue-800 dark:bg-blue-950/30"
                >
                  <div className="flex items-start gap-2.5">
                    <span className="w-6 shrink-0">
                      <span
                        data-number-look="selected"
                        className={`${BLOCK_NUMBER} bg-blue-600 text-white`}
                      >
                        {unit.n}
                      </span>
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] text-gray-500 dark:text-gray-400">
                        {t('translation.formatted.original')}
                      </div>
                      <div className="whitespace-pre-line text-[13px] text-gray-700 dark:text-gray-300">
                        {plainText(unit.source)}
                      </div>
                    </div>
                    {chips}
                  </div>
                  <label className="text-[11px] text-gray-500 dark:text-gray-400">
                    {t('translation.formatted.translation')}
                    <textarea
                      autoFocus={chosenFrom === 'list'}
                      rows={textRows(text, 55, { min: 2, max: 12 })}
                      value={text}
                      onChange={(event) => type(unit, event.target.value)}
                      aria-describedby={`${unit.id}-breaks`}
                      className="mt-1 block w-full resize-y rounded-lg border border-blue-500 bg-white px-2.5 py-2 text-[13px] text-gray-900 dark:bg-surface-dark-base dark:text-gray-100"
                    />
                  </label>
                  <p
                    id={`${unit.id}-breaks`}
                    className="-mt-1.5 text-[11px] text-gray-500 dark:text-gray-400"
                  >
                    {t('translation.formatted.lineBreakHint')}
                  </p>
                  {current !== null && (
                    <p
                      className={`text-xs ${
                        fit.tight
                          ? 'text-amber-700 dark:text-amber-400'
                          : 'text-gray-500 dark:text-gray-400'
                      }`}
                    >
                      {fit.tight
                        ? t('translation.formatted.fitTight', {
                            chars: fit.chars,
                            budget: fit.budget,
                          })
                        : t('translation.formatted.fitOk', {
                            chars: fit.chars,
                            budget: fit.budget,
                          })}
                    </p>
                  )}
                  {dropped && (
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                      {t('translation.formatted.formattingDropped')}
                    </p>
                  )}
                  <FormattedBlockStyle
                    unit={unit}
                    style={unitStyle(run, unit.id)}
                    pending={restyled.has(unit.id)}
                    disabled={controller.rendering}
                    movesShape={unitIsSlide}
                    onChange={(change) =>
                      onUpdateRun((latest) =>
                        withUnitStyle(latest, unit.id, change),
                      )
                    }
                    onReset={() =>
                      onUpdateRun((latest) =>
                        withUnitStyle(latest, unit.id, null),
                      )
                    }
                  />
                  {actionsFor(unit, false)}
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      <div className="border-t border-gray-200 px-3 py-2 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
          <span className="font-medium text-gray-700 dark:text-gray-300">
            {t('translation.formatted.run')}
          </span>
          <span>
            {t('translation.formatted.runSummary', {
              seconds: Math.round(duration / 1000),
              tokens: run.totalTokens,
              font: run.fonts.sans,
            })}
          </span>
          <button
            type="button"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((open) => !open)}
            className="ms-auto text-blue-700 hover:underline dark:text-blue-300"
          >
            {t('translation.formatted.details')}
          </button>
        </div>
        {detailsOpen && (
          <ol className="mt-1.5 flex flex-col gap-0.5">
            {run.steps.map((step) => (
              <li key={step.id} className="flex gap-2">
                <span className="w-44 shrink-0 text-gray-700 dark:text-gray-300">
                  {t(`translation.formatted.step.${step.id}.title`)}
                </span>
                <span className="w-14 shrink-0 tabular-nums">
                  {t('translation.formatted.seconds', {
                    seconds: (step.durationMs / 1000).toFixed(1),
                  })}
                </span>
                <span className="min-w-0">{step.detail}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
