import { useUIPreferences } from '@/components/Providers/UIPreferencesProvider';

import { useUIStore } from '@/client/stores/uiStore';

/**
 * Combined hook for UI state
 * - Persisted preferences (sidebar, theme, etc): from UIPreferencesProvider
 * - Ephemeral modal states: from UIStore
 */
export function useUI() {
  const preferences = useUIPreferences();
  const modalState = useUIStore();

  return {
    // Persisted preferences
    showChatbar: preferences.showChatbar,
    showPromptbar: preferences.showPromptbar,
    theme: preferences.theme,
    setShowChatbar: preferences.setShowChatbar,
    toggleChatbar: preferences.toggleChatbar,
    setShowPromptbar: preferences.setShowPromptbar,
    togglePromptbar: preferences.togglePromptbar,
    setTheme: preferences.setTheme,
    toggleTheme: preferences.toggleTheme,

    // Ephemeral modal states
    isSettingsOpen: modalState.isSettingsOpen,
    isBotModalOpen: modalState.isBotModalOpen,
    isTermsModalOpen: modalState.isTermsModalOpen,
    loading: modalState.loading,
    setIsSettingsOpen: modalState.setIsSettingsOpen,
    setIsBotModalOpen: modalState.setIsBotModalOpen,
    setIsTermsModalOpen: modalState.setIsTermsModalOpen,
    setLoading: modalState.setLoading,
  };
}
