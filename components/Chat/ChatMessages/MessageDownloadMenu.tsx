'use client';

import { IconDownload } from '@tabler/icons-react';
import { FC, useMemo, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { ExportFormat } from '@/client/hooks/document/exportFormats';
import { useDocumentExport } from '@/client/hooks/document/useDocumentExport';

import { markdownToHtml } from '@/lib/utils/shared/document/formatConverter';

import { DropdownPortal } from '@/components/UI/DropdownPortal';
import { ExportFormatMenu } from '@/components/UI/ExportFormatMenu';

interface MessageDownloadMenuProps {
  content: string;
  disabled?: boolean;
  disabledTitle?: string;
  fileName?: string;
}

// Derives a default filename from the first words of the message. Preserves
// Unicode so non-Latin responses still get a meaningful name. Falls back to
// "message" if nothing usable remains after stripping markdown chrome.
function deriveFilename(content: string): string {
  const stripped = content
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return 'message';
  // Slice by code points (not UTF-16 units) so emoji / non-BMP CJK don't get
  // cut mid-surrogate-pair and render as U+FFFD in the filename.
  const candidate = Array.from(stripped).slice(0, 60).join('').trim();
  // Strip Windows-reserved chars, plus trailing dots/spaces so a heading
  // ending in "." doesn't produce "Title..md".
  const safe = candidate
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/[.\s]+$/, '')
    .trim();
  return safe || 'message';
}

export const MessageDownloadMenu: FC<MessageDownloadMenuProps> = ({
  content,
  disabled = false,
  disabledTitle,
  fileName,
}) => {
  const t = useTranslations();
  const exportAs = useDocumentExport();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [showMenu, setShowMenu] = useState(false);

  const resolvedFileName = useMemo(
    () => fileName ?? deriveFilename(content),
    [fileName, content],
  );

  const handleDownload = async (format: ExportFormat) => {
    setShowMenu(false);
    // For non-md formats we precompute HTML from the markdown source. For md
    // we pass an empty `html` and let the hook write the markdown source
    // directly — keeping the empty-content check in one place (the hook).
    const html = format === 'md' ? '' : markdownToHtml(content);
    await exportAs(format, html, resolvedFileName, content);
  };

  const triggerClass = disabled
    ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
    : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300';

  const downloadLabel = t('chat.downloadResponse');

  return (
    <>
      <button
        ref={triggerRef}
        className={`transition-colors ${triggerClass}`}
        onClick={(e) => {
          e.stopPropagation();
          setShowMenu((prev) => !prev);
        }}
        disabled={disabled}
        aria-label={downloadLabel}
        aria-haspopup="menu"
        aria-expanded={showMenu}
        title={disabled ? disabledTitle : undefined}
      >
        <IconDownload size={18} />
      </button>

      <DropdownPortal
        triggerRef={triggerRef}
        isOpen={showMenu}
        onClose={() => setShowMenu(false)}
        align="right"
      >
        <ExportFormatMenu onSelect={handleDownload} />
      </DropdownPortal>
    </>
  );
};
