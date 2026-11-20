'use client';

import { useTranslations } from 'next-intl';

import {
  DOCUMENT_LAYOUTS,
  TranslationDocumentLayout,
} from '@/lib/utils/shared/translation/formattedDocument';
import {
  NATIVE_PDF_DEPTHS,
  NativePdfDepth,
} from '@/lib/utils/shared/translation/nativePdf';

import { TranslationKind } from '@/types/workflow';

interface SegmentedProps<Value extends string> {
  label: string;
  value: Value;
  options: readonly { value: Value; label: string; hint: string }[];
  disabled?: boolean;
  onChange: (value: Value) => void;
}

/** A small group of mutually exclusive choices, with its label beside it. */
function Segmented<Value extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: SegmentedProps<Value>) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-gray-500 dark:text-gray-400">{label}</span>
      <div
        role="radiogroup"
        aria-label={label}
        className="flex rounded-lg bg-gray-100 p-0.5 dark:bg-surface-dark-elevated"
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            title={option.hint}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${
              value === option.value
                ? 'bg-white text-gray-900 dark:bg-surface-dark dark:text-gray-100'
                : 'text-gray-600 dark:text-gray-400'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

interface TranslationOptionsBarProps {
  /** Whether the text or the uploaded document is being translated. */
  kind: TranslationKind;
  /** The document layout; absent when there is no choice of layout to offer. */
  layout?: TranslationDocumentLayout;
  /**
   * Quick or Reviewed; absent where the choice does not apply (a document
   * read as text is translated by the document service in one pass).
   */
  depth?: NativePdfDepth;
  /** Nothing can be changed, e.g. while a translation is running. */
  disabled?: boolean;
  onLayoutChange: (layout: TranslationDocumentLayout) => void;
  onDepthChange: (depth: NativePdfDepth) => void;
  /**
   * For a presentation: whether its speaker notes are translated too.
   * Absent for any other document.
   */
  speakerNotes?: { checked: boolean; onChange: (checked: boolean) => void };
}

/**
 * The choices beneath Text / Document: for a document, whether the result
 * is read as text or rebuilt with its formatting; for text and for a
 * formatted document, how thoroughly it is translated (Quick or Reviewed).
 * Renders nothing when neither choice applies.
 */
export function TranslationOptionsBar({
  kind,
  layout,
  depth,
  disabled,
  onLayoutChange,
  onDepthChange,
  speakerNotes,
}: TranslationOptionsBarProps) {
  const t = useTranslations('workflows');
  const showLayout = kind === 'document' && layout !== undefined;
  const showNotes = kind === 'document' && speakerNotes !== undefined;
  if (!showLayout && depth === undefined && !showNotes) return null;
  const formatted = layout === 'formatted';
  const depthHint = (value: NativePdfDepth): string =>
    kind === 'text'
      ? value === 'quick'
        ? t('translation.modeQuickHint')
        : t('translation.modeAgenticHint')
      : value === 'quick'
        ? t('translation.formatted.depthQuickHint')
        : t('translation.formatted.depthReviewedHint');
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-gray-200 px-3 py-2 text-xs dark:border-gray-700">
      {showLayout && (
        <Segmented
          label={t('translation.formatted.optionsLayout')}
          value={layout}
          disabled={disabled}
          onChange={onLayoutChange}
          options={DOCUMENT_LAYOUTS.map((value) => ({
            value,
            label:
              value === 'text'
                ? t('translation.formatted.layoutText')
                : t('translation.formatted.layoutFormatted'),
            hint:
              value === 'text'
                ? t('translation.formatted.layoutTextHint')
                : t('translation.formatted.layoutFormattedHint'),
          }))}
        />
      )}
      {depth !== undefined && (
        <Segmented
          label={t('translation.formatted.optionsDepth')}
          value={depth}
          disabled={disabled}
          onChange={onDepthChange}
          options={NATIVE_PDF_DEPTHS.map((value) => ({
            value,
            label:
              value === 'quick'
                ? t('translation.modeQuick')
                : t('translation.modeAgentic'),
            hint: depthHint(value),
          }))}
        />
      )}
      {showNotes && (
        <label
          title={t('translation.formatted.speakerNotesHint')}
          className="flex cursor-pointer items-center gap-1.5 text-gray-700 dark:text-gray-300"
        >
          <input
            type="checkbox"
            checked={speakerNotes.checked}
            disabled={disabled}
            onChange={(event) => speakerNotes.onChange(event.target.checked)}
            className="h-3.5 w-3.5 rounded border-gray-300 accent-blue-600 dark:border-gray-600"
          />
          {t('translation.formatted.speakerNotes')}
        </label>
      )}
      <span className="min-w-[16rem] flex-1 text-gray-500 dark:text-gray-400">
        {kind === 'text' && depth !== undefined
          ? depthHint(depth)
          : formatted
            ? t('translation.formatted.layoutFormattedHint')
            : t('translation.formatted.layoutTextHint')}
      </span>
    </div>
  );
}
