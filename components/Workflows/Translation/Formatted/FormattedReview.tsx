'use client';

import { useEffect, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import { FormattedDocumentController } from '@/client/hooks/workflows/useFormattedDocument';
import { PdfPages } from '@/client/hooks/workflows/usePdfPages';

import { fetchNativePdfImage } from '@/client/services/workflows/nativePdfTranslation';

import {
  FormattedDocumentRun,
  batchPageState,
  currentTranslation,
  editedUnits,
  fitEstimate,
  issueKey,
  openIssues,
  plainText,
  planBatch,
  planTickedBatch,
  removalPending,
  removedPages,
  retagEditedText,
  stalePages,
  translatedPages,
  withPageRemoved,
  withUnitEdit,
} from '@/lib/utils/shared/translation/formattedDocument';
import {
  NativePdfIssue,
  NativePdfLimits,
  NativePdfStepInstructions,
  NativePdfUnitAction,
  NativePdfUnitResult,
  SCALE_EPSILON,
} from '@/lib/utils/shared/translation/nativePdf';

import { FormattedBlockActions } from './FormattedBlockActions';
import { FormattedPageRail } from './FormattedPageRail';
import { FormattedPageView } from './FormattedPageView';

type Filter = 'all' | 'shrunk' | 'kept' | 'edited';
type PageSide = 'translated' | 'original';

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
  onUpdateRun: (
    update: (run: FormattedDocumentRun) => FormattedDocumentRun,
  ) => void;
  /** Opens the setup again, to translate with other choices. */
  onChangeOptions: () => void;
}

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
  onUpdateRun,
  onChangeOptions,
}: FormattedReviewProps) {
  const t = useTranslations('workflows');
  const [side, setSide] = useState<PageSide>('translated');
  const [outlines, setOutlines] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ id: string; text: string } | null>(null);
  const [checkAfter, setCheckAfter] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [original, setOriginal] = useState<{
    page: number;
    image: string | null;
  } | null>(null);
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

  // Page images are stored files answered as data URLs; each is read once.
  useEffect(() => {
    const abort = new AbortController();
    for (const { previewUrl } of run.pageImages) {
      void fetchNativePdfImage(previewUrl, abort.signal)
        .then((image) =>
          setPreviews((current) =>
            current[previewUrl] ? current : { ...current, [previewUrl]: image },
          ),
        )
        .catch(() => undefined);
    }
    return () => abort.abort();
  }, [run.pageImages]);

  useEffect(() => {
    if (!showOriginal || pdf.status !== 'ready') return;
    let cancelled = false;
    void pdf.renderPage(run.page, ORIGINAL_WIDTH).then((image) => {
      if (!cancelled) setOriginal({ page: run.page, image });
    });
    return () => {
      cancelled = true;
    };
  }, [showOriginal, pdf, run.page]);

  const pageUnits = useMemo(
    () => run.units.filter((unit) => unit.page === run.page),
    [run.units, run.page],
  );
  const previewUrl = run.pageImages.find(
    (image) => image.page === run.page,
  )?.previewUrl;
  const translatedImage = previewUrl ? (previews[previewUrl] ?? null) : null;
  const image = showOriginal
    ? original?.page === run.page
      ? original.image
      : null
    : translatedImage;

  const stale = stalePages(run);
  const pdfBehind = stale.length > 0 || pagesPending;
  const editCount = editedUnits(run).length;
  const issues = openIssues(run, run.page);
  const selected = pageUnits.find((unit) => unit.id === selectedId) ?? null;
  const counts = {
    all: pageUnits.length,
    shrunk: pageUnits.filter(
      (unit) => !(unit.id in run.edits) && isShrunk(unit),
    ).length,
    kept: pageUnits.filter((unit) => currentTranslation(run, unit) === null)
      .length,
    edited: pageUnits.filter((unit) => unit.id in run.edits).length,
  };
  const matches: Record<Filter, (unit: NativePdfUnitResult) => boolean> = {
    all: () => true,
    shrunk: (unit) => !(unit.id in run.edits) && isShrunk(unit),
    kept: (unit) => currentTranslation(run, unit) === null,
    edited: (unit) => unit.id in run.edits,
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
  const select = (id: string | null) => {
    setSelectedId(id);
    setDraft(null);
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
    onUpdateRun((latest) => ({ ...latest, edits: {} }));
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
      onDone={compact ? () => select(null) : undefined}
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
        {pdfBehind && (
          <span className="ms-auto text-amber-700 dark:text-amber-400">
            {stale.length > 0
              ? t('translation.formatted.pdfBehind')
              : t('translation.formatted.pdfBehindPages')}
          </span>
        )}
        <a
          href={run.pdfUrl}
          download={run.sourceName.replace(/\.pdf$/i, '') + '.translated.pdf'}
          className={`rounded-lg border border-gray-300 px-2.5 py-1 font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-surface-dark-elevated ${
            pdfBehind ? '' : 'ms-auto'
          }`}
        >
          {t('translation.formatted.download')}
        </a>
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
          previews={previews}
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
              className="flex rounded-lg bg-gray-100 p-0.5 dark:bg-surface-dark-elevated"
            >
              <button
                type="button"
                role="radio"
                aria-checked={showOriginal}
                disabled={pdf.status !== 'ready'}
                title={
                  pdf.status === 'failed'
                    ? t('translation.formatted.previewsUnavailable')
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
                aria-checked={!showOriginal}
                disabled={untranslated}
                onClick={() => setSide('translated')}
                className={segment(!showOriginal)}
              >
                {t('translation.formatted.viewTranslated')}
              </button>
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
                  ? t('translation.formatted.pageRemovedNote')
                  : stale.includes(run.page)
                    ? t('translation.formatted.lastRender')
                    : t('translation.formatted.clickToEdit')}
            </span>
          </div>
          <div
            className={`flex justify-center bg-gray-100 px-4 pb-5 pt-2 dark:bg-black/20 ${
              stacked ? '' : 'min-h-0 flex-1 overflow-auto'
            }`}
          >
            {untranslated &&
              (image ? (
                // A rendered page of the user's own file, as a data URL.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={image}
                  alt={t('translation.formatted.pageLabel', {
                    page: run.page,
                  })}
                  data-testid="untranslated-page"
                  className={`h-fit w-full max-w-[576px] shadow ${
                    pageRemoved ? 'opacity-40 grayscale' : ''
                  }`}
                />
              ) : (
                <span className="block aspect-[210/297] w-full max-w-[576px] animate-pulse bg-gray-200 dark:bg-surface-dark-elevated" />
              ))}
            {pageStats && (
              <FormattedPageView
                image={image}
                page={pageStats}
                units={pageUnits}
                edits={run.edits}
                selectedId={selectedId}
                outlines={outlines}
                draft={
                  selected && side === 'translated' ? fieldText(selected) : null
                }
                toolbar={selected ? actionsFor(selected, true) : undefined}
                onSelect={select}
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
                  ? t('translation.formatted.pageRemovedNote')
                  : t('translation.formatted.pageUntranslatedNote')}
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
                    {t('translation.formatted.translateThisPage')}
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
              {t('translation.formatted.unchecked')}
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
                          : t('translation.formatted.wholePage')}
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
                              onClick={() => select(unit.id)}
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

          <ul className={stacked ? '' : 'min-h-0 flex-1 overflow-y-auto'}>
            {pageUnits.filter(matches[filter]).map((unit) => {
              const current = currentTranslation(run, unit);
              const edited = unit.id in run.edits;
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
                      onClick={() => select(unit.id)}
                      className={`flex w-full gap-2.5 border-b border-s-[3px] border-gray-200 px-3 py-2.5 text-start hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-surface-dark-elevated ${
                        edited ? 'border-s-amber-400' : 'border-s-transparent'
                      }`}
                    >
                      <span className="w-6 shrink-0 pt-0.5 text-[11px] font-semibold tabular-nums text-gray-500 dark:text-gray-400">
                        {unit.n}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        {current !== null && (
                          <span className="line-clamp-1 text-xs text-gray-500 dark:text-gray-400">
                            {plainText(unit.source)}
                          </span>
                        )}
                        <span
                          className={`line-clamp-2 text-[13px] ${
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
                edited &&
                retagEditedText(unit.translation ?? unit.source, text).dropped >
                  0;
              return (
                <li
                  key={unit.id}
                  className="flex flex-col gap-2.5 border-b border-s-[3px] border-gray-200 border-s-blue-500 bg-blue-50/60 p-3 dark:border-gray-700 dark:border-s-blue-500 dark:bg-blue-950/30"
                >
                  <div className="flex items-start gap-2.5">
                    <span className="text-[11px] font-semibold tabular-nums text-blue-800 dark:text-blue-200">
                      {unit.n}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] text-gray-500 dark:text-gray-400">
                        {t('translation.formatted.original')}
                      </div>
                      <div className="text-[13px] text-gray-700 dark:text-gray-300">
                        {plainText(unit.source)}
                      </div>
                    </div>
                    {chips}
                  </div>
                  <label className="text-[11px] text-gray-500 dark:text-gray-400">
                    {t('translation.formatted.translation')}
                    <textarea
                      rows={Math.min(
                        Math.max(Math.ceil(text.length / 55), 2),
                        12,
                      )}
                      value={text}
                      onChange={(event) => type(unit, event.target.value)}
                      className="mt-1 block w-full resize-y rounded-lg border border-blue-500 bg-white px-2.5 py-2 text-[13px] text-gray-900 dark:bg-surface-dark-base dark:text-gray-100"
                    />
                  </label>
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
