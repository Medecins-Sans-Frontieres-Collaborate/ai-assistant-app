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
  sanitizeHtmlForExport,
} from '@/lib/utils/shared/document/exportUtils';

export const EXPORT_FORMATS = [
  { format: 'md', labelKey: 'artifact.formatMarkdown' },
  { format: 'html', labelKey: 'artifact.formatHtml' },
  { format: 'docx', labelKey: 'artifact.formatDocx' },
  { format: 'txt', labelKey: 'artifact.formatText' },
  { format: 'pdf', labelKey: 'artifact.formatPdf' },
] as const;

export type ExportFormat = (typeof EXPORT_FORMATS)[number]['format'];

const LABEL_KEY_BY_FORMAT: Record<ExportFormat, string> = Object.fromEntries(
  EXPORT_FORMATS.map(({ format, labelKey }) => [format, labelKey]),
) as Record<ExportFormat, string>;

type ExportFn = (
  format: ExportFormat,
  html: string,
  baseFileName: string,
) => Promise<void>;

async function withLoadingToast<T>(
  loadingMessage: string,
  successMessage: string,
  fn: () => Promise<T>,
): Promise<T> {
  const loadingId = toast.loading(loadingMessage);
  let settled = false;
  try {
    const result = await fn();
    // Dismiss the loading toast before showing success so users don't see two
    // toasts stacked momentarily. The error path still dismisses via finally.
    toast.dismiss(loadingId);
    settled = true;
    toast.success(successMessage);
    return result;
  } finally {
    if (!settled) toast.dismiss(loadingId);
  }
}

/**
 * Shared document-export logic used by the DocumentArtifact panel and the
 * per-message Download menu. Takes HTML content and writes a file in the
 * requested format using utilities from `lib/utils/shared/document/exportUtils`.
 */
export function useDocumentExport(): ExportFn {
  const t = useTranslations();

  return useCallback<ExportFn>(
    async (format, html, baseFileName) => {
      if (!html) {
        toast.error(t('artifact.noContentToExport'));
        return;
      }

      try {
        switch (format) {
          case 'html': {
            // The exported file will be opened in a browser. Strip scripts and
            // event handlers so a prompt-injected `<script>` / `onerror` in the
            // assistant's response can't execute on the user's machine.
            const safeHtml = await sanitizeHtmlForExport(html);
            downloadFile(safeHtml, `${baseFileName}.html`, 'text/html');
            toast.success(t('artifact.exportedAsHtml'));
            break;
          }

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
            // html2pdf renders the HTML in a transient DOM; sanitize first so
            // injected scripts can't run during the render pass.
            const safePdfHtml = await sanitizeHtmlForExport(html);
            await withLoadingToast(
              t('artifact.generatingPdf'),
              t('artifact.exportedAsPdf'),
              () => exportToPDF(safePdfHtml, `${baseFileName}.pdf`),
            );
            break;
          }

          case 'docx':
            await withLoadingToast(
              t('artifact.generatingDocx'),
              t('artifact.exportedAsDocx'),
              () => exportToDOCX(html, `${baseFileName}.docx`),
            );
            break;

          default: {
            const exhaustive: never = format;
            throw new Error(`Unhandled export format: ${String(exhaustive)}`);
          }
        }
      } catch (error) {
        console.error('Export error:', error);
        toast.error(
          t('artifact.failedToExportAs', {
            format: t(LABEL_KEY_BY_FORMAT[format]),
          }),
        );
      }
    },
    [t],
  );
}
