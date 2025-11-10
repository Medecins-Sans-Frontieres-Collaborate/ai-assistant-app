/**
 * UI Preferences Types and Validation
 */

export type ThemeMode = 'light' | 'dark' | 'system';

export interface UIPreferences {
  showChatbar: boolean;
  showPromptbar: boolean;
  theme: ThemeMode;
}

export const DEFAULT_UI_PREFERENCES: UIPreferences = {
  showChatbar: false,
  showPromptbar: true,
  theme: 'dark',
};

/**
 * Validates and ensures a parsed object matches UIPreferences shape
 * Returns validated preferences or defaults if invalid
 */
export function validateUIPreferences(data: unknown): UIPreferences {
  if (!data || typeof data !== 'object') {
    return DEFAULT_UI_PREFERENCES;
  }

  const obj = data as Record<string, unknown>;

  // Validate theme
  const theme =
    obj.theme === 'light' || obj.theme === 'dark' || obj.theme === 'system'
      ? obj.theme
      : DEFAULT_UI_PREFERENCES.theme;

  // Validate booleans
  const showChatbar =
    typeof obj.showChatbar === 'boolean'
      ? obj.showChatbar
      : DEFAULT_UI_PREFERENCES.showChatbar;

  const showPromptbar =
    typeof obj.showPromptbar === 'boolean'
      ? obj.showPromptbar
      : DEFAULT_UI_PREFERENCES.showPromptbar;

  return {
    theme,
    showChatbar,
    showPromptbar,
  };
}
