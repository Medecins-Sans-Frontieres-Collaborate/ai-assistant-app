/**
 * Keyboard Shortcuts Registry
 *
 * Centralized definition of all keyboard shortcuts and utility functions.
 * Designed to be cross-platform compatible and avoid conflicts with:
 * - Browser shortcuts (Ctrl+N, Ctrl+T, Ctrl+F, etc.)
 * - OS shortcuts (Windows, macOS, Linux)
 * - i3 window manager (uses Mod/Super key)
 */
import {
  KeyboardShortcut,
  ShortcutAction,
  ShortcutContext,
  ShortcutContextState,
} from '@/types/keyboardShortcuts';

/**
 * Default keyboard shortcuts configuration.
 * Uses Ctrl+Shift combinations to avoid browser conflicts.
 */
export const DEFAULT_SHORTCUTS: Record<ShortcutAction, KeyboardShortcut> = {
  focusChatInput: {
    id: 'focus-chat-input',
    key: '/',
    modifiers: [],
    labelKey: 'shortcuts.focusChatInput',
    categoryKey: 'shortcuts.categoryNavigation',
    contextRequired: 'notStreaming',
    disableInInput: true,
  },
  newConversation: {
    id: 'new-conversation',
    key: 'l',
    modifiers: ['ctrl', 'shift'],
    labelKey: 'shortcuts.newConversation',
    categoryKey: 'shortcuts.categoryConversation',
    contextRequired: 'always',
    disableInInput: false,
  },
  stopGeneration: {
    id: 'stop-generation',
    key: 'Escape',
    modifiers: [],
    labelKey: 'shortcuts.stopGeneration',
    categoryKey: 'shortcuts.categoryConversation',
    contextRequired: 'streaming',
    disableInInput: false,
  },
  toggleSidebar: {
    id: 'toggle-sidebar',
    key: 'b',
    modifiers: ['ctrl', 'shift'],
    labelKey: 'shortcuts.toggleSidebar',
    categoryKey: 'shortcuts.categoryNavigation',
    contextRequired: 'always',
    disableInInput: false,
  },
  openSettings: {
    id: 'open-settings',
    key: ',',
    modifiers: ['ctrl'],
    labelKey: 'shortcuts.openSettings',
    categoryKey: 'shortcuts.categoryApp',
    contextRequired: 'always',
    disableInInput: false,
  },
  openModelSelector: {
    id: 'open-model-selector',
    key: 'm',
    modifiers: ['ctrl', 'shift'],
    labelKey: 'shortcuts.openModelSelector',
    categoryKey: 'shortcuts.categoryConversation',
    contextRequired: 'always',
    disableInInput: false,
  },
  scrollToBottom: {
    id: 'scroll-to-bottom',
    key: 'End',
    modifiers: ['ctrl'],
    labelKey: 'shortcuts.scrollToBottom',
    categoryKey: 'shortcuts.categoryNavigation',
    contextRequired: 'hasMessages',
    disableInInput: true,
  },
  showShortcutsHelp: {
    id: 'show-shortcuts-help',
    key: '/',
    modifiers: ['ctrl'],
    labelKey: 'shortcuts.showHelp',
    categoryKey: 'shortcuts.categoryApp',
    contextRequired: 'always',
    disableInInput: false,
  },
  attachFile: {
    id: 'attach-file',
    key: 'u',
    modifiers: ['ctrl', 'shift'],
    labelKey: 'shortcuts.attachFile',
    categoryKey: 'shortcuts.categoryInput',
    contextRequired: 'notStreaming',
    disableInInput: false,
  },
};

/**
 * Checks if a keyboard event matches a shortcut definition.
 *
 * @param event - The keyboard event to check
 * @param shortcut - The shortcut definition to match against
 * @returns True if the event matches the shortcut
 */
