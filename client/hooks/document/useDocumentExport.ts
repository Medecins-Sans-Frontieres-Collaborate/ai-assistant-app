'use client';

import { useCallback } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import {
  downloadFile,
  exportToDOCX,
  exportToPDF,
  htmlToMarkdown,
  htmlToPlainText,
} from '@/lib/utils/shared/document/exportUtils';

export type ExportFormat = 'html' | 'md' | 'txt' | 'pdf' | 'docx';

export type ExportAs = (
  format: ExportFormat,
  html: string,
  baseFileName: string,
) => Promise<void>;

/**
 * Shared document-export logic used by the DocumentArtifact panel and the
 * per-message Download menu. Takes HTML content and writes a file in the
 * requested format using utilities from `lib/utils/shared/document/exportUtils`.
 */
export function useDocumentExport(): ExportAs {
  const t = useTranslations();

  return useCallback<ExportAs>(
    async (format, html, baseFileName) => {
      if (!html) {
        toast.error(t('artifact.noContentToExport'));
        return;
      }

      try {
        switch (format) {
          case 'html':
            downloadFile(html, `${baseFileName}.html`, 'text/html');
            toast.success(t('artifact.exportedAsHtml'));
            break;

          case 'md': {
            const markdown = htmlToMarkdown(html);
            downloadFile(markdown, `${baseFileName}.md`, 'text/markdown');
            toast.success(t('artifact.exportedAsMarkdown'));
            break;
          }

          case 'txt': {
            const plainText = await htmlToPlainText(html);
            downloadFile(plainText, `${baseFileName}.txt`, 'text/plain');
            toast.success(t('artifact.exportedAsText'));
            break;
          }

          case 'pdf':
            toast.loading(t('artifact.generatingPdf'));
            await exportToPDF(html, `${baseFileName}.pdf`);
            toast.dismiss();
            toast.success(t('artifact.exportedAsPdf'));
            break;

          case 'docx':
            toast.loading(t('artifact.generatingDocx'));
            await exportToDOCX(html, `${baseFileName}.docx`);
            toast.dismiss();
            toast.success(t('artifact.exportedAsDocx'));
            break;
        }
      } catch (error) {
        console.error('Export error:', error);
        toast.error(
          t('artifact.failedToExportAs', { format: format.toUpperCase() }),
        );
      }
    },
    [t],
  );
}
