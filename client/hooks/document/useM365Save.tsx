import { useCallback } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { ExportFormat } from '@/client/hooks/document/exportFormats';
import { useM365Enabled } from '@/client/hooks/useM365Enabled';

import {
  M365ClientError,
  saveToOneDrive,
} from '@/client/services/m365/m365Client';

import {
  fetchDocxBlob,
  htmlToMarkdown,
  htmlToPlainText,
  renderPdfBlob,
  sanitizeHtmlForExport,
} from '@/lib/utils/shared/document/exportUtils';

import { useSettingsStore } from '@/client/stores/settingsStore';

/**
 * Whether the "Save to OneDrive" action should exist at all: the m365Files
 * capability (fail-closed flag with a localhost escape hatch — see
 * useM365Enabled) AND the user must have connected Microsoft 365 in
 * Settings → Connections.
 */
export function useM365SaveAvailable(): boolean {
  const { filesEnabled } = useM365Enabled();
  const m365Connected = useSettingsStore((s) => s.m365Connected);
  return filesEnabled && m365Connected;
}

async function buildBlob(
  format: ExportFormat,
  html: string,
  markdownSource?: string,
): Promise<Blob> {
  switch (format) {
    case 'md':
      return new Blob([markdownSource ?? htmlToMarkdown(html)], {
        type: 'text/markdown',
      });
    case 'html':
      return new Blob([await sanitizeHtmlForExport(html)], {
        type: 'text/html',
      });
    case 'txt':
      return new Blob([await htmlToPlainText(html)], { type: 'text/plain' });
    case 'docx':
      return fetchDocxBlob(html);
    case 'pdf':
      return renderPdfBlob(await sanitizeHtmlForExport(html));
    default: {
      const exhaustive: never = format;
      throw new Error(`Unknown format: ${exhaustive}`);
    }
  }
}

/**
 * Saves an export to the user's OneDrive (`/Apps/AI Assistant/`), mirroring
 * `useDocumentExport`'s signature so both actions share call sites. Always
 * user-initiated via the export menu; failures toast with specific copy for
 * a pending tenant consent.
 */
export function useM365Save(): (
  format: ExportFormat,
  html: string,
  baseFileName: string,
  markdownSource?: string,
) => Promise<void> {
  const t = useTranslations('m365.save');

  return useCallback(
    async (format, html, baseFileName, markdownSource) => {
      const toastId = toast.loading(t('saving'));
      try {
        const blob = await buildBlob(format, html, markdownSource);
        const result = await saveToOneDrive(blob, `${baseFileName}.${format}`);
        toast.success(
          result.webUrl ? (
            <span>
              {t('saved', { name: result.name })}{' '}
              <a
                href={result.webUrl}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-blue-600 underline dark:text-blue-400"
              >
                {t('open')}
              </a>
            </span>
          ) : (
            t('saved', { name: result.name })
          ),
          { id: toastId, duration: 6000 },
        );
      } catch (error) {
        const key =
          error instanceof M365ClientError &&
          error.code === 'M365_CONSENT_MISSING'
            ? 'consentMissing'
            : 'failed';
        toast.error(t(key), { id: toastId });
      }
    },
    [t],
  );
}