export function matchesShortcut(
  event: KeyboardEvent,
  shortcut: KeyboardShortcut,
): boolean {
  // Compare keys (case-insensitive for letters)
  const eventKey = event.key.toLowerCase();
  const shortcutKey = shortcut.key.toLowerCase();

  if (eventKey !== shortcutKey) {
    return false;
  }

  // Determine expected modifier states
  const expectCtrl = shortcut.modifiers.includes('ctrl');
  const expectShift = shortcut.modifiers.includes('shift');
  const expectAlt = shortcut.modifiers.includes('alt');

  // Handle Ctrl vs Cmd on macOS - treat both as "ctrl" modifier
  const hasCtrlOrMeta = event.ctrlKey || event.metaKey;

  // Check modifier state matches exactly
  if (expectCtrl !== hasCtrlOrMeta) {
    return false;
  }
  if (expectShift !== event.shiftKey) {
    return false;
  }
  if (expectAlt !== event.altKey) {
    return false;
  }

  return true;
}

/**
 * Checks if the context requirement for a shortcut is satisfied.
 *
 * @param context - The context requirement from the shortcut
 * @param state - The current UI context state
 * @returns True if the context requirement is satisfied
 */
export function isContextSatisfied(
  context: ShortcutContext,
  state: ShortcutContextState,
): boolean {
  switch (context) {
    case 'streaming':
      return state.isStreaming;
    case 'notStreaming':
      return !state.isStreaming;
    case 'hasMessages':
      return state.hasMessages;
    case 'modalOpen':
      return state.isModalOpen;
    case 'always':
      return true;
    default:
      return true;
  }
}

/**
 * Detects if the current platform is macOS.
 * Used to display appropriate modifier key symbols.
 */
function isMacOS(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }
  return navigator.platform.toLowerCase().includes('mac');
}

/**
 * Formats a shortcut for display in the UI.
 * Shows platform-appropriate modifier symbols (Cmd on Mac, Ctrl elsewhere).
 *
 * @param shortcut - The shortcut to format
 * @returns A human-readable string like "Ctrl+Shift+K" or "Cmd+Shift+K"
 */
export function formatShortcut(shortcut: KeyboardShortcut): string {
  const parts: string[] = [];
  const mac = isMacOS();

  // Add modifiers in conventional order
  if (shortcut.modifiers.includes('ctrl')) {
    parts.push(mac ? 'Cmd' : 'Ctrl');
  }
  if (shortcut.modifiers.includes('alt')) {
    parts.push(mac ? 'Option' : 'Alt');
  }
  if (shortcut.modifiers.includes('shift')) {
    parts.push('Shift');
  }
  if (shortcut.modifiers.includes('meta')) {
    parts.push(mac ? 'Cmd' : 'Win');
  }

  // Format the key itself
  let keyDisplay = shortcut.key;
  switch (shortcut.key.toLowerCase()) {
    case 'escape':
      keyDisplay = 'Esc';
      break;
    case ' ':
      keyDisplay = 'Space';
      break;
    case 'arrowup':
      keyDisplay = 'Up';
      break;
    case 'arrowdown':
      keyDisplay = 'Down';
      break;
    case 'arrowleft':
      keyDisplay = 'Left';
      break;
    case 'arrowright':
      keyDisplay = 'Right';
      break;
    default:
      // Capitalize single letters
      if (keyDisplay.length === 1) {
        keyDisplay = keyDisplay.toUpperCase();
      }
  }
  parts.push(keyDisplay);

  return parts.join('+');
}

/**
 * Groups shortcuts by their category for display in the help modal.
 *
 * @returns An object mapping category keys to arrays of shortcuts
 */
export function getShortcutsByCategory(): Record<string, KeyboardShortcut[]> {
  const groups: Record<string, KeyboardShortcut[]> = {};

  for (const shortcut of Object.values(DEFAULT_SHORTCUTS)) {
    const category = shortcut.categoryKey;
    if (!groups[category]) {
      groups[category] = [];
    }
    groups[category].push(shortcut);
  }

  return groups;
}

/**
 * Category display order for the help modal
 */
export const SHORTCUT_CATEGORY_ORDER = [
  'shortcuts.categoryNavigation',
  'shortcuts.categoryConversation',
  'shortcuts.categoryInput',
  'shortcuts.categoryApp',
];
