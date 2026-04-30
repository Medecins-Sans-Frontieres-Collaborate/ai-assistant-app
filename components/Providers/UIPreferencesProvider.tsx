'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';

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
 *
 * All setters are stable across renders so consumers can put them in
 * useEffect dep arrays without triggering refire loops.
 */
export function UIPreferencesProvider({
  children,
  initialPreferences = DEFAULT_UI_PREFERENCES,
}: {
  children: React.ReactNode;
  initialPreferences?: UIPreferences;
}) {
  const [preferences, setPreferences] =
    useState<UIPreferences>(initialPreferences);

  const updatePreferences = useCallback(
    (
      updates:
        | Partial<UIPreferences>
        | ((prev: UIPreferences) => Partial<UIPreferences>),
    ) => {
      setPreferences((prev) => {
        const resolved =
          typeof updates === 'function' ? updates(prev) : updates;
        const next = { ...prev, ...resolved };

        try {
          CookieService.setJSONCookie('ui-prefs', next);
        } catch (e) {
          console.error('Failed to save UI preferences to cookie:', e);
        }

        if (resolved.theme !== undefined) {
          const isDark =
            resolved.theme === 'dark' ||
            (resolved.theme === 'system' &&
              window.matchMedia('(prefers-color-scheme: dark)').matches);

          if (isDark) {
            document.documentElement.classList.add('dark');
          } else {
            document.documentElement.classList.remove('dark');
          }
        }

        return next;
      });
    },
    [],
  );

  const setShowChatbar = useCallback(
    (show: boolean) => updatePreferences({ showChatbar: show }),
    [updatePreferences],
  );
  const toggleChatbar = useCallback(
    () => updatePreferences((prev) => ({ showChatbar: !prev.showChatbar })),
    [updatePreferences],
  );
  const setShowPromptbar = useCallback(
    (show: boolean) => updatePreferences({ showPromptbar: show }),
    [updatePreferences],
  );
  const togglePromptbar = useCallback(
    () => updatePreferences((prev) => ({ showPromptbar: !prev.showPromptbar })),
    [updatePreferences],
  );
  const setTheme = useCallback(
    (theme: ThemeMode) => updatePreferences({ theme }),
    [updatePreferences],
  );
  const toggleTheme = useCallback(
    () =>
      updatePreferences((prev) => ({
        theme: prev.theme === 'dark' ? 'light' : 'dark',
      })),
    [updatePreferences],
  );

  const value = useMemo<UIPreferencesContextValue>(
    () => ({
      ...preferences,
      setShowChatbar,
      toggleChatbar,
      setShowPromptbar,
      togglePromptbar,
      setTheme,
      toggleTheme,
    }),
    [
      preferences,
      setShowChatbar,
      toggleChatbar,
      setShowPromptbar,
      togglePromptbar,
      setTheme,
      toggleTheme,
    ],
  );

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
