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

const FORMAT_LABEL_KEY: Record<ExportFormat, string> = {
  md: 'artifact.formatMarkdown',
  html: 'artifact.formatHtml',
  docx: 'artifact.formatDocx',
  txt: 'artifact.formatText',
  pdf: 'artifact.formatPdf',
};

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

          case 'pdf': {
            const loadingId = toast.loading(t('artifact.generatingPdf'));
            try {
              await exportToPDF(html, `${baseFileName}.pdf`);
              toast.success(t('artifact.exportedAsPdf'));
            } finally {
              toast.dismiss(loadingId);
            }
            break;
          }

          case 'docx': {
            const loadingId = toast.loading(t('artifact.generatingDocx'));
            try {
              await exportToDOCX(html, `${baseFileName}.docx`);
              toast.success(t('artifact.exportedAsDocx'));
            } finally {
              toast.dismiss(loadingId);
            }
            break;
          }

          default: {
            const exhaustive: never = format;
            throw new Error(`Unhandled export format: ${String(exhaustive)}`);
          }
        }
      } catch (error) {
        console.error('Export error:', error);
        const formatLabel = t(FORMAT_LABEL_KEY[format] ?? '');
        toast.error(
          t('artifact.failedToExportAs', {
            format: formatLabel || format.toUpperCase(),
          }),
        );
      }
    },
    [t],
  );
}
