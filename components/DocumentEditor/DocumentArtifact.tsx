'use client';

import {
  IconChevronDown,
  IconCode,
  IconDownload,
  IconFileText,
  IconX,
} from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { useTheme } from '@/client/hooks/ui/useTheme';

import {
  downloadFile as downloadFileUtil,
  exportToDOCX,
  exportToPDF,
  htmlToMarkdown,
  htmlToPlainText,
} from '@/lib/utils/shared/document/exportUtils';

import DocumentEditor from './DocumentEditor';

import { useArtifactStore } from '@/client/stores/artifactStore';

interface DocumentArtifactProps {
  onClose: () => void;
  onSwitchToCode: () => void;
}

/**
 * DocumentArtifact - Rich text document editor
 *
 * Appears as a split panel for editing documents, markdown, notes, etc.
 * Uses TipTap for WYSIWYG editing with formatting toolbar.
 */
export default function DocumentArtifact({
  onClose,
  onSwitchToCode,
}: DocumentArtifactProps) {
  const t = useTranslations();
  const theme = useTheme();
  const { fileName, modifiedCode, setFileName, setIsEditorOpen } =
    useArtifactStore();

  const [isEditing, setIsEditing] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);

  // Track that editor is open
  useEffect(() => {
    setIsEditorOpen(true);
    return () => setIsEditorOpen(false);
  }, [setIsEditorOpen]);

  // Close export menu when clicking outside
  useEffect(() => {
    const handleClickOutside = () => setShowExportMenu(false);
    if (showExportMenu) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [showExportMenu]);

  const getBaseFileName = () => {
    return fileName.replace(/\.[^/.]+$/, '');
  };

  const handleExport = async (
    format: 'html' | 'md' | 'txt' | 'pdf' | 'docx',
  ) => {
    if (!modifiedCode) {
      toast.error(t('artifact.noContentToExport'));
      return;
    }

    try {
      const baseFileName = getBaseFileName();

      switch (format) {
        case 'html':
          downloadFileUtil(modifiedCode, `${baseFileName}.html`, 'text/html');
          toast.success(t('artifact.exportedAsHtml'));
          break;

        case 'md': {
          const markdown = htmlToMarkdown(modifiedCode);
          downloadFileUtil(markdown, `${baseFileName}.md`, 'text/markdown');
          toast.success(t('artifact.exportedAsMarkdown'));
          break;
        }

        case 'txt': {
          const plainText = await htmlToPlainText(modifiedCode);
          downloadFileUtil(plainText, `${baseFileName}.txt`, 'text/plain');
          toast.success(t('artifact.exportedAsText'));
          break;
        }

        case 'pdf':
          toast.loading(t('artifact.generatingPdf'));
          await exportToPDF(modifiedCode, `${baseFileName}.pdf`);
          toast.dismiss();
          toast.success(t('artifact.exportedAsPdf'));
          break;

        case 'docx':
          toast.loading(t('artifact.generatingDocx'));
          await exportToDOCX(modifiedCode, `${baseFileName}.docx`);
          toast.dismiss();
          toast.success(t('artifact.exportedAsDocx'));
          break;
      }

      setShowExportMenu(false);
    } catch (error) {
      console.error('Export error:', error);
      toast.error(
        t('artifact.failedToExportAs', { format: format.toUpperCase() }),
      );
    }
  };

  return (
    <div className="flex flex-col h-full w-full min-w-0">
      {/* Toolbar */}
      <div className="relative flex items-center justify-between px-4 py-3 border-b border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 flex-shrink-0 min-w-0 overflow-hidden">
        {/* Left: Filename and Mode */}
        <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
          {isEditing ? (
            <input
              type="text"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              onBlur={() => setIsEditing(false)}
              onKeyDown={(e) => e.key === 'Enter' && setIsEditing(false)}
              className="text-sm font-medium bg-neutral-100 dark:bg-neutral-900/50 rounded px-2 py-1 border-none focus:outline-none focus:ring-1 focus:ring-blue-500 dark:text-white"
              autoFocus
            />
          ) : (
            <button
              onClick={() => setIsEditing(true)}
              className="text-sm font-medium bg-neutral-100 dark:bg-neutral-900/50 rounded px-2 py-1 hover:bg-neutral-200 dark:hover:bg-neutral-900 transition-colors dark:text-white truncate"
            >
              {fileName}
            </button>
          )}
          <span className="text-xs text-neutral-500 dark:text-neutral-400 flex items-center gap-1 flex-shrink-0">
            <IconFileText size={14} />
            {t('artifact.document')}
          </span>
        </div>

        {/* Right: Action Buttons */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            onClick={onSwitchToCode}
            className="p-2 rounded-lg text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors"
            title={t('artifact.switchToCodeEditor')}
          >
            <IconCode size={18} />
          </button>

          {/* Export Dropdown */}
          <div className="relative">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowExportMenu(!showExportMenu);
              }}
              disabled={!modifiedCode}
              className="flex items-center gap-1 px-2 py-2 rounded-lg text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title={t('artifact.exportDocument')}
            >
              <IconDownload size={18} />
              <IconChevronDown size={14} />
            </button>

            {/* Export Menu */}
            {showExportMenu && (
              <div className="absolute right-0 mt-1 w-40 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-lg z-50 overflow-hidden">
                <button
                  onClick={() => handleExport('md')}
                  className="w-full px-4 py-2 text-left text-sm text-neutral-900 dark:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
                >
                  {t('artifact.formatMarkdown')}
                </button>
                <button
                  onClick={() => handleExport('html')}
                  className="w-full px-4 py-2 text-left text-sm text-neutral-900 dark:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
                >
                  {t('artifact.formatHtml')}
                </button>
                <button
                  onClick={() => handleExport('docx')}
                  className="w-full px-4 py-2 text-left text-sm text-neutral-900 dark:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
                >
                  {t('artifact.formatDocx')}
                </button>
                <button
                  onClick={() => handleExport('txt')}
                  className="w-full px-4 py-2 text-left text-sm text-neutral-900 dark:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
                >
                  {t('artifact.formatText')}
                </button>
                <button
                  onClick={() => handleExport('pdf')}
                  className="w-full px-4 py-2 text-left text-sm text-neutral-900 dark:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
                >
                  {t('artifact.formatPdf')}
                </button>
              </div>
            )}
          </div>

          <div className="w-px h-5 bg-neutral-300 dark:bg-neutral-700 mx-1" />

          <button
            onClick={onClose}
            className="p-2 rounded-lg text-neutral-700 dark:text-neutral-300 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-600 dark:hover:text-red-400 transition-colors"
            title={t('artifact.close')}
          >
            <IconX size={18} />
          </button>
        </div>
      </div>

      {/* Document Editor */}
      <div className="flex-1 overflow-hidden min-h-0 min-w-0">
        <DocumentEditor theme={theme} />
      </div>

      {/* Disclaimer Footer */}
      <div className="px-4 py-2 border-t border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 flex-shrink-0">
        <p className="text-xs text-center text-neutral-500 dark:text-neutral-400">
          {t('artifact.editsNotSaved')}
        </p>
      </div>
    </div>
  );
}
