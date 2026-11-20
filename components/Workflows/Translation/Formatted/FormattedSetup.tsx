'use client';

import { IconCheck, IconLock } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { PdfPages } from '@/client/hooks/workflows/usePdfPages';

import {
  BatchPageState,
  BatchPlan,
  FormattedDocumentOptions,
  batchPageState,
  togglePage,
} from '@/lib/utils/shared/translation/formattedDocument';
import {
  MAX_STEP_INSTRUCTION_CHARS,
  NATIVE_PDF_STEPS,
  NativePdfDepth,
  NativePdfInstructableStep,
  splitIntoRequests,
} from '@/lib/utils/shared/translation/nativePdf';

import { useFormattedUnit, useUnitWording } from './formattedWording';

/** Pages shown as previews; a longer document is selected by typing. */
const PREVIEW_LIMIT = 24;
const PREVIEW_WIDTH = 220;

/**
 * How each page state looks. The three states a page can be in without
 * being part of this batch must not be mistaken for one another:
 * `available` is a normal, clickable page; `later` is dimmed (it will be
 * selectable again); `locked` is greyed out and struck by the limit.
 */
const PAGE_IMAGE: Record<BatchPageState, string> = {
  selected: 'outline outline-2 outline-offset-2 outline-blue-500',
  available: 'opacity-90 group-hover:opacity-100',
  translated: 'opacity-60',
  later: 'opacity-40',
  locked: 'opacity-20 grayscale',
  removed: 'opacity-20 grayscale',
};

interface PagePreviewProps {
  page: number;
  pdf: PdfPages;
  state: BatchPageState;
  /** Why the page cannot be ticked, for `later` and `locked`. */
  reason?: string;
  onToggle: () => void;
}

/** One page of the source as a preview, selectable when its state allows. */
function PagePreview({ page, pdf, state, reason, onToggle }: PagePreviewProps) {
  const t = useTranslations('workflows');
  const unitT = useUnitWording();
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void pdf.renderPage(page, PREVIEW_WIDTH).then((url) => {
      if (!cancelled) setImage(url);
    });
    return () => {
      cancelled = true;
    };
  }, [pdf, page]);
  const selectable = state === 'selected' || state === 'available';
  const picture = image ? (
    // A rendered page of the user's own file, as a data URL.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={image} alt="" className={`w-full rounded ${PAGE_IMAGE[state]}`} />
  ) : (
    <span className="block aspect-[210/297] w-full animate-pulse rounded bg-gray-200 dark:bg-surface-dark-elevated" />
  );
  const label = unitT('pageLabel', { page });
  if (selectable) {
    return (
      <label
        data-page-state={state}
        className="group flex cursor-pointer flex-col gap-2"
      >
        {picture}
        <span className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            checked={state === 'selected'}
            onChange={onToggle}
          />
          {label}
        </span>
      </label>
    );
  }
  return (
    <div
      data-page-state={state}
      title={reason}
      className="flex cursor-not-allowed flex-col gap-2"
    >
      <span className="relative block">
        {picture}
        <span
          className={`absolute start-1.5 top-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
            state === 'translated'
              ? 'bg-green-600 text-white dark:bg-green-500 dark:text-gray-900'
              : state === 'later'
                ? 'bg-gray-700 text-white dark:bg-gray-200 dark:text-gray-900'
                : 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
          }`}
        >
          {state === 'translated' && (
            <IconCheck size={11} stroke={3} aria-hidden />
          )}
          {state === 'locked' && <IconLock size={11} aria-hidden />}
          {t(`translation.formatted.pageState.${state}`)}
        </span>
      </span>
      <span
        className={`text-xs ${
          state === 'locked'
            ? 'text-gray-400 dark:text-gray-500'
            : 'text-gray-600 dark:text-gray-400'
        }`}
      >
        {label}
        {reason && <span className="sr-only"> — {reason}</span>}
      </span>
    </div>
  );
}

/** Earlier batches of the loaded document. */
export interface EarlierTranslation {
  /** Pages already translated. */
  pages: number;
  /** Display label of the language they were translated into. */
  language: string;
  /** False when the target language has changed since. */
  sameLanguage: boolean;
}

