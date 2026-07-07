import { RefObject, useEffect } from 'react';

import { useChatInputStore } from '@/client/stores/chatInputStore';
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
        void useChatInputStore.getState().handleFileUpload(imageFiles);
        textarea.focus();
        return;
      }

      // Native paste already works when the textarea itself is focused
      if (target === textarea) return;

      const text = clipboardData.getData('text/plain');
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
