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
export type CustomizationsTabKey = 'prompts' | 'tones' | 'structures';

/** Which encrypted-backup modal (if any) is showing. Null = none. */
export type BackupModalView =
  | 'enroll-intro'
  | 'enroll-ceremony'
  | 'enroll-progress'
  | 'view-key'
  | 'rotate-confirm'
  | 'restore'
  | 'enter-key';

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

  /** Active encrypted-backup modal, hosted by BackupModals in ChatShell. */
  backupModalView: BackupModalView | null;

  /**
   * Agent/connector browser modal, hosted by Sidebar. Opened from the
   * sidebar and the capabilities tray; "Add to this chat" is always the
   * primary action, so entry point carries no behavioral difference.
   */
  agentBrowserOpen: boolean;

  /**
   * Folder open in the main panel (FolderView) instead of a chat. Not
   * persisted: a reload lands on the selected conversation as always. Any
   * change of the selected conversation closes it (FolderView watches).
   */
  openFolderId: string | null;

  // Actions
  setIsSettingsOpen: (isOpen: boolean) => void;
  setIsBotModalOpen: (isOpen: boolean) => void;
  setIsTermsModalOpen: (isOpen: boolean) => void;
  setStopGenerationConfirmSource: (source: StopGenerationSource | null) => void;
  setLoading: (loading: boolean) => void;
  setExtractionDefaultFormat: (format: ExtractionDownloadFormat) => void;
  setIsCustomizationsOpen: (isOpen: boolean) => void;
  setCustomizationsInitialTab: (tab: CustomizationsTabKey | null) => void;
  setBackupModalView: (view: BackupModalView | null) => void;
  setAgentBrowserOpen: (open: boolean) => void;
  openFolder: (folderId: string) => void;
  closeFolder: () => void;
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
  backupModalView: null,
  agentBrowserOpen: false,
  openFolderId: null,

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
  setBackupModalView: (view) => set({ backupModalView: view }),
  setAgentBrowserOpen: (open) => set({ agentBrowserOpen: open }),
  openFolder: (folderId) => set({ openFolderId: folderId }),
  closeFolder: () => set({ openFolderId: null }),
}));
