import { useCallback } from 'react';

import { useTranslations } from 'next-intl';

import { useM365Enabled } from '@/client/hooks/useM365Enabled';

import {
  downloadDriveItem,
  fetchMailImport,
  importDriveItemToStorage,
} from '@/client/services/m365/m365Client';
import {
  M365ErrorKind,
  m365ErrorKind,
} from '@/client/services/m365/m365ErrorKinds';
import {
  buildFailureDocument,
  makeTextFile,
} from '@/client/services/url/urlAttachment';

import type { FileMessageContent, FilePreview } from '@/types/chat';
import type { M365DriveEntry, M365MailEnvelope } from '@/types/m365';

import { useChatInputStore } from '@/client/stores/chatInputStore';
import { getFileCategory } from '@/lib/constants/fileLimits';

/**
 * Attaches OneDrive/SharePoint files and Outlook messages to the chat by
 * pushing them through the normal upload pipeline — the same pattern as
 * `useUrlAttachment`: pending placeholder while fetching, then a real File
 * via `handleFileUpload`, with failures attached as an explanatory document
 * marked by `sourceError` (never a blocked send, never a silent drop).
 */

/**
 * Removes the pending placeholder for one attachment. Keyed by the unique
 * sourceKey (stored as the placeholder's sourceUrl), never the display name:
 * two different files can legitimately share a name (report.docx in two
 * folders), and a name-keyed filter would remove both placeholders when the
 * first one finishes.
 */
function removePlaceholder(sourceKey: string): void {
  useChatInputStore
    .getState()
    .setFilePreviews((prev) =>
      prev.filter(
        (p) => !(p.sourceUrl === sourceKey && p.status === 'pending'),
      ),
    );
}

/**
 * Tags the tile `handleFileUpload` created for `file` with its M365 source.
 * The upload pipeline only exposes tiles by name at this seam, so claim
 * exactly ONE tile — the first name match whose sourceUrl is still unset.
 * A plain name match would tag every same-named tile (including ones a
 * concurrent attachment already claimed) with this attachment's source.
 */
function tagUploadedTile(
  fileName: string,
  sourceUrl: string,
  sourceError?: string,
): void {
  useChatInputStore.getState().setFilePreviews((prev) => {
    const index = prev.findIndex(
      (p) => p.name === fileName && p.sourceUrl === undefined,
    );
    if (index === -1) return prev;
    return prev.map((p, i) =>
      i === index
        ? { ...p, sourceUrl, ...(sourceError && { sourceError }) }
        : p,
    );
  });
}

const ERROR_KIND_KEYS: Partial<Record<M365ErrorKind, string>> = {
  consentMissing: 'errors.consentMissing',
  notConnected: 'errors.notConnected',
  fileTooLarge: 'errors.fileTooLarge',
  notFound: 'errors.notFound',
  forbidden: 'errors.forbidden',
  network: 'errors.network',
  rateLimited: 'errors.rateLimited',
};

function errorKey(error: unknown): string {
  return ERROR_KIND_KEYS[m365ErrorKind(error)] ?? 'errors.generic';
}

