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

interface DocumentOptionsBarProps {
  layout: TranslationDocumentLayout;
  depth: NativePdfDepth;
  /** Nothing can be changed, e.g. while a translation is running. */
  disabled?: boolean;
  onLayoutChange: (layout: TranslationDocumentLayout) => void;
  onDepthChange: (depth: NativePdfDepth) => void;
}

/**
 * The choices inside Document mode: whether the result is read as text or
 * rebuilt with the document's formatting, and how thoroughly it is
 * translated. The translation choice belongs to the formatted layout only;
 * the text layout is translated by the document service in one pass.
 */
export function DocumentOptionsBar({
  layout,
  depth,
  disabled,
  onLayoutChange,
  onDepthChange,
}: DocumentOptionsBarProps) {
  const t = useTranslations('workflows');
  const formatted = layout === 'formatted';
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-gray-200 px-3 py-2 text-xs dark:border-gray-700">
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
      {formatted && (
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
            hint:
              value === 'quick'
                ? t('translation.formatted.depthQuickHint')
                : t('translation.formatted.depthReviewedHint'),
          }))}
        />
      )}
      <span className="min-w-[16rem] flex-1 text-gray-500 dark:text-gray-400">
        {formatted
          ? t('translation.formatted.layoutFormattedHint')
          : t('translation.formatted.layoutTextHint')}
      </span>
    </div>
  );
}
