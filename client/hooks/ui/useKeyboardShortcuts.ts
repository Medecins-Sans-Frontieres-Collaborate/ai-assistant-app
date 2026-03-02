import { useCallback, useEffect, useMemo } from 'react';

import {
  ShortcutAction,
  ShortcutContextState,
} from '@/types/keyboardShortcuts';

import { useChatStore } from '@/client/stores/chatStore';
import { useConversationStore } from '@/client/stores/conversationStore';
import { useUIStore } from '@/client/stores/uiStore';
import {
  DEFAULT_SHORTCUTS,
  isContextSatisfied,
  matchesShortcut,
} from '@/lib/constants/keyboardShortcuts';

/**
 * Options for configuring the keyboard shortcuts hook.
 */
export interface UseKeyboardShortcutsOptions {
  /** Whether shortcuts are globally enabled. Defaults to true. */
  enabled?: boolean;

  /** Callback when shortcuts help modal should be shown */
  onShowHelp?: () => void;

  /** Callback to focus the chat input */
  onFocusChatInput?: () => void;

  /** Callback to create a new conversation */
  onNewConversation?: () => void;

  /** Callback to open the model selector */
  onOpenModelSelector?: () => void;

  /** Callback to scroll to the bottom of the chat */
  onScrollToBottom?: () => void;

  /** Callback to trigger file attachment */
  onAttachFile?: () => void;
}

/**
 * Detects whether the event target is an input element where typing is expected.
 *
 * @param event - The keyboard event
 * @returns True if the user is typing in an input field
 */
function isTypingInInput(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement;
  if (!target) {
    return false;
  }

  const tagName = target.tagName.toUpperCase();
  if (tagName === 'INPUT' || tagName === 'TEXTAREA') {
    return true;
  }

  // Check for contenteditable elements
  if (target.isContentEditable) {
    return true;
  }

  return false;
}

/**
 * Hook that manages global keyboard shortcuts for the chat interface.
 *
 * Sets up window-level keyboard event listeners that:
 * - Match events against the shortcut registry
 * - Respect context conditions (streaming, input focus, etc.)
 * - Call appropriate action handlers
 *
 * @param options - Configuration options for the hook
 * @returns Object containing the shortcuts registry and enabled state
 */
export function useKeyboardShortcuts({
  enabled = true,
  onShowHelp,
  onFocusChatInput,
  onNewConversation,
  onOpenModelSelector,
  onScrollToBottom,
  onAttachFile,
}: UseKeyboardShortcutsOptions = {}) {
  // Get state from stores for context detection
  const isStreaming = useChatStore((state) => state.isStreaming);
  const selectedConversationId = useConversationStore(
    (state) => state.selectedConversationId,
  );
  const conversations = useConversationStore((state) => state.conversations);
  const isSettingsOpen = useUIStore((state) => state.isSettingsOpen);
  const isBotModalOpen = useUIStore((state) => state.isBotModalOpen);
  const isTermsModalOpen = useUIStore((state) => state.isTermsModalOpen);

  // Get actions from stores
  const requestStop = useChatStore((state) => state.requestStop);
  const setIsSettingsOpen = useUIStore((state) => state.setIsSettingsOpen);

  // Compute context state
  const contextState: ShortcutContextState = useMemo(() => {
    const selectedConversation = conversations.find(
      (c) => c.id === selectedConversationId,
    );
    const hasMessages = (selectedConversation?.messages?.length ?? 0) > 0;
    const isModalOpen = isSettingsOpen || isBotModalOpen || isTermsModalOpen;

    return {
      isStreaming,
      hasMessages,
      isModalOpen,
      isSidebarOpen: false, // Not needed for current shortcuts
    };
  }, [
    isStreaming,
    conversations,
    selectedConversationId,
    isSettingsOpen,
    isBotModalOpen,
    isTermsModalOpen,
  ]);

  /**
   * Executes the action for a matched shortcut.
   *
   * @param action - The shortcut action to execute
   * @returns True if the action was handled
   */
  const executeAction = useCallback(
    (action: ShortcutAction): boolean => {
      switch (action) {
        case 'focusChatInput':
          if (onFocusChatInput) {
            onFocusChatInput();
            return true;
          }
          return false;

        case 'newConversation':
          if (onNewConversation) {
            onNewConversation();
            return true;
          }
          return false;

        case 'stopGeneration':
          requestStop();
          return true;

        case 'toggleSidebar':
          // Toggle sidebar via UI preferences provider
          // This is handled at a higher level, emit event for parent to handle
          document.dispatchEvent(new Event('keyboard-toggle-sidebar'));
          return true;

        case 'openSettings':
          setIsSettingsOpen(true);
          return true;

        case 'openModelSelector':
          if (onOpenModelSelector) {
            onOpenModelSelector();
            return true;
          }
          return false;

        case 'scrollToBottom':
          if (onScrollToBottom) {
            onScrollToBottom();
            return true;
          }
          return false;

        case 'showShortcutsHelp':
          if (onShowHelp) {
            onShowHelp();
            return true;
          }
          return false;

        case 'attachFile':
          if (onAttachFile) {
            onAttachFile();
            return true;
          }
          return false;

        default:
          return false;
      }
    },
    [
      onFocusChatInput,
      onNewConversation,
      requestStop,
      setIsSettingsOpen,
      onOpenModelSelector,
      onScrollToBottom,
      onShowHelp,
      onAttachFile,
    ],
  );

  /**
   * Handles keyboard events and matches them against shortcuts.
   */
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!enabled) {
        return;
      }

      const isInInput = isTypingInInput(event);

      // Try to match against all shortcuts
      for (const [action, shortcut] of Object.entries(DEFAULT_SHORTCUTS)) {
        // Skip if the key combination doesn't match
        if (!matchesShortcut(event, shortcut)) {
          continue;
        }

        // Skip if in input field and shortcut is disabled in input
        if (isInInput && shortcut.disableInInput) {
          continue;
        }

        // Skip if context requirement not met
        if (!isContextSatisfied(shortcut.contextRequired, contextState)) {
          continue;
        }

        // Execute the action
        const handled = executeAction(action as ShortcutAction);
        if (handled) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
    },
    [enabled, contextState, executeAction],
  );

  // Set up global event listener
  useEffect(() => {
    if (!enabled) {
      return;
    }

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [enabled, handleKeyDown]);

  return {
    shortcuts: DEFAULT_SHORTCUTS,
    isEnabled: enabled,
  };
}
