import { RefObject, useEffect } from 'react';

import { useChatInputStore } from '@/client/stores/chatInputStore';
import { useUIStore } from '@/client/stores/uiStore';

interface UseAutoFocusChatInputOptions {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  enabled: boolean;
}

/**
 * Auto-focuses the chat input when the user starts typing a printable character
 * without the textarea focused. Appends the typed character to existing text.
 */
export function useAutoFocusChatInput({
  textareaRef,
  enabled,
}: UseAutoFocusChatInputOptions) {
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      // Skip if any modifier key is held (except Shift for uppercase)
      if (event.ctrlKey || event.altKey || event.metaKey) return;

      // Skip if already in an input/textarea/contenteditable
      const target = event.target as HTMLElement;
      if (target) {
        const tagName = target.tagName.toUpperCase();
        if (
          tagName === 'INPUT' ||
          tagName === 'TEXTAREA' ||
          target.isContentEditable
        ) {
          return;
        }
      }

      // Skip if a modal is open
      const { isSettingsOpen, isBotModalOpen, isTermsModalOpen } =
        useUIStore.getState();
      if (isSettingsOpen || isBotModalOpen || isTermsModalOpen) return;

      // Skip non-printable keys
      if (event.key.length !== 1) return;

      // Focus the textarea and append the character
      const textarea = textareaRef.current;
      if (!textarea) return;

      event.preventDefault();
      useChatInputStore
        .getState()
        .setTextFieldValue((prev: string) => prev + event.key);
      textarea.focus();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled, textareaRef]);
}
