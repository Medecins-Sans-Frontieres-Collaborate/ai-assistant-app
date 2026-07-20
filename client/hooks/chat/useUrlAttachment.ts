import { useCallback } from 'react';

import { useTranslations } from 'next-intl';

import {
  attachmentFileName,
  buildFailureDocument,
  buildPageDocument,
  makeTextFile,
} from '@/client/services/url/urlAttachment';
import {
  fetchUrlContent,
  hostnameOf,
  urlErrorKey,
} from '@/client/services/url/urlFetchClient';

import type { FilePreview } from '@/types/chat';

import { useChatInputStore } from '@/client/stores/chatInputStore';

/**
 * Turns a link into a chat attachment: fetch the page, reduce it to prose,
 * and push it through the normal upload pipeline so it gets the same tile,
 * progress, removal and payload handling as a picked file.
 *
 * A failed fetch still attaches — the document says what went wrong (see
 * `urlAttachment`). The tile is marked via `sourceError`, not `status`, so
 * the send button is never blocked and the content is never dropped.
 */
export function useUrlAttachment() {
  const t = useTranslations('urlFetch');

  const attachUrl = useCallback(
    async (rawUrl: string): Promise<void> => {
      const url = rawUrl.trim();
      if (!url) return;

      const store = useChatInputStore.getState();

      // Same link twice is a repeat, not a second source.
      const already = store.filePreviews.some((p) => p.sourceUrl === url);
      if (already) return;

      // A placeholder tile appears immediately, so a slow page reads as
      // "working" rather than as nothing having happened. `pending` also
      // blocks send while the fetch is in flight, which is what we want —
      // only *failure* must leave submission unblocked.
      const placeholderName = t('fetchingFile', {
        host: hostnameOf(url) || url,
      });
      const placeholder: FilePreview = {
        name: placeholderName,
        type: 'text/markdown',
        status: 'pending',
        previewUrl: '',
        sourceUrl: url,
      };
      store.setFilePreviews((prev) => [...prev, placeholder]);

      const result = await fetchUrlContent(url);

      const dropPlaceholder = (prev: FilePreview[]) =>
        prev.filter((p) => p.name !== placeholderName);

      let file: File;
      let sourceError: string | undefined;

      if (result.ok) {
        file = makeTextFile(
          attachmentFileName(result.page.title, result.page.resolvedUrl),
          buildPageDocument(result.page, {
            sourceLabel: t('doc.sourceLabel'),
            retrievedLabel: t('doc.retrievedLabel'),
          }),
        );
      } else {
        sourceError = t(urlErrorKey(result.code));
        file = makeTextFile(
          attachmentFileName('', url, { failed: true }),
          buildFailureDocument(url, {
            heading: t('doc.failureHeading'),
            sourceLabel: t('doc.sourceLabel'),
            attemptedLabel: t('doc.attemptedLabel'),
            reason: sourceError,
            hint: t('fallbackHint'),
          }),
        );
      }

      useChatInputStore.getState().setFilePreviews(dropPlaceholder);
      await useChatInputStore.getState().handleFileUpload([file]);

      // Tag the real tile once the upload pipeline has created it.
      //
      // `sourceUrl` keeps the URL as the user gave it, not the post-redirect
      // one: it is the dedupe key for a repeat paste, and a resolved URL
      // would no longer match what they pasted. The document itself records
      // the resolved address, so provenance is not lost.
      useChatInputStore
        .getState()
        .setFilePreviews((prev) =>
          prev.map((p) =>
            p.name === file.name ? { ...p, sourceUrl: url, sourceError } : p,
          ),
        );
    },
    [t],
  );

  return { attachUrl };
}
