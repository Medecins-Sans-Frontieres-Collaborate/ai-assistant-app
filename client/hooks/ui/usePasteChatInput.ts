import { RefObject, useEffect, useRef } from 'react';

import { usePastedTextAttachment } from '@/client/hooks/chat/usePastedTextAttachment';
import { useUrlAttachment } from '@/client/hooks/chat/useUrlAttachment';

import { isLikelyUrl } from '@/client/services/url/urlFetchClient';

import { shouldAttachPastedText } from '@/lib/utils/shared/paste/pastedText';

import { useChatInputStore } from '@/client/stores/chatInputStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import { useUIStore } from '@/client/stores/uiStore';

interface UsePasteChatInputOptions {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  enabled: boolean;
}

/**
 * Extracts image files from clipboard data, renaming each one. Clipboard
 * screenshots all arrive as `image.png`, but the upload pipeline keys
 * progress and previews by filename, so duplicate names would cross-match.
 */
function extractImageFiles(clipboardData: DataTransfer): File[] {
  const files: File[] = [];
  for (let i = 0; i < clipboardData.items.length; i++) {
    const item = clipboardData.items[i];
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (!file) continue;
    const ext = file.type.split('/')[1]?.split('+')[0] ?? 'png';
    files.push(
      new File([file], `pasted-image-${Date.now()}-${files.length}.${ext}`, {
        type: file.type,
      }),
    );
  }
  return files;
}

/**
 * Handles clipboard pastes anywhere on the chat page:
 * - Pasted images are attached via the file upload pipeline. When the
 *   clipboard holds both an image and text (e.g. copied from Word), the
 *   image is attached and the text is dropped.
 * - Pasted text while the chat textarea is not focused is appended to the
 *   input and focuses it, mirroring the typing auto-focus behavior.
 */
export function usePasteChatInput({
  textareaRef,
  enabled,
}: UsePasteChatInputOptions) {
  const { attachUrl } = useUrlAttachment();
  const { attachPastedText } = usePastedTextAttachment();
  // Held in refs so the listener never needs re-binding when the callback
  // identities change. Written in an effect, never during render.
  const attachUrlRef = useRef(attachUrl);
  const attachPastedTextRef = useRef(attachPastedText);
  useEffect(() => {
    attachUrlRef.current = attachUrl;
  }, [attachUrl]);
  useEffect(() => {
    attachPastedTextRef.current = attachPastedText;
  }, [attachPastedText]);

  useEffect(() => {
    if (!enabled) return;

    const handlePaste = (event: ClipboardEvent) => {
      const clipboardData = event.clipboardData;
      if (!clipboardData) return;

      // Skip if a modal is open
      const { isSettingsOpen, isBotModalOpen, isTermsModalOpen } =
        useUIStore.getState();
      if (isSettingsOpen || isBotModalOpen || isTermsModalOpen) return;

      const textarea = textareaRef.current;
      if (!textarea) return;

      // Never hijack pastes into other editable elements
      const target = event.target;
      if (target instanceof HTMLElement && target !== textarea) {
        const tagName = target.tagName.toUpperCase();
        if (
          tagName === 'INPUT' ||
          tagName === 'TEXTAREA' ||
          target.isContentEditable
        ) {
          return;
        }
      }

      const imageFiles = extractImageFiles(clipboardData);
      if (imageFiles.length > 0) {
        event.preventDefault();
        void useChatInputStore
          .getState()
          .handleFileUpload(imageFiles)
          .finally(() => {
            // The textarea is disabled (and force-blurred) while the upload
            // is in flight; restore focus once it settles unless the user
            // has moved to another control in the meantime.
            setTimeout(() => {
              const active = document.activeElement;
              if (!active || active === document.body) {
                textareaRef.current?.focus();
              }
            }, 0);
          });
        textarea.focus();
        return;
      }

      const text = clipboardData.getData('text/plain');

      // A pasted link becomes an attachment instead of composer text. The
      // paste is swallowed: once the page content is attached, the raw URL
      // adds nothing and would just have to be deleted by hand.
      // Only a clipboard holding nothing but a single link qualifies; pasting
      // prose that happens to contain links must not trigger a fetch.
      if (
        text &&
        isLikelyUrl(text) &&
        useSettingsStore.getState().autoFetchPastedLinks
      ) {
        event.preventDefault();
        void attachUrlRef.current(text.trim());
        textarea.focus();
        return;
      }

      // A paste far too large to read in the composer is a document, not a
      // sentence. Attaching it keeps the composer free for the actual
      // question — and unlike the branches below, this applies even when the
      // textarea is already focused, since that is the common case for a
      // deliberate bulk paste.
      if (
        text &&
        shouldAttachPastedText(
          text,
          useSettingsStore.getState().pasteAsAttachmentChars,
        )
      ) {
        event.preventDefault();
        void attachPastedTextRef.current(text);
        textarea.focus();
        return;
      }

      // Native paste already works when the textarea itself is focused
      if (target === textarea) return;

      if (!text) return;

      event.preventDefault();
      useChatInputStore
        .getState()
        .setTextFieldValue((prev: string) => prev + text);
      textarea.focus();
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [enabled, textareaRef]);
}
