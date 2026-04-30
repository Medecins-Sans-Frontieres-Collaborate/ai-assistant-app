'use client';

import { create } from 'zustand';

/**
 * Simple Zustand store for ephemeral modal/loading states
 * Does NOT persist - these are temporary UI states
 *
 * For persisted UI preferences (sidebar, theme, etc), use UIPreferencesProvider
 */
export type StopGenerationSource = 'button' | 'keyboard';

interface UIStore {
  // Ephemeral modal states
  isSettingsOpen: boolean;
  isBotModalOpen: boolean;
  isTermsModalOpen: boolean;
  stopGenerationConfirmSource: StopGenerationSource | null;
  loading: boolean;

  // Actions
  setIsSettingsOpen: (isOpen: boolean) => void;
  setIsBotModalOpen: (isOpen: boolean) => void;
  setIsTermsModalOpen: (isOpen: boolean) => void;
  setStopGenerationConfirmSource: (source: StopGenerationSource | null) => void;
  setLoading: (loading: boolean) => void;
}

export const useUIStore = create<UIStore>((set) => ({
  // Initial state
  isSettingsOpen: false,
  isBotModalOpen: false,
  isTermsModalOpen: false,
  stopGenerationConfirmSource: null,
  loading: false,

  // Actions
  setIsSettingsOpen: (isOpen) => set({ isSettingsOpen: isOpen }),
  setIsBotModalOpen: (isOpen) => set({ isBotModalOpen: isOpen }),
  setIsTermsModalOpen: (isOpen) => set({ isTermsModalOpen: isOpen }),
  setStopGenerationConfirmSource: (source) =>
    set({ stopGenerationConfirmSource: source }),
  setLoading: (loading) => set({ loading }),
}));