interface FormattedSetupProps {
  documentName: string;
  /** Pages in the document, from the preview or the upload. */
  pageCount: number;
  pdf: PdfPages;
  options: FormattedDocumentOptions;
  depth: NativePdfDepth;
  /** The batch about to run and where every page stands (see planBatch). */
  plan: BatchPlan;
  /** Pages one request takes; a larger batch runs in several parts. */
  requestPages?: number;
  /** Display label of the target language, if one is chosen. */
  targetLanguage?: string;
  /** Earlier batches, when the document has any. */
  earlier?: EarlierTranslation;
  /**
   * The new pages are added to the earlier batches. False starts over:
   * the earlier result is replaced when the new one finishes.
   */
  adding: boolean;
  maxRefitRounds: number;
  /** Instructions are saved for the person's next documents. */
  remember: boolean;
  /** A finished translation exists to go back to. */
  canGoBack: boolean;
  onOptionsChange: (options: FormattedDocumentOptions) => void;
  onAddingChange: (adding: boolean) => void;
  onRememberChange: (remember: boolean) => void;
  onBack: () => void;
  /** Lets go of the loaded document. */
  onRemove: () => void;
}

/**
 * Where a formatted translation is set up: which pages the next batch
 * takes, how large a batch is, and the fixed steps the run will take, three
 * of which accept an added instruction. No step can be removed or reordered
 * here; the list shows what will happen, not a menu.
 *
 * Every page shows where it stands: in this batch, free to add, done by an
 * earlier batch, waiting for a later batch, or beyond the document limit.
 */
