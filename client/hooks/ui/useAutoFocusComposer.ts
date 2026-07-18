import { RefObject, useEffect, useRef } from 'react';

import { useUIStore } from '@/client/stores/uiStore';

/**
 * True when a stray keystroke or paste must not be redirected: a modal owns
 * the screen, so the composer behind it is not what the user is addressing.
 */
export function composerCaptureBlocked(): boolean {
  const { isSettingsOpen, isBotModalOpen, isTermsModalOpen } =
    useUIStore.getState();
  return isSettingsOpen || isBotModalOpen || isTermsModalOpen;
}

/**
 * True when the event originated inside some *other* editable element, which
 * must keep its native behavior. Passing the composer itself returns false —
 * it is the intended destination, not a competing one.
 */
export function isForeignEditable(
  target: EventTarget | null,
  composer: HTMLElement | null,
): boolean {
  if (!(target instanceof HTMLElement) || target === composer) return false;
  const tagName = target.tagName.toUpperCase();
  return (
    tagName === 'INPUT' || tagName === 'TEXTAREA' || target.isContentEditable
  );
}

interface UseAutoFocusComposerOptions {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  enabled: boolean;
  /** Appends the typed character to whatever holds the composer's value. */
  append: (text: string) => void;
}

/**
 * Auto-focuses a composer when the user starts typing a printable character
 * with nothing else focused, appending the character so the first keystroke
 * is not lost.
 *
 * Extracted from the chat implementation so the workflow workspaces get the
 * identical behavior — the surface differs, but "start typing and it goes
 * where typing goes" should not.
 */
export function useAutoFocusComposer({
  textareaRef,
  enabled,
  append,
}: UseAutoFocusComposerOptions) {
  // Held in a ref so the listener never needs re-binding when an inline
  // arrow function changes identity on every render.
  const appendRef = useRef(append);
  useEffect(() => {
    appendRef.current = append;
  }, [append]);

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      // Skip if any modifier key is held (except Shift for uppercase)
      if (event.ctrlKey || event.altKey || event.metaKey) return;

      const textarea = textareaRef.current;
      if (!textarea) return;

      // Skip if already in an input/textarea/contenteditable
      if (isForeignEditable(event.target, textarea)) return;
      if (event.target === textarea) return;

      if (composerCaptureBlocked()) return;

      // Skip non-printable keys
      if (event.key.length !== 1) return;

      event.preventDefault();
      appendRef.current(event.key);
      textarea.focus();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled, textareaRef]);
}
