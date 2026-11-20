import {
  isQuotaError,
  notifyQuotaExceeded,
} from '@/lib/utils/app/storage/perConversationStorage';

import type { StateStorage } from 'zustand/middleware';

/**
 * localStorage for a persisted store that must not throw when the browser's
 * storage is full. A full store otherwise throws from inside a state update:
 * the action that caused it stops half way (a dialog that should close stays
 * open) and nothing tells the person why. Here the write is dropped, the
 * failure is logged, and STORAGE_QUOTA_EXCEEDED_EVENT is raised so the app
 * shows its "storage is full" warning, as conversation storage does. The
 * state in memory is kept, so the change lasts until the page is reloaded.
 *
 * Errors other than a full quota are not swallowed.
 */
export const guardedLocalStorage: StateStorage = {
  getItem: (name) => localStorage.getItem(name),
  setItem: (name, value) => {
    try {
      localStorage.setItem(name, value);
    } catch (error) {
      if (!isQuotaError(error)) throw error;
      console.error(
        `[guardedLocalStorage] Storage is full; "${name}" was not saved.`,
        error,
      );
      notifyQuotaExceeded({ scope: 'settings', id: name });
    }
  },
  removeItem: (name) => localStorage.removeItem(name),
};
