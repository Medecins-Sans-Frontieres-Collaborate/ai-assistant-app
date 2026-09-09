/**
 * UI Preferences Types and Validation
 */

export type ThemeMode = 'light' | 'dark' | 'system';

/**
 * Expanded sidebar width bounds (px). The single source of truth for the
 * layout is the `--sidebar-width` CSS custom property that ChatShell sets
 * from `sidebarWidth`; every element that must line up with the sidebar
 * (the sidebar itself, the content offset, the top banners' spacers) reads
 * that variable instead of a literal.
 */
export const SIDEBAR_DEFAULT_WIDTH = 260;
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 480;

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(
    SIDEBAR_MAX_WIDTH,
    Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)),
  );
}

export interface UIPreferences {
  showChatbar: boolean;
  showPromptbar: boolean;
  theme: ThemeMode;
  /** Expanded sidebar width in px, within [SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH]. */
  sidebarWidth: number;
}

export const DEFAULT_UI_PREFERENCES: UIPreferences = {
  showChatbar: false,
  showPromptbar: true,
  theme: 'dark',
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
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

  // Validate + clamp the width; anything odd (string, NaN, out of range from
  // an older cookie) falls back to the default rather than breaking layout.
  const sidebarWidth =
    typeof obj.sidebarWidth === 'number'
      ? clampSidebarWidth(obj.sidebarWidth)
      : DEFAULT_UI_PREFERENCES.sidebarWidth;

  return {
    theme,
    showChatbar,
    showPromptbar,
    sidebarWidth,
  };
}
