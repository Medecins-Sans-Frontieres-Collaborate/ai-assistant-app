'use client';

import { FC } from 'react';

import { useTranslations } from 'next-intl';

import {
  EXPORT_FORMATS,
  ExportFormat,
} from '@/client/hooks/document/useDocumentExport';

interface ExportFormatMenuProps {
  onSelect: (format: ExportFormat) => void;
}

/**
 * Renders the styled panel of export-format buttons that opens from the
 * Download / Export trigger in both the chat message action row and the
 * DocumentArtifact toolbar. Designed to be placed inside a `DropdownPortal`.
 */
export const ExportFormatMenu: FC<ExportFormatMenuProps> = ({ onSelect }) => {
  const t = useTranslations();

  return (
    <div
      role="menu"
      className="w-40 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-lg overflow-hidden"
    >
      {EXPORT_FORMATS.map(({ format, labelKey }) => (
        <button
          key={format}
          role="menuitem"
          onClick={() => onSelect(format)}
          className="w-full px-4 py-2 text-left text-sm text-neutral-900 dark:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
        >
          {t(labelKey)}
        </button>
      ))}
    </div>
  );
};
