'use client';

import { IconBrandOnedrive } from '@tabler/icons-react';
import { FC } from 'react';

import { useTranslations } from 'next-intl';

import {
  EXPORT_FORMATS,
  ExportFormat,
} from '@/client/hooks/document/exportFormats';

interface ExportFormatMenuProps {
  onSelect: (format: ExportFormat) => void;
  /**
   * When set, a "Save to OneDrive" action is appended under a divider.
   * Callers pass it only when the M365 files feature is flagged on AND the
   * user has connected Microsoft 365 (see useM365SaveAvailable). The save is
   * always this explicit user click — never triggered from model output.
   */
  onSaveToOneDrive?: (format: ExportFormat) => void;
}

/**
 * Renders the styled panel of export-format buttons that opens from the
 * Download / Export trigger in both the chat message action row and the
 * DocumentArtifact toolbar. Designed to be placed inside a `DropdownPortal`.
 */
export const ExportFormatMenu: FC<ExportFormatMenuProps> = ({
  onSelect,
  onSaveToOneDrive,
}) => {
  const t = useTranslations();
  const tM365 = useTranslations('m365.save');

  return (
    <div
      role="menu"
      className="w-44 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-lg overflow-hidden"
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
      {onSaveToOneDrive && (
        <>
          <div className="border-t border-neutral-200 dark:border-neutral-700" />
          <div className="px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            {tM365('sectionLabel')}
          </div>
          {EXPORT_FORMATS.map(({ format, labelKey }) => (
            <button
              key={`onedrive-${format}`}
              role="menuitem"
              onClick={() => onSaveToOneDrive(format)}
              className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-neutral-900 dark:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
            >
              <IconBrandOnedrive
                size={15}
                className="flex-shrink-0 text-blue-500"
              />
              {t(labelKey)}
            </button>
          ))}
        </>
      )}
    </div>
  );
};
