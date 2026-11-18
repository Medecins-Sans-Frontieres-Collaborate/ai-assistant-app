'use client';

import { useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { PdfPages } from '@/client/hooks/workflows/usePdfPages';

import {
  FormattedDocumentOptions,
  selectedPages,
  togglePage,
} from '@/lib/utils/shared/translation/formattedDocument';
import {
  MAX_STEP_INSTRUCTION_CHARS,
  NATIVE_PDF_STEPS,
  NativePdfDepth,
  NativePdfInstructableStep,
} from '@/lib/utils/shared/translation/nativePdf';

/** Pages shown as previews; a longer document is selected by typing. */
const PREVIEW_LIMIT = 24;
const PREVIEW_WIDTH = 220;

interface PagePreviewProps {
  page: number;
  pdf: PdfPages;
  selected: boolean;
  disabled?: boolean;
  onToggle: () => void;
}

/** One page of the source as a selectable preview. */
function PagePreview({
  page,
  pdf,
  selected,
  disabled,
  onToggle,
}: PagePreviewProps) {
  const t = useTranslations('workflows');
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
  return (
    <label className="flex cursor-pointer flex-col gap-2">
      {image ? (
        // A rendered page of the user's own file, as a data URL.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={image}
          alt=""
          className={`w-full rounded ${
            selected
              ? 'outline outline-2 outline-offset-2 outline-blue-500'
              : 'opacity-70'
          }`}
        />
      ) : (
        <span className="block aspect-[210/297] w-full animate-pulse rounded bg-gray-200 dark:bg-surface-dark-elevated" />
      )}
      <span className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
        <input
          type="checkbox"
          checked={selected}
          disabled={disabled}
          onChange={onToggle}
        />
        {t('translation.formatted.pageLabel', { page })}
      </span>
    </label>
  );
}

interface FormattedSetupProps {
  documentName: string;
  /** Pages in the document, from the preview or the upload. */
  pageCount: number;
  pdf: PdfPages;
  options: FormattedDocumentOptions;
  depth: NativePdfDepth;
  maxPages: number;
  maxRefitRounds: number;
  /** Instructions are saved for the person's next documents. */
  remember: boolean;
  /** A finished translation exists to go back to. */
  canGoBack: boolean;
  onOptionsChange: (options: FormattedDocumentOptions) => void;
  onRememberChange: (remember: boolean) => void;
  onBack: () => void;
  /** Lets go of the loaded document. */
  onRemove: () => void;
}

/**
 * Where a formatted translation is set up: which pages to translate, and
 * the fixed steps the run will take, three of which accept an added
 * instruction. No step can be removed or reordered here; the list shows
 * what will happen, not a menu.
 */
export function FormattedSetup({
  documentName,
  pageCount,
  pdf,
  options,
  depth,
  maxPages,
  maxRefitRounds,
  remember,
  canGoBack,
  onOptionsChange,
  onRememberChange,
  onBack,
  onRemove,
}: FormattedSetupProps) {
  const t = useTranslations('workflows');
  const [limitHit, setLimitHit] = useState(false);
  const [opened, setOpened] = useState<Set<NativePdfInstructableStep>>(
    () => new Set(),
  );
  const selection = selectedPages(options.pages, pageCount, maxPages);
  const pages = selection.ok ? selection.pages : [];
  const previewCount = Math.min(pageCount, PREVIEW_LIMIT);

  const toggle = (page: number) => {
    const next = togglePage(pages, page, maxPages);
    setLimitHit(next === null);
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
        <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
          <h2 className="text-xs font-medium text-gray-700 dark:text-gray-300">
            {t('translation.formatted.sourcePages')}
          </h2>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {t('translation.formatted.pagesSelected', {
              selected: pages.length,
              total: pageCount,
              max: maxPages,
            })}
          </span>
          <label className="ms-auto flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            {t('translation.formatted.pagesField')}
            <input
              type="text"
              inputMode="numeric"
              value={options.pages}
              placeholder={`1-${Math.min(pageCount || maxPages, maxPages)}`}
              aria-invalid={!selection.ok}
              onChange={(event) => {
                setLimitHit(false);
                onOptionsChange({ ...options, pages: event.target.value });
              }}
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
        {(!selection.ok || limitHit || pages.length === 0) && (
          <p
            role="alert"
            className="mx-3 mt-1 text-xs text-amber-700 dark:text-amber-400"
          >
            {limitHit
              ? t('translation.formatted.pagesLimit', { max: maxPages })
              : !selection.ok
                ? t('translation.formatted.pagesInvalid', { max: maxPages })
                : t('translation.formatted.pagesNone')}
          </p>
        )}
        {pdf.status === 'ready' ? (
          <div className="grid grid-cols-2 gap-4 px-3 pt-3 sm:grid-cols-3">
            {Array.from({ length: previewCount }, (_, index) => index + 1).map(
              (page) => (
                <PagePreview
                  key={page}
                  page={page}
                  pdf={pdf}
                  selected={pages.includes(page)}
                  onToggle={() => toggle(page)}
                />
              ),
            )}
          </div>
        ) : (
          <p className="mx-3 mt-3 text-xs text-gray-500 dark:text-gray-400">
            {pdf.status === 'failed'
              ? t('translation.formatted.previewsUnavailable')
              : t('translation.formatted.previewsLoading')}
          </p>
        )}
        {pdf.status === 'ready' && pageCount > previewCount && (
          <p className="mx-3 mt-3 text-xs text-gray-500 dark:text-gray-400">
            {t('translation.formatted.previewsFirst', { count: previewCount })}
          </p>
        )}
        <p className="mx-3 mt-3 text-xs text-gray-500 dark:text-gray-400">
          {t('translation.formatted.scannedNote')}
        </p>
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
