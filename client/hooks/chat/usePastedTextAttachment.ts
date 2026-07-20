import { useCallback } from 'react';

import { useTranslations } from 'next-intl';

import { makeTextFile } from '@/client/services/url/urlAttachment';

import {
  buildPastedTextDocument,
  pastedTextFileName,
} from '@/lib/utils/shared/paste/pastedText';

import { useChatInputStore } from '@/client/stores/chatInputStore';

/**
 * Turns an oversized paste into a chat attachment, pushing it through the
 * normal upload pipeline so it gets the same tile, progress, removal and
 * payload handling as a picked file.
 *
 * The sibling of `useUrlAttachment`, minus the network: the content is
 * already in the clipboard, so there is no placeholder tile and no failure
 * path — the attachment either exists immediately or the paste was never
 * large enough to divert.
 */
export function usePastedTextAttachment() {
  const t = useTranslations('pastedText');

  const attachPastedText = useCallback(
    async (rawText: string): Promise<void> => {
      const text = rawText.trim();
      if (!text) return;

      const file = makeTextFile(
        pastedTextFileName(text, t('fallbackName')),
        buildPastedTextDocument(text, {
          heading: t('doc.heading'),
          pastedLabel: t('doc.pastedLabel'),
        }),
      );

      // The same text pasted twice is a repeat, not a second source — and
      // `pastedTextFileName` is deterministic, so the name is the dedupe key.
      const already = useChatInputStore
        .getState()
        .filePreviews.some((p) => p.name === file.name);
      if (already) return;

      await useChatInputStore.getState().handleFileUpload([file]);
    },
    [t],
  );

  return { attachPastedText };
}
