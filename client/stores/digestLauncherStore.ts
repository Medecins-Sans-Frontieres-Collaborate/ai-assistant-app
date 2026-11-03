import type { DigestPeriodPreset } from '@/lib/services/m365/digest/digestWindow';

import { create } from 'zustand';

/**
 * Opens the Daily digest launcher from anywhere (playbook chips, the `+`
 * menu, the card's "change period" button) without threading props. Not
 * persisted: a half-open launcher is not state worth keeping.
 */
interface DigestLauncherState {
  isOpen: boolean;
  /** Preset to preselect; null = the user's saved default. */
  preset: DigestPeriodPreset | null;
  open: (options?: { preset?: DigestPeriodPreset }) => void;
  close: () => void;
}

export const useDigestLauncherStore = create<DigestLauncherState>((set) => ({
  isOpen: false,
  preset: null,
  open: (options) => set({ isOpen: true, preset: options?.preset ?? null }),
  close: () => set({ isOpen: false, preset: null }),
}));
