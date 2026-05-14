'use client';

import { IconDownload } from '@tabler/icons-react';
import { FC, useRef, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import {
  ExportFormat,
  useDocumentExport,
} from '@/client/hooks/document/useDocumentExport';

import { downloadFile } from '@/lib/utils/shared/document/exportUtils';
import { markdownToHtml } from '@/lib/utils/shared/document/formatConverter';

import { DropdownPortal } from '@/components/UI/DropdownPortal';

interface MessageDownloadMenuProps {
  content: string;
  disabled?: boolean;
  disabledTitle?: string;
  fileName?: string;
}

export const MessageDownloadMenu: FC<MessageDownloadMenuProps> = ({
  content,
  disabled = false,
  disabledTitle,
  fileName = 'message',
}) => {
  const t = useTranslations();
  const exportAs = useDocumentExport();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [showMenu, setShowMenu] = useState(false);

  const handleDownload = async (format: ExportFormat) => {
    setShowMenu(false);

    if (!content) {
      toast.error(t('artifact.noContentToExport'));
      return;
    }

    // Markdown is the source of truth in chat messages; no HTML round-trip needed.
    if (format === 'md') {
      downloadFile(content, `${fileName}.md`, 'text/markdown');
      toast.success(t('artifact.exportedAsMarkdown'));
      return;
    }

    const html = markdownToHtml(content);
    await exportAs(format, html, fileName);
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
        onClick={
          disabled
            ? undefined
            : (e) => {
                e.stopPropagation();
                setShowMenu((prev) => !prev);
              }
        }
        disabled={disabled}
        aria-label={downloadLabel}
        aria-haspopup="menu"
        aria-expanded={showMenu}
        title={disabled ? disabledTitle : downloadLabel}
      >
        <IconDownload size={18} />
      </button>

      <DropdownPortal
        triggerRef={triggerRef}
        isOpen={showMenu}
        onClose={() => setShowMenu(false)}
        align="right"
      >
        <div
          role="menu"
          className="w-40 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-lg overflow-hidden"
        >
          <button
            role="menuitem"
            onClick={() => handleDownload('md')}
            className="w-full px-4 py-2 text-left text-sm text-neutral-900 dark:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
          >
            {t('artifact.formatMarkdown')}
          </button>
          <button
            role="menuitem"
            onClick={() => handleDownload('html')}
            className="w-full px-4 py-2 text-left text-sm text-neutral-900 dark:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
          >
            {t('artifact.formatHtml')}
          </button>
          <button
            role="menuitem"
            onClick={() => handleDownload('docx')}
            className="w-full px-4 py-2 text-left text-sm text-neutral-900 dark:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
          >
            {t('artifact.formatDocx')}
          </button>
          <button
            role="menuitem"
            onClick={() => handleDownload('txt')}
            className="w-full px-4 py-2 text-left text-sm text-neutral-900 dark:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
          >
            {t('artifact.formatText')}
          </button>
          <button
            role="menuitem"
            onClick={() => handleDownload('pdf')}
            className="w-full px-4 py-2 text-left text-sm text-neutral-900 dark:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
          >
            {t('artifact.formatPdf')}
          </button>
        </div>
      </DropdownPortal>
    </>
  );
};
