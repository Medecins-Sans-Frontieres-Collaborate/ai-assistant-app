import { RefObject, useCallback, useEffect, useRef, useState } from 'react';

import { usePastedTextAttachment } from '@/client/hooks/chat/usePastedTextAttachment';
import { useUrlAttachment } from '@/client/hooks/chat/useUrlAttachment';

import { clipboardHtmlToMarkdown } from '@/client/services/paste/clipboardHtml';
import {
  CapturedPaste,
  PasteOption,
  PasteOptionId,
  getPasteOptions,
} from '@/client/services/paste/pasteOptions';
import { isLikelyUrl } from '@/client/services/url/urlFetchClient';

import { shouldAttachPastedText } from '@/lib/utils/shared/paste/pastedText';

import { useChatInputStore } from '@/client/stores/chatInputStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import { useUIStore } from '@/client/stores/uiStore';

interface UsePasteChatInputOptions {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  enabled: boolean;
}

export interface PasteChooser {
  options: PasteOption[];
  select: (id: PasteOptionId) => void;
  dismiss: () => void;
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
 * How long after a Ctrl/Cmd+Shift+V keydown a paste event still counts as
 * "paste with options". The browser dispatches the paste synchronously from
 * the keydown's default action, so this only guards against a keydown whose
 * paste never fired (e.g. clipboard permission denied).
 */
const PASTE_OPTIONS_INTENT_MS = 500;

/**
 * True for the Ctrl+Shift+V / Cmd+Shift+V chord. The composer is a plain
 * textarea, so the browser's native "paste as plain text" meaning of that
 * chord is already indistinguishable from a normal paste there; we repurpose
 * it as "paste, but let me choose the representation".
 */
function isPasteOptionsChord(event: KeyboardEvent): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === 'v'
  );
}

/**
 * Inserts text at the composer's caret (replacing any selection), then puts
 * the caret after the insertion once React has committed the new value.
 * Used when a paste was intercepted, since preventDefault discards the
 * browser's own caret-aware insertion.
 */
function insertAtCaret(textarea: HTMLTextAreaElement, text: string): void {
  const { textFieldValue, setTextFieldValue } = useChatInputStore.getState();
  const start = textarea.selectionStart ?? textFieldValue.length;
  const end = textarea.selectionEnd ?? start;
  setTextFieldValue(
    (prev: string) => prev.slice(0, start) + text + prev.slice(end),
  );
  const caret = start + text.length;
  setTimeout(() => {
    try {
      textarea.setSelectionRange(caret, caret);
    } catch {
      // Detached or non-text control; nothing to restore.
    }
  }, 0);
}

/**
 * Handles clipboard pastes anywhere on the chat page:
 * - Text wins over images. Word, Excel and PowerPoint put a PNG rendering
 *   of the selection on the clipboard alongside the text; attaching that
 *   picture instead of inserting the text turns every paste into a poor
 *   OCR task. (An inline picture *within* copied Word text is not
 *   separately recoverable from the paste event — Word's HTML references it
 *   by local file path — so there is no "text plus embedded image" case to
 *   handle.)
 * - Pasted images are attached via the file upload pipeline when the
 *   clipboard holds no text.
 * - Ctrl/Cmd+Shift+V opens a chooser listing every representation the
 *   clipboard actually holds (plain text, Markdown from its HTML, text or
 *   Markdown attachment, image, fetched link). With exactly one option the
 *   chooser is skipped and that option is applied.
 * - Pasted text while the chat textarea is not focused is appended to the
 *   input and focuses it, mirroring the typing auto-focus behavior.
 *
 * Returns the open chooser (or null) for the page to render.
 */
export function usePasteChatInput({
  textareaRef,
  enabled,
}: UsePasteChatInputOptions): { pasteChooser: PasteChooser | null } {
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

  const [pending, setPending] = useState<{
    paste: CapturedPaste;
    options: PasteOption[];
  } | null>(null);

  const uploadImages = useCallback(
    (imageFiles: File[]) => {
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
    },
    [textareaRef],
  );

  /** Applies one paste option. Explicit choices bypass the size threshold. */
  const applyOption = useCallback(
    (paste: CapturedPaste, id: PasteOptionId) => {
      const textarea = textareaRef.current;
      switch (id) {
        case 'text':
          if (textarea) insertAtCaret(textarea, paste.text);
          break;
        case 'markdown':
          if (textarea) insertAtCaret(textarea, paste.markdown);
          break;
        case 'attachText':
          void attachPastedTextRef.current(paste.text);
          break;
        case 'attachMarkdown':
          void attachPastedTextRef.current(paste.markdown);
          break;
        case 'image':
          uploadImages(paste.imageFiles);
          break;
        case 'link':
          void attachUrlRef.current(paste.text.trim());
          break;
        default:
          break;
      }
      textarea?.focus();
    },
    [textareaRef, uploadImages],
  );

  useEffect(() => {
    if (!enabled) return;

    // Timestamp of the last Ctrl/Cmd+Shift+V keydown. The paste event carries
    // no modifier state, so the chord is observed on keydown and consumed by
    // the paste that immediately follows it.
    let pasteOptionsRequestedAt = 0;
    // Sanitizing the HTML is async; a newer paste must win over a slower
    // older one, so each capture is stamped and stale results are dropped.
    let captureSeq = 0;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isPasteOptionsChord(event)) {
        pasteOptionsRequestedAt = Date.now();
      }
    };

    const handlePaste = (event: ClipboardEvent) => {
      const clipboardData = event.clipboardData;
      if (!clipboardData) return;

      const withOptions =
        pasteOptionsRequestedAt > 0 &&
        Date.now() - pasteOptionsRequestedAt <= PASTE_OPTIONS_INTENT_MS;
      pasteOptionsRequestedAt = 0;

      // A new paste supersedes an open chooser.
      setPending(null);

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

      const text = clipboardData.getData('text/plain');

      if (withOptions) {
        // Everything must be read from the DataTransfer now — it is dead
        // once the event finishes — but the Markdown conversion sanitizes
        // asynchronously, so the chooser opens a microtask later.
        const html = clipboardData.getData('text/html');
        const imageFiles = extractImageFiles(clipboardData);
        if (!text && !html && imageFiles.length === 0) return;
        event.preventDefault();

        const seq = ++captureSeq;
        void clipboardHtmlToMarkdown(html).then((markdown) => {
          if (seq !== captureSeq) return;
          const paste: CapturedPaste = { text, markdown, imageFiles };
          const options = getPasteOptions(paste);
          if (options.length === 0) return;
          if (options.length === 1) {
            applyOption(paste, options[0].id);
          } else {
            setPending({ paste, options });
          }
        });
        return;
      }

      const imageFiles = extractImageFiles(clipboardData);
      if (imageFiles.length > 0 && !text) {
        event.preventDefault();
        uploadImages(imageFiles);
        textarea.focus();
        return;
      }

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

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('paste', handlePaste);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('paste', handlePaste);
    };
  }, [enabled, textareaRef, applyOption, uploadImages]);

  const select = useCallback(
    (id: PasteOptionId) => {
      if (!pending) return;
      const { paste } = pending;
      setPending(null);
      applyOption(paste, id);
    },
    [pending, applyOption],
  );

  const dismiss = useCallback(() => {
    setPending(null);
    textareaRef.current?.focus();
  }, [textareaRef]);

  return {
    pasteChooser: pending
      ? { options: pending.options, select, dismiss }
      : null,
  };
}
