import { RefObject, useEffect, useRef } from 'react';

import {
  composerCaptureBlocked,
  isForeignEditable,
} from '@/client/hooks/ui/useAutoFocusComposer';

import { shouldAttachPastedText } from '@/lib/utils/shared/paste/pastedText';

import { useSettingsStore } from '@/client/stores/settingsStore';

interface UsePasteComposerOptions {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  enabled: boolean;
  /** Appends pasted text to whatever holds the composer's value. */
  append: (text: string) => void;
  /**
   * Diverts an oversized paste into an attachment. Omit to exempt this
   * composer — the bulk-paste fields (translation source, the data paste
   * box, map source text) are *built* to receive a wall of text, so
   * attaching there would break the flow rather than protect it.
   */
  onAttach?: (text: string) => void;
}

/**
 * Routes page-level pastes into a composer: oversized text becomes an
 * attachment, anything else lands in the composer and focuses it.
 *
 * The workflow counterpart to `usePasteChatInput`. Images are deliberately
 * not handled here — the workspaces have their own typed upload inputs, and
 * an image has no meaning in an instruction field.
 */
export function usePasteComposer({
  textareaRef,
  enabled,
  append,
  onAttach,
}: UsePasteComposerOptions) {
  // Held in refs so the listener never needs re-binding when inline arrow
  // functions change identity on every render.
  const appendRef = useRef(append);
  const onAttachRef = useRef(onAttach);
  useEffect(() => {
    appendRef.current = append;
  }, [append]);
  useEffect(() => {
    onAttachRef.current = onAttach;
  }, [onAttach]);

  useEffect(() => {
    if (!enabled) return;

    const handlePaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData('text/plain');
      if (!text) return;

      const textarea = textareaRef.current;
      if (!textarea) return;

      if (composerCaptureBlocked()) return;

      // Never hijack pastes into other editable elements
      if (isForeignEditable(event.target, textarea)) return;

      // A paste far too large to read in the composer is a document, not a
      // sentence. This applies even when the textarea is already focused —
      // that is the common case for a deliberate bulk paste.
      const attach = onAttachRef.current;
      if (
        attach &&
        shouldAttachPastedText(
          text,
          useSettingsStore.getState().pasteAsAttachmentChars,
        )
      ) {
        event.preventDefault();
        attach(text);
        textarea.focus();
        return;
      }

      // Native paste already works when the textarea itself is focused
      if (event.target === textarea) return;

      event.preventDefault();
      appendRef.current(text);
      textarea.focus();
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [enabled, textareaRef]);
}
