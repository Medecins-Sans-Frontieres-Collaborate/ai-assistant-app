import { ReactElement, useCallback, useMemo, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { ExportFormat } from '@/client/hooks/document/exportFormats';
import { useM365Enabled } from '@/client/hooks/useM365Enabled';

import {
  M365SaveTarget,
  saveToOneDrive,
} from '@/client/services/m365/m365Client';
import { m365ErrorKind } from '@/client/services/m365/m365ErrorKinds';

import {
  fetchDocxBlob,
  htmlToMarkdown,
  htmlToPlainText,
  renderPdfBlob,
  sanitizeHtmlForExport,
} from '@/lib/utils/shared/document/exportUtils';

import type { M365SaveDestination } from '@/types/m365';

import M365SaveDestinationModal from '@/components/Chat/ChatInput/M365SaveDestinationModal';

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

/** One deferred save: everything needed to build and upload the export. */
export interface M365SavePayload {
  format: ExportFormat;
  html: string;
  baseFileName: string;
  markdownSource?: string;
}

export interface M365SaveController {
  save: (
    format: ExportFormat,
    html: string,
    baseFileName: string,
    markdownSource?: string,
  ) => Promise<void>;
  /** Render this near the call site — the destination dialog lives here. */
  dialog: ReactElement | null;
}

export async function buildBlob(
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
 * The default app folder is the ABSENCE of a destination (null), which maps
 * to no target at all — the server then writes to `/Apps/AI Assistant/`.
 * A destination with a null itemId targets the drive root (a SharePoint
 * document-library root), so parentId is omitted.
 */
export function destinationToTarget(
  destination: M365SaveDestination | null,
): M365SaveTarget | undefined {
  if (!destination) return undefined;
  return {
    driveId: destination.driveId,
    ...(destination.itemId && { parentId: destination.itemId }),
  };
}

/** Success toast shared by the auto-save path and the destination dialog. */
export function showSavedToast(options: {
  message: string;
  openLabel: string;
  webUrl?: string;
  toastId?: string;
}): void {
  toast.success(
    options.webUrl ? (
      <span>
        {options.message}{' '}
        <a
          href={options.webUrl}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-blue-600 underline dark:text-blue-400"
        >
          {options.openLabel}
        </a>
      </span>
    ) : (
      options.message
    ),
    { id: options.toastId, duration: 6000 },
  );
}

/**
 * Controller for "Save to OneDrive", mirroring `useDocumentExport`'s save
 * signature so both actions share call sites. By default `save` opens the
 * destination dialog (rendered via `dialog`); once the user has opted into
 * "always save here", it uploads straight to the remembered destination and
 * only toasts. Always user-initiated via the export menu.
 */
export function useM365Save(): M365SaveController {
  const t = useTranslations('m365.save');
  const [payload, setPayload] = useState<M365SavePayload | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const save = useCallback(
    async (
      format: ExportFormat,
      html: string,
      baseFileName: string,
      markdownSource?: string,
    ) => {
      const pending: M365SavePayload = {
        format,
        html,
        baseFileName,
        markdownSource,
      };
      const { m365SaveSkipPicker, m365SaveDestination } =
        useSettingsStore.getState();
      if (!m365SaveSkipPicker) {
        setPayload(pending);
        setDialogOpen(true);
        return;
      }
      const toastId = toast.loading(t('saving'));
      try {
        const blob = await buildBlob(format, html, markdownSource);
        const result = await saveToOneDrive(
          blob,
          `${baseFileName}.${format}`,
          destinationToTarget(m365SaveDestination),
        );
        showSavedToast({
          message: t('savedTo', {
            name: result.name,
            folder: m365SaveDestination?.pathLabel ?? t('defaultFolderPath'),
          }),
          openLabel: t('open'),
          webUrl: result.webUrl,
          toastId,
        });
      } catch (error) {
        const kind = m365ErrorKind(error);
        // A remembered folder can go stale (deleted → 404, access revoked →
        // 403); both recover by re-picking a destination for the same file.
        if (kind === 'notFound' || kind === 'forbidden') {
          const key =
            kind === 'notFound' ? 'destinationMissing' : 'destinationForbidden';
          toast.error(
            <span>
              {t(key)}{' '}
              <button
                type="button"
                onClick={() => {
                  toast.dismiss(toastId);
                  setPayload(pending);
                  setDialogOpen(true);
                }}
                className="font-medium text-blue-600 underline dark:text-blue-400"
              >
                {t('chooseFolder')}
              </button>
            </span>,
            { id: toastId, duration: 8000 },
          );
          return;
        }
        toast.error(
          t(kind === 'consentMissing' ? 'consentMissing' : 'failed'),
          {
            id: toastId,
          },
        );
      }
    },
    [t],
  );

  const dialog = useMemo(
    () => (
      <M365SaveDestinationModal
        isOpen={dialogOpen}
        onClose={() => setDialogOpen(false)}
        payload={payload}
      />
    ),
    [dialogOpen, payload],
  );

  return useMemo(() => ({ save, dialog }), [save, dialog]);
}