export function useM365Attachment() {
  const t = useTranslations('m365');
  // §3 third pass: audio/video imports go server-side (Graph → blob) so a
  // 500MB SharePoint MP4 never round-trips through the browser.
  const { transcriptionEnabled } = useM365Enabled();

  /**
   * Registers a file that already lives in upload storage — the same three
   * store writes `onFileUpload` performs after a successful local upload
   * (file field value, submit type, completed tile).
   */
  const registerImportedUpload = useCallback(
    (imported: {
      uri: string;
      name: string;
      mimeType: string;
      webUrl?: string;
    }) => {
      const store = useChatInputStore.getState();
      const fileMessage: FileMessageContent = {
        type: 'file_url',
        url: imported.uri,
        originalFilename: imported.name,
      };
      store.setFileFieldValue((prevValue) => {
        if (prevValue && Array.isArray(prevValue)) {
          return [...prevValue, fileMessage];
        }
        if (prevValue) return [prevValue, fileMessage];
        return [fileMessage];
      });
      store.setSubmitType((prevType) => {
        if (prevType === 'IMAGE' || prevType === 'MULTI_FILE') {
          return 'MULTI_FILE';
        }
        return 'FILE';
      });
      const tile: FilePreview = {
        name: imported.name,
        type: imported.mimeType,
        status: 'completed',
        previewUrl: '',
        uploadedUrl: imported.uri,
        ...(imported.webUrl && { sourceUrl: imported.webUrl }),
      };
      store.setFilePreviews((prev) => [...prev, tile]);
    },
    [],
  );

  /** Server-side import path: pending tile → blob import → completed tile. */
  const attachDriveItemViaStorage = useCallback(
    async (entry: M365DriveEntry): Promise<void> => {
      const store = useChatInputStore.getState();
      const sourceKey =
        entry.webUrl ?? `m365://${entry.driveId}/${entry.itemId}`;
      if (store.filePreviews.some((p) => p.sourceUrl === sourceKey)) return;

      const placeholder: FilePreview = {
        name: t('attach.fetching', { name: entry.name }),
        type: 'text/markdown',
        status: 'pending',
        previewUrl: '',
        sourceUrl: sourceKey,
      };
      store.setFilePreviews((prev) => [...prev, placeholder]);

      try {
        const imported = await importDriveItemToStorage(
          entry.driveId,
          entry.itemId,
        );
        removePlaceholder(sourceKey);
        // Fall back to the sourceKey so the tile always carries the dedupe
        // key, even when the import response has no webUrl.
        registerImportedUpload({
          ...imported,
          webUrl: imported.webUrl ?? sourceKey,
        });
      } catch (error) {
        // Same invariant as the browser path: the failure becomes an
        // explanatory attachment, never a silent drop.
        const sourceError = t(errorKey(error));
        const file = makeTextFile(
          `${entry.name}-unavailable.md`,
          buildFailureDocument(sourceKey, {
            heading: t('doc.failureHeading'),
            sourceLabel: t('doc.sourceLabel'),
            attemptedLabel: t('doc.attemptedLabel'),
            reason: sourceError,
            hint: t('doc.failureHint'),
          }),
        );
        removePlaceholder(sourceKey);
        await useChatInputStore.getState().handleFileUpload([file]);
        tagUploadedTile(file.name, sourceKey, sourceError);
      }
    },
    [registerImportedUpload, t],
  );

  const runAttachment = useCallback(
    async (
      sourceKey: string,
      placeholderName: string,
      fetchFile: () => Promise<{ file: File; webUrl?: string }>,
      failureName: string,
    ): Promise<void> => {
      const store = useChatInputStore.getState();

      // Same source twice is a repeat, not a second attachment.
      if (store.filePreviews.some((p) => p.sourceUrl === sourceKey)) return;

      const placeholder: FilePreview = {
        name: placeholderName,
        type: 'text/markdown',
        status: 'pending',
        previewUrl: '',
        sourceUrl: sourceKey,
      };
      store.setFilePreviews((prev) => [...prev, placeholder]);

      let file: File;
      let sourceError: string | undefined;
      let webUrl: string | undefined;
      try {
        const result = await fetchFile();
        file = result.file;
        webUrl = result.webUrl;
      } catch (error) {
        sourceError = t(errorKey(error));
        file = makeTextFile(
          failureName,
          buildFailureDocument(sourceKey, {
            heading: t('doc.failureHeading'),
            sourceLabel: t('doc.sourceLabel'),
            attemptedLabel: t('doc.attemptedLabel'),
            reason: sourceError,
            hint: t('doc.failureHint'),
          }),
        );
      }

      removePlaceholder(sourceKey);
      await useChatInputStore.getState().handleFileUpload([file]);

      // Tag the tile the pipeline created: sourceUrl is the dedupe key and
      // drives the link badge; webUrl (when known) makes the badge clickable
      // to the real M365 location.
      tagUploadedTile(file.name, webUrl ?? sourceKey, sourceError);
    },
    [t],
  );

  const attachDriveItem = useCallback(
    async (entry: M365DriveEntry): Promise<void> => {
      // Audio/video routes server-side when §3 is on — the transcription
      // pipeline reads from upload storage anyway, so the bytes should
      // never pass through the browser.
      const category = getFileCategory(entry.name, entry.mimeType);
      if (
        transcriptionEnabled &&
        (category === 'audio' || category === 'video')
      ) {
        await attachDriveItemViaStorage(entry);
        return;
      }
      const sourceKey =
        entry.webUrl ?? `m365://${entry.driveId}/${entry.itemId}`;
      await runAttachment(
        sourceKey,
        t('attach.fetching', { name: entry.name }),
        async () => {
          const download = await downloadDriveItem(entry.driveId, entry.itemId);
          return {
            file: new File([download.blob], download.name, {
              type: download.blob.type || 'application/octet-stream',
            }),
            webUrl: download.webUrl ?? entry.webUrl,
          };
        },
        `${entry.name}-unavailable.md`,
      );
    },
    [runAttachment, t, transcriptionEnabled, attachDriveItemViaStorage],
  );

  const attachMail = useCallback(
    async (
      envelope: M365MailEnvelope,
      mode: 'message' | 'thread',
    ): Promise<void> => {
      const sourceKey = `m365-mail://${mode}/${
        mode === 'thread' && envelope.conversationId
          ? envelope.conversationId
          : envelope.id
      }`;
      await runAttachment(
        sourceKey,
        t('attach.fetchingMail', { subject: envelope.subject }),
        async () => {
          const result = await fetchMailImport(
            mode === 'thread' && envelope.conversationId
              ? { conversationId: envelope.conversationId }
              : { messageId: envelope.id },
          );
          return {
            file: makeTextFile(result.fileName, result.markdown),
            webUrl: result.webLink ?? envelope.webLink,
          };
        },
        `${envelope.subject.slice(0, 40)}-unavailable.md`,
      );
    },
    [runAttachment, t],
  );

  return {
    attachDriveItem,
    attachMail,
    /** §4: register a server-imported upload (e.g. meeting recording). */
    attachImportedUpload: registerImportedUpload,
  };
}
