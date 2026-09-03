'use client';

import { IconDownload } from '@tabler/icons-react';
import { FC, useMemo, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { ExportFormat } from '@/client/hooks/document/exportFormats';
import { useDocumentExport } from '@/client/hooks/document/useDocumentExport';
import {
  useM365Save,
  useM365SaveAvailable,
} from '@/client/hooks/document/useM365Save';

import { appendCitationsToMarkdown } from '@/lib/utils/app/export/citationExport';
import { markdownToHtml } from '@/lib/utils/shared/document/formatConverter';
import { normalizeMathDelimiters } from '@/lib/utils/shared/markdown/normalizeMath';

import { Citation } from '@/types/rag';

import { DropdownPortal } from '@/components/UI/DropdownPortal';
import { ExportFormatMenu } from '@/components/UI/ExportFormatMenu';

interface MessageDownloadMenuProps {
  content: string;
  citations?: Citation[];
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
  citations,
  disabled = false,
  disabledTitle,
  fileName,
}) => {
  const t = useTranslations();
  const exportAs = useDocumentExport();
  const { save: saveToOneDrive, dialog: m365SaveDialog } = useM365Save();
  const oneDriveAvailable = useM365SaveAvailable();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [showMenu, setShowMenu] = useState(false);

  const resolvedFileName = useMemo(
    () => fileName ?? deriveFilename(content),
    [fileName, content],
  );

  const prepare = (format: ExportFormat) => {
    // Citations live outside the message body, so append them as a Sources
    // section before export — otherwise inline [n] markers reference nothing.
    // Normalized here and not only inside markdownToHtml, because the `md`
    // export never goes through markdownToHtml — it writes this string to disk
    // verbatim. Without this the .md file keeps the model's `\[ ... \]`, which
    // renders as raw TeX in every downstream tool, while the .docx alongside it
    // carries `$$ ... $$`. Idempotent, so the second pass inside
    // markdownToHtml is a no-op.
    const exportContent = normalizeMathDelimiters(
      appendCitationsToMarkdown(content, citations ?? [], t('chat.sources')),
    );
    // For non-md formats we precompute HTML from the markdown source. For md
    // we pass an empty `html` and let the hook write the markdown source
    // directly — keeping the empty-content check in one place (the hook).
    const html = format === 'md' ? '' : markdownToHtml(exportContent);
    return { exportContent, html };
  };

  const handleDownload = async (format: ExportFormat) => {
    setShowMenu(false);
    const { exportContent, html } = prepare(format);
    await exportAs(format, html, resolvedFileName, exportContent);
  };

  const handleSaveToOneDrive = async (format: ExportFormat) => {
    setShowMenu(false);
    const { exportContent, html } = prepare(format);
    await saveToOneDrive(format, html, resolvedFileName, exportContent);
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
        <ExportFormatMenu
          onSelect={handleDownload}
          onSaveToOneDrive={
            oneDriveAvailable ? handleSaveToOneDrive : undefined
          }
        />
      </DropdownPortal>

      {m365SaveDialog}
    </>
  );
};
