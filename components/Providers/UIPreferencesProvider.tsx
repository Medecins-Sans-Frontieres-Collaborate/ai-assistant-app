'use client';

import { createContext, useContext, useState } from 'react';

import { CookieService } from '@/lib/services/cookieService';

import { DEFAULT_UI_PREFERENCES, ThemeMode, UIPreferences } from '@/types/ui';

interface UIPreferencesContextValue extends UIPreferences {
  setShowChatbar: (show: boolean) => void;
  toggleChatbar: () => void;
  setShowPromptbar: (show: boolean) => void;
  togglePromptbar: () => void;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
}

const UIPreferencesContext = createContext<UIPreferencesContextValue | null>(
  null,
);

/**
 * Provider for UI preferences using cookies as single source of truth
 * Server reads cookies for SSR, client updates cookies when preferences change
 */
export function UIPreferencesProvider({
  children,
  initialPreferences = DEFAULT_UI_PREFERENCES,
}: {
  children: React.ReactNode;
  initialPreferences?: UIPreferences;
}) {
  // Use server-provided initial preferences (from cookie)
  const [preferences, setPreferences] =
    useState<UIPreferences>(initialPreferences);

  // Save to cookie whenever preferences change
  const updatePreferences = (updates: Partial<UIPreferences>) => {
    const newPreferences = { ...preferences, ...updates };
    setPreferences(newPreferences);

    // Write to cookie (single source of truth)
    try {
      CookieService.setJSONCookie('ui-prefs', newPreferences);
    } catch (e) {
      console.error('Failed to save UI preferences to cookie:', e);
    }

    // Update DOM for theme
    if (updates.theme !== undefined) {
      // Apply dark mode based on theme preference
      const isDark =
        updates.theme === 'dark' ||
        (updates.theme === 'system' &&
          window.matchMedia('(prefers-color-scheme: dark)').matches);

      if (isDark) {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
    }
  };

  const value: UIPreferencesContextValue = {
    ...preferences,
    setShowChatbar: (show: boolean) => updatePreferences({ showChatbar: show }),
    toggleChatbar: () =>
      updatePreferences({ showChatbar: !preferences.showChatbar }),
    setShowPromptbar: (show: boolean) =>
      updatePreferences({ showPromptbar: show }),
    togglePromptbar: () =>
      updatePreferences({ showPromptbar: !preferences.showPromptbar }),
    setTheme: (theme: ThemeMode) => updatePreferences({ theme }),
    toggleTheme: () =>
      updatePreferences({
        theme: preferences.theme === 'dark' ? 'light' : 'dark',
      }),
  };

  return (
    <UIPreferencesContext.Provider value={value}>
      {children}
    </UIPreferencesContext.Provider>
  );
}

export function useUIPreferences() {
  const context = useContext(UIPreferencesContext);
  if (!context) {
    throw new Error(
      'useUIPreferences must be used within UIPreferencesProvider',
    );
  }
  return context;
}
