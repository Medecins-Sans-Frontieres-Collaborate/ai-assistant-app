'use client';

import { create } from 'zustand';

/**
 * Simple Zustand store for ephemeral modal/loading states
 * Does NOT persist - these are temporary UI states
 *
 * For persisted UI preferences (sidebar, theme, etc), use UIPreferencesProvider
 */
export type StopGenerationSource = 'button' | 'keyboard';

/** Format the extraction download card defaults to within a session. */
export type ExtractionDownloadFormat = 'json' | 'csv' | 'tsv';

/** Tabs available inside the Quick Actions / Customizations modal. */
export type CustomizationsTabKey = 'prompts' | 'tones' | 'recipes';

interface UIStore {
  // Ephemeral modal states
  isSettingsOpen: boolean;
  isBotModalOpen: boolean;
  isTermsModalOpen: boolean;
  stopGenerationConfirmSource: StopGenerationSource | null;
  loading: boolean;

  /**
   * Default download format for extraction result cards. Sticky per
   * session (resets on full page reload) so a user who downloads CSV
   * once gets that as the default next time.
   */
  extractionDefaultFormat: ExtractionDownloadFormat;

  /**
   * Quick Actions (CustomizationsModal) open state, hoisted out of the
   * sidebar so other surfaces (e.g. the recipe picker) can open it.
   */
  isCustomizationsOpen: boolean;
  /**
   * Tab to land on when the Customizations modal opens. Cleared after
   * the modal honours it so subsequent reopens default cleanly.
   */
  customizationsInitialTab: CustomizationsTabKey | null;

  // Actions
  setIsSettingsOpen: (isOpen: boolean) => void;
  setIsBotModalOpen: (isOpen: boolean) => void;
  setIsTermsModalOpen: (isOpen: boolean) => void;
  setStopGenerationConfirmSource: (source: StopGenerationSource | null) => void;
  setLoading: (loading: boolean) => void;
  setExtractionDefaultFormat: (format: ExtractionDownloadFormat) => void;
  setIsCustomizationsOpen: (isOpen: boolean) => void;
  setCustomizationsInitialTab: (tab: CustomizationsTabKey | null) => void;
}

export const useUIStore = create<UIStore>((set) => ({
  // Initial state
  isSettingsOpen: false,
  isBotModalOpen: false,
  isTermsModalOpen: false,
  stopGenerationConfirmSource: null,
  loading: false,
  extractionDefaultFormat: 'csv',
  isCustomizationsOpen: false,
  customizationsInitialTab: null,

  // Actions
  setIsSettingsOpen: (isOpen) => set({ isSettingsOpen: isOpen }),
  setIsBotModalOpen: (isOpen) => set({ isBotModalOpen: isOpen }),
  setIsTermsModalOpen: (isOpen) => set({ isTermsModalOpen: isOpen }),
  setStopGenerationConfirmSource: (source) =>
    set({ stopGenerationConfirmSource: source }),
  setLoading: (loading) => set({ loading }),
  setExtractionDefaultFormat: (format) =>
    set({ extractionDefaultFormat: format }),
  setIsCustomizationsOpen: (isOpen) => set({ isCustomizationsOpen: isOpen }),
  setCustomizationsInitialTab: (tab) => set({ customizationsInitialTab: tab }),
}));
