/**
 * Keyboard Shortcuts Types
 *
 * Type definitions for the global keyboard shortcuts system.
 */

/**
 * Modifier keys that can be combined with shortcuts.
 * - ctrl: Control key (Windows/Linux) or Command key (macOS)
 * - shift: Shift key
 * - alt: Alt key (Windows/Linux) or Option key (macOS)
 * - meta: Windows key or Command key (rarely used directly)
 */
export type ModifierKey = 'ctrl' | 'shift' | 'alt' | 'meta';

/**
 * Context conditions that determine when a shortcut is active.
 * - streaming: Only active when AI is generating a response
 * - notStreaming: Only active when not generating
 * - hasMessages: Only active when conversation has messages
 * - modalOpen: Only active when a modal is open
 * - always: Always active regardless of state
 */
export type ShortcutContext =
  | 'streaming'
  | 'notStreaming'
  | 'hasMessages'
  | 'modalOpen'
  | 'always';

/**
 * Available shortcut actions that can be triggered.
 * Each action corresponds to a specific feature in the chat UI.
 */
export type ShortcutAction =
  | 'focusChatInput'
  | 'newConversation'
  | 'stopGeneration'
  | 'toggleSidebar'
  | 'openSettings'
  | 'openModelSelector'
  | 'scrollToBottom'
  | 'showShortcutsHelp'
  | 'attachFile'
  | 'searchConversations'
  | 'toggleTheme'
  | 'regenerateResponse'
  | 'copyLastResponse';

/**
 * A keyboard shortcut definition.
 */
export interface KeyboardShortcut {
  /** Unique identifier for the shortcut */
  id: string;

  /** The key to press (e.g., 'k', 'Escape', '/') - case insensitive for letters */
  key: string;

  /** Required modifier keys that must be held down */
  modifiers: ModifierKey[];

  /** Translation key for the action description */
  labelKey: string;

  /** Translation key for the category (for grouping in help modal) */
  categoryKey: string;

  /** Context condition that must be met for the shortcut to be active */
  contextRequired: ShortcutContext;

  /** Whether this shortcut should be disabled when typing in an input field */
  disableInInput: boolean;
}

/**
 * State representing the current UI context for shortcut activation.
 */
export interface ShortcutContextState {
  /** Whether the AI is currently streaming a response */
  isStreaming: boolean;

  /** Whether the current conversation has any messages */
  hasMessages: boolean;

  /** Whether any modal dialog is currently open */
  isModalOpen: boolean;

  /** Whether the sidebar is currently visible */
  isSidebarOpen: boolean;
}