export function FormattedSetup({
  documentName,
  pageCount,
  pdf,
  options,
  depth,
  plan,
  requestPages,
  targetLanguage,
  earlier,
  adding,
  maxRefitRounds,
  remember,
  canGoBack,
  onOptionsChange,
  onAddingChange,
  onRememberChange,
  onBack,
  onRemove,
}: FormattedSetupProps) {
  const t = useTranslations('workflows');
  const unitT = useUnitWording();
  const unit = useFormattedUnit();
  const [opened, setOpened] = useState<Set<NativePdfInstructableStep>>(
    () => new Set(),
  );
  const { pages, limits } = plan;
  const previewCount = Math.min(pageCount, PREVIEW_LIMIT);
  const previewPages = Array.from(
    { length: previewCount },
    (_, index) => index + 1,
  );
  const states = previewPages.map((page) => batchPageState(plan, page));
  const canRaise = plan.batchPages < limits.maxBatchPages;
  const parts = splitIntoRequests(pages, requestPages || undefined).length;
  const reasonFor: Partial<Record<BatchPageState, string>> = {
    later: unitT(canRaise ? 'pageReason.laterRaise' : 'pageReason.later'),
    locked: unitT('pageReason.locked', { max: limits.maxDocumentPages }),
  };

  const toggle = (page: number) => {
    const next = togglePage(pages, page, plan.capacity);
    if (next !== null) onOptionsChange({ ...options, pages: next });
  };
  const setInstruction = (step: NativePdfInstructableStep, text: string) => {
    const instructions = { ...options.instructions };
    if (text) instructions[step] = text.slice(0, MAX_STEP_INSTRUCTION_CHARS);
    else delete instructions[step];
    onOptionsChange({ ...options, instructions });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-wrap overflow-y-auto">
      <section className="min-w-0 flex-[1_1_26rem] border-gray-200 pb-4 dark:border-gray-700 md:border-e">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
          <h2 className="text-xs font-medium text-gray-700 dark:text-gray-300">
            {earlier && adding
              ? t('translation.formatted.addPagesTitle')
              : unitT('sourcePages')}
          </h2>
          <span
            className="text-xs tabular-nums text-gray-700 dark:text-gray-300"
            data-testid="batch-summary"
          >
            {t('translation.formatted.batchSummary', {
              selected: pages.length,
              capacity: plan.capacity,
            })}
          </span>
          <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400">
            {unitT('documentSummary', {
              used: plan.translated.length + pages.length,
              max: limits.maxDocumentPages,
            })}
          </span>
          <label className="ms-auto flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            {unitT('pagesField')}
            <input
              type="text"
              inputMode="numeric"
              value={options.pages}
              placeholder={
                pages.length > 0 && !options.pages.trim()
                  ? t('translation.formatted.pagesPlaceholder', {
                      from: pages[0],
                      to: pages[pages.length - 1],
                    })
                  : undefined
              }
              aria-invalid={
                plan.problem === 'unreadable' || plan.problem === 'over-batch'
              }
              onChange={(event) =>
                onOptionsChange({ ...options, pages: event.target.value })
              }
              className="min-h-[30px] w-28 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 aria-[invalid=true]:border-red-500 dark:border-gray-600 dark:bg-surface-dark-base dark:text-gray-100"
            />
          </label>
        </div>
        <div className="mx-3 flex items-center gap-2.5 rounded-xl border border-gray-200 px-3 py-2 dark:border-gray-700">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900 dark:text-gray-100">
            {documentName}
          </span>
          <button
            type="button"
            onClick={onRemove}
            className="text-xs text-gray-600 hover:underline dark:text-gray-400"
          >
            {t('translation.formatted.removeDocument')}
          </button>
        </div>

        {earlier && (
          <div className="mx-3 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-gray-50 px-3 py-2 text-xs text-gray-700 dark:bg-surface-dark-elevated dark:text-gray-300">
            <span className="min-w-0 flex-1">
              {!earlier.sameLanguage
                ? t('translation.formatted.earlierOtherLanguage', {
                    count: earlier.pages,
                    language: earlier.language,
                    target: targetLanguage ?? '',
                  })
                : adding
                  ? t('translation.formatted.earlierAdding', {
                      count: earlier.pages,
                      language: earlier.language,
                    })
                  : t('translation.formatted.earlierReplacing', {
                      count: earlier.pages,
                    })}
            </span>
            {earlier.sameLanguage && (
              <button
                type="button"
                onClick={() => onAddingChange(!adding)}
                className="text-blue-700 hover:underline dark:text-blue-300"
              >
                {adding
                  ? t('translation.formatted.startOver')
                  : t('translation.formatted.keepAdding')}
              </button>
            )}
          </div>
        )}

        <div className="mx-3 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
          <label className="flex items-center gap-2 text-gray-700 dark:text-gray-300">
            {unitT('batchSize')}
            <select
              value={plan.batchPages}
              onChange={(event) =>
                onOptionsChange({
                  ...options,
                  batchPages: Number(event.target.value),
                })
              }
              className="min-h-[28px] rounded-md border border-gray-300 bg-white text-xs text-gray-900 dark:border-gray-600 dark:bg-surface-dark-base dark:text-gray-100"
            >
              {Array.from(
                { length: limits.maxBatchPages },
                (_, index) => index + 1,
              ).map((size) => (
                <option key={size} value={size}>
                  {size === limits.defaultBatchPages
                    ? t('translation.formatted.batchSizeDefault', { size })
                    : size}
                </option>
              ))}
            </select>
          </label>
          <span>
            {plan.batchPages > limits.defaultBatchPages
              ? t('translation.formatted.batchSizeRaised', { parts })
              : t('translation.formatted.batchSizeRange', {
                  max: limits.maxBatchPages,
                })}
          </span>
        </div>

        {plan.problem && (
          <p
            role="alert"
            className="mx-3 mt-2 text-xs text-amber-700 dark:text-amber-400"
          >
            {plan.problem === 'unreadable'
              ? t('translation.formatted.pagesUnreadable')
              : plan.problem === 'over-batch'
                ? t('translation.formatted.pagesOverBatch', {
                    asked: plan.asked ?? 0,
                    capacity: plan.capacity,
                  })
                : plan.allowance === 0
                  ? t('translation.formatted.pagesLimitReached', {
                      max: limits.maxDocumentPages,
                    })
                  : t('translation.formatted.pagesNoneLeft')}
          </p>
        )}
        {pdf.status === 'ready' ? (
          <>
            <div className="grid grid-cols-2 gap-4 px-3 pt-3 sm:grid-cols-3">
              {previewPages.map((page, index) => (
                <PagePreview
                  key={page}
                  page={page}
                  pdf={pdf}
                  state={states[index]}
                  reason={reasonFor[states[index]]}
                  onToggle={() => toggle(page)}
                />
              ))}
            </div>
            {(states.includes('later') || states.includes('locked')) && (
              <ul className="mx-3 mt-3 flex flex-col gap-1 text-xs text-gray-500 dark:text-gray-400">
                {states.includes('later') && (
                  <li>
                    <strong className="font-medium text-gray-700 dark:text-gray-300">
                      {t('translation.formatted.pageState.later')}
                    </strong>
                    {' — '}
                    {reasonFor.later}
                  </li>
                )}
                {states.includes('locked') && (
                  <li>
                    <strong className="font-medium text-gray-700 dark:text-gray-300">
                      {t('translation.formatted.pageState.locked')}
                    </strong>
                    {' — '}
                    {reasonFor.locked}
                  </li>
                )}
              </ul>
            )}
          </>
        ) : (
          <p className="mx-3 mt-3 text-xs text-gray-500 dark:text-gray-400">
            {pdf.status === 'failed'
              ? unitT('previewsUnavailable')
              : unitT('previewsLoading')}
          </p>
        )}
        {pdf.status === 'ready' && pageCount > previewCount && (
          <p className="mx-3 mt-3 text-xs text-gray-500 dark:text-gray-400">
            {unitT('previewsFirst', { count: previewCount })}
          </p>
        )}
        {/* A slide's text is always there to rebuild; only a PDF is scanned. */}
        {unit === 'page' && (
          <p className="mx-3 mt-3 text-xs text-gray-500 dark:text-gray-400">
            {t('translation.formatted.scannedNote')}
          </p>
        )}
      </section>

      <section className="flex min-w-0 flex-[1_1_26rem] flex-col gap-3.5 px-5 pb-6 pt-2.5">
        <div>
          <h2 className="text-xs font-medium text-gray-700 dark:text-gray-300">
            {t('translation.formatted.whatHappensTitle')}
          </h2>
          <p className="mt-1.5 max-w-2xl text-[13px] text-gray-500 dark:text-gray-400">
            {t('translation.formatted.whatHappens')}
          </p>
          {canGoBack && (
            <button
              type="button"
              onClick={onBack}
              className="mt-1.5 text-xs text-blue-700 hover:underline dark:text-blue-300"
            >
              {t('translation.formatted.backToResult')}
            </button>
          )}
        </div>

        <ol className="rounded-xl border border-gray-200 dark:border-gray-700">
          {NATIVE_PDF_STEPS.map((step, index) => {
            const instruction = step.instructable
              ? (options.instructions[step.id] ?? '')
              : '';
            const open =
              step.instructable && (instruction !== '' || opened.has(step.id));
            return (
              <li
                key={step.id}
                className="flex gap-3 border-b border-gray-200 px-3.5 py-3 last:border-b-0 dark:border-gray-700"
              >
                <span
                  aria-hidden
                  className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs font-semibold text-gray-700 dark:bg-surface-dark-elevated dark:text-gray-300"
                >
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {t(`translation.formatted.step.${step.id}.title`)}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {step.id === 'translate' && depth === 'reviewed'
                      ? t('translation.formatted.step.translate.reviewed')
                      : t(`translation.formatted.step.${step.id}.description`)}
                  </div>
                  {step.instructable && !open && (
                    <button
                      type="button"
                      onClick={() =>
                        setOpened((current) => new Set(current).add(step.id))
                      }
                      className="mt-1.5 text-xs text-blue-700 hover:underline dark:text-blue-300"
                    >
                      {t('translation.formatted.addInstruction')}
                    </button>
                  )}
                  {step.instructable && open && (
                    <label className="mt-2 block text-xs text-gray-700 dark:text-gray-300">
                      {t('translation.formatted.instructionLabel')}
                      <textarea
                        rows={2}
                        value={instruction}
                        maxLength={MAX_STEP_INSTRUCTION_CHARS}
                        onChange={(event) =>
                          setInstruction(step.id, event.target.value)
                        }
                        className="mt-1 block w-full resize-y rounded-lg border border-gray-300 bg-white px-2.5 py-2 text-[13px] text-gray-900 dark:border-gray-600 dark:bg-surface-dark-base dark:text-gray-100"
                      />
                      <span className="mt-1 flex flex-wrap gap-x-3 text-gray-500 dark:text-gray-400">
                        <span className="tabular-nums">
                          {t('translation.formatted.instructionCount', {
                            count: instruction.length,
                            max: MAX_STEP_INSTRUCTION_CHARS,
                          })}
                        </span>
                        <span>
                          {t('translation.formatted.instructionNote')}
                        </span>
                      </span>
                    </label>
                  )}
                </div>
                {!step.instructable && step.id !== 'refit' && (
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {t('translation.formatted.alwaysSame')}
                  </span>
                )}
                {step.id === 'refit' && (
                  <label className="flex items-center gap-1.5 self-start text-xs text-gray-500 dark:text-gray-400">
                    {t('translation.formatted.rounds')}
                    <select
                      value={options.refitRounds}
                      onChange={(event) =>
                        onOptionsChange({
                          ...options,
                          refitRounds: Number(event.target.value),
                        })
                      }
                      className="min-h-[28px] rounded-md border border-gray-300 bg-white text-xs text-gray-900 dark:border-gray-600 dark:bg-surface-dark-base dark:text-gray-100"
                    >
                      {Array.from(
                        { length: maxRefitRounds + 1 },
                        (_, rounds) => (
                          <option key={rounds} value={rounds}>
                            {rounds}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                )}
              </li>
            );
          })}
        </ol>

        <div className="flex flex-col gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => onRememberChange(event.target.checked)}
            />
            {t('translation.formatted.remember')}
          </label>
          <span>{t('translation.formatted.fontsNote')}</span>
        </div>
      </section>
    </div>
  );
}
