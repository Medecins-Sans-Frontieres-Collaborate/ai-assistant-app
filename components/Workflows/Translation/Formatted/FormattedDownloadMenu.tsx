'use client';

import { IconChevronDown } from '@tabler/icons-react';
import { FC, KeyboardEvent, useEffect, useId, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  NATIVE_PDF_EXPORT_FORMATS,
  NativePdfExportFormat,
} from '@/lib/utils/shared/translation/nativePdf';

/**
 * What a run can be downloaded as: the translated file in its own format
 * (`document`, a presentation's deck), the PDF, or one of the editable
 * formats built from a PDF.
 */
export type FormattedDownloadFormat =
  | 'document'
  | 'pdf'
  | NativePdfExportFormat;

/** Message keys of a format's name and of the line that says what it is. */
const FORMAT_LABELS: Record<
  FormattedDownloadFormat,
  { name: string; hint: string }
> = {
  document: {
    name: 'translation.formatted.downloadDeck',
    hint: 'translation.formatted.downloadDeckHint',
  },
  pdf: {
    name: 'translation.formatted.downloadPdf',
    hint: 'translation.formatted.downloadPdfHint',
  },
  pptx: {
    name: 'translation.formatted.downloadPptx',
    hint: 'translation.formatted.downloadPptxHint',
  },
};

const EXPORT_FORMATS = Object.keys(
  NATIVE_PDF_EXPORT_FORMATS,
) as NativePdfExportFormat[];

/**
 * The formats a run offers, in menu order.
 *
 * @param run - Whether it has a translated file of its own (a presentation)
 *   and a PDF (absent when a presentation's render failed).
 * @returns A presentation's deck first, then its PDF; a PDF's run its PDF
 *   and the editable formats built from it.
 */
export function downloadFormatsOf(run: {
  documentUrl?: string;
  pdfUrl?: string;
}): FormattedDownloadFormat[] {
  if (run.documentUrl) return run.pdfUrl ? ['document', 'pdf'] : ['document'];
  return ['pdf', ...EXPORT_FORMATS];
}

interface FormattedDownloadMenuProps {
  /** What can be downloaded, in order (downloadFormatsOf). */
  formats: FormattedDownloadFormat[];
  /**
   * The file extension of `document` (a presentation's own format), shown
   * in its name.
   */
  documentExtension?: string;
  /** The format being fetched or built, if any; the menu is then disabled. */
  busy: FormattedDownloadFormat | null;
  /** Nothing can be downloaded right now (a render is under way). */
  disabled?: boolean;
  /**
   * The stored files are behind the person's changes. Editable formats are
   * then built from the current text, and their line says so.
   */
  behind: boolean;
  onSelect: (format: FormattedDownloadFormat) => void;
  className?: string;
}

/**
 * The "Download" button of a formatted translation and its menu of formats:
 * the PDF, and the editable formats of EDITABLE DOWNLOADS (nativePdf.ts),
 * each with a line saying what can be edited in it and a tag on those that
 * are experimental. Arrow keys move between the formats; Escape closes.
 */
export const FormattedDownloadMenu: FC<FormattedDownloadMenuProps> = ({
  formats,
  documentExtension = 'pptx',
  busy,
  disabled = false,
  behind,
  onSelect,
  className = '',
}) => {
  const t = useTranslations('workflows');
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    items.current[0]?.focus();
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      if (!open) return;
      // Handled here: the screen around the menu does not see it.
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const at = items.current.findIndex(
      (item) => item === document.activeElement,
    );
    const step = event.key === 'ArrowDown' ? 1 : -1;
    items.current[(at + step + formats.length) % formats.length]?.focus();
  };

  const isExperimental = (format: FormattedDownloadFormat): boolean =>
    format !== 'pdf' &&
    format !== 'document' &&
    NATIVE_PDF_EXPORT_FORMATS[format].experimental;
  const nameOf = (format: FormattedDownloadFormat): string =>
    t(FORMAT_LABELS[format].name, { extension: documentExtension });

  return (
    <div ref={root} className={`relative ${className}`} onKeyDown={onKeyDown}>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled || busy !== null}
        onClick={() => setOpen((was) => !was)}
        className="inline-flex items-center gap-1 rounded-lg border border-gray-300 px-2.5 py-1 font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
      >
        {busy
          ? t('translation.formatted.downloadBuilding', {
              format: nameOf(busy),
            })
          : t('translation.formatted.downloadMenu')}
        <IconChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={t('translation.formatted.downloadMenu')}
          className="absolute end-0 top-full z-30 mt-1 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-gray-200 bg-white p-1 text-start shadow-lg dark:border-gray-700 dark:bg-surface-dark"
        >
          {formats.map((format, index) => (
            <button
              key={format}
              ref={(element) => {
                items.current[index] = element;
              }}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onSelect(format);
              }}
              className="block w-full rounded-md px-2.5 py-2 text-start hover:bg-gray-100 focus-visible:bg-gray-100 dark:hover:bg-gray-800 dark:focus-visible:bg-gray-800"
            >
              <span className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                {nameOf(format)}
                {isExperimental(format) && (
                  <span className="rounded-full bg-amber-100 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                    {t('translation.formatted.experimental')}
                  </span>
                )}
              </span>
              <span className="mt-0.5 block text-xs font-normal text-gray-500 dark:text-gray-400">
                {t(FORMAT_LABELS[format].hint)}
                {behind && format !== 'pdf' && (
                  <> {t('translation.formatted.downloadWithChanges')}</>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
