import { RefObject, useCallback } from 'react';

import { useAutoFocusComposer } from '@/client/hooks/ui/useAutoFocusComposer';

import { useChatInputStore } from '@/client/stores/chatInputStore';

interface UseAutoFocusChatInputOptions {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  enabled: boolean;
}

/**
 * Auto-focuses the chat input when the user starts typing a printable
 * character without the textarea focused. Appends the typed character to
 * existing text.
 *
 * The behavior lives in `useAutoFocusComposer`, which the workflow
 * workspaces share; this binds it to the chat input store.
 */
export function useAutoFocusChatInput({
  textareaRef,
  enabled,
}: UseAutoFocusChatInputOptions) {
  const append = useCallback((text: string) => {
    useChatInputStore
      .getState()
      .setTextFieldValue((prev: string) => prev + text);
  }, []);

  useAutoFocusComposer({ textareaRef, enabled, append });
}
