'use client';

import { createBackupApiClient } from '@/lib/services/backup/backupApiClient';
import type {
  BackupBackend,
  PersistedSyncPoint,
  SyncStatus,
} from '@/lib/services/backup/types';

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/**
 * Dedicated persisted store for the encrypted-backup feature. Deliberately
 * NOT part of settingsStore: everything here is device-scoped (enrollment,
 * sync point, cached key fingerprint) and must never travel through the
 * settings import/export path onto another device.
 *
 * Persisted vs runtime split: only the enrollment/sync-point fields survive
 * reload (see partialize); sync status, remote snapshot, and the mirrored
 * LaunchDarkly flag re-derive every session.
 */

export type BackupEnrollmentStatus = 'unset' | 'enrolled' | 'declined';

/**
 * How blobs are stored at the backend. 'plain' (readable JSON) is an
 * explicit, warned opt-in and is only valid for the onedrive backend —
 * app storage must never hold readable chat content.
 */
export type BackupEncryptionMode = 'encrypted' | 'plain';

/** Result of refreshRemoteStatus; null when the fetch failed (unknown). */
export interface RemoteBackupStatus {
  exists: boolean;
  keyId: string | null;
  epoch: number | null;
  /** True when a tombstone manifest says backup was turned off. */
  disabled: boolean;
}

interface BackupStore {
  // Persisted state
  enrollmentStatus: BackupEnrollmentStatus;
  /**
   * Where the encrypted mirror lives ('app' storage or the user's
   * OneDrive). Device-scoped like the rest of enrollment: the sync point
   * below is only meaningful against this backend, and both flip together
   * in the switch flow.
   */
  storageBackend: BackupBackend;
  /** Explicit user choice made? Lets the UI default new setups to OneDrive. */
  storageChosen: boolean;
  encryptionMode: BackupEncryptionMode;
  /** Fingerprint of the key this device holds (16 hex chars), null pre-enroll. */
  localKeyId: string | null;
  /** Key epoch this device last synced under. Starts at 1. */
  localKeyEpoch: number;
  lastSyncedVersion: number | null;
  lastSyncedEtag: string | null;
  /** ISO timestamp of the last successful sync. */
  lastBackupAt: string | null;
  lastSyncError: string | null;

  // Runtime state (never persisted)
  syncStatus: SyncStatus;
  /** Whether a live (non-disabled) manifest exists remotely; null = unknown. */
  remoteExists: boolean | null;
  remoteKeyId: string | null;
  remoteKeyEpoch: number | null;
  /** Mirror of the enableEncryptedBackups LaunchDarkly flag (fail-closed). */
  flagEnabled: boolean;
  bannerCollapsed: boolean;

  // Actions
  setEnrolled: (keyId: string, epoch: number) => void;
  /** Flips the storage backend and invalidates the backend-scoped sync point. */
  setStorageBackend: (backend: BackupBackend) => void;
  /**
   * Default-preference nudge (new setups → OneDrive): same backend flip but
   * does NOT mark the choice as user-made, so availability changes can keep
   * adapting until the user actually picks.
   */
  applyDefaultStorageBackend: (backend: BackupBackend) => void;
  setEncryptionMode: (mode: BackupEncryptionMode) => void;
  setDeclined: () => void;
  /** Forgets enrollment + sync point (disable / "turn off locally" flows). */
  clearEnrollment: () => void;
  setFlagEnabled: (enabled: boolean) => void;
  setBannerCollapsed: (collapsed: boolean) => void;
  setSyncStatus: (status: SyncStatus, error?: string) => void;
  recordSyncPoint: (point: PersistedSyncPoint) => void;
  /**
   * Fetches the remote manifest and caches its existence/keyId/epoch.
   * Returns null (state untouched) when the request fails — callers must
   * treat that as "unknown", not "absent".
   */
  refreshRemoteStatus: () => Promise<RemoteBackupStatus | null>;
}

export const useBackupStore = create<BackupStore>()(
  persist(
    (set, get) => ({
      // Persisted state
      enrollmentStatus: 'unset',
      storageBackend: 'app',
      storageChosen: false,
      encryptionMode: 'encrypted',
      localKeyId: null,
      localKeyEpoch: 1,
      lastSyncedVersion: null,
      lastSyncedEtag: null,
      lastBackupAt: null,
      lastSyncError: null,

      // Runtime state
      syncStatus: 'idle',
      remoteExists: null,
      remoteKeyId: null,
      remoteKeyEpoch: null,
      flagEnabled: false,
      bannerCollapsed: false,

      // Actions
      setEnrolled: (keyId, epoch) =>
        set({
          enrollmentStatus: 'enrolled',
          localKeyId: keyId,
          localKeyEpoch: epoch,
          lastSyncError: null,
        }),

      setDeclined: () => set({ enrollmentStatus: 'declined' }),

      // The old backend's version/etag mean nothing against the new one;
      // callers that already pushed to the target (switch flow) re-record
      // the fresh sync point right after.
      setStorageBackend: (backend) =>
        set((state) => ({
          storageBackend: backend,
          storageChosen: true,
          // Plain mode never travels to app storage.
          encryptionMode:
            backend === 'app' ? 'encrypted' : state.encryptionMode,
          remoteExists: null,
          remoteKeyId: null,
          remoteKeyEpoch: null,
        })),

      applyDefaultStorageBackend: (backend) =>
        set({
          storageBackend: backend,
          remoteExists: null,
          remoteKeyId: null,
          remoteKeyEpoch: null,
        }),

      setEncryptionMode: (mode) =>
        set((state) =>
          // Guard, not just UI: 'plain' is onedrive-only.
          mode === 'plain' && state.storageBackend !== 'onedrive'
            ? state
            : { ...state, encryptionMode: mode },
        ),

      clearEnrollment: () =>
        set({
          enrollmentStatus: 'unset',
          localKeyId: null,
          localKeyEpoch: 1,
          lastSyncedVersion: null,
          lastSyncedEtag: null,
          lastBackupAt: null,
          lastSyncError: null,
          syncStatus: 'idle',
        }),

      setFlagEnabled: (enabled) => set({ flagEnabled: enabled }),

      setBannerCollapsed: (collapsed) => set({ bannerCollapsed: collapsed }),

      setSyncStatus: (status, error) =>
        set((state) => ({
          syncStatus: status,
          lastSyncError:
            status === 'error'
              ? (error ?? state.lastSyncError ?? 'Backup sync failed')
              : status === 'ok'
                ? null
                : state.lastSyncError,
        })),

      recordSyncPoint: (point) =>
        set({
          lastSyncedVersion: point.version,
          lastSyncedEtag: point.etag,
          // Adopt the manifest epoch in effect — another device may have
          // reset/rotated and bumped it.
          localKeyEpoch: point.epoch,
          lastBackupAt: point.syncedAt,
          lastSyncError: null,
        }),

      refreshRemoteStatus: async () => {
        let fetched;
        try {
          fetched = await createBackupApiClient(
            undefined,
            get().storageBackend,
          ).getManifest();
        } catch {
          return null; // unknown — keep the cached runtime snapshot
        }
        if (fetched === null || fetched.manifest.disabled) {
          const epoch = fetched?.manifest.epoch ?? null;
          set({
            remoteExists: false,
            remoteKeyId: null,
            remoteKeyEpoch: epoch,
          });
          return {
            exists: false,
            keyId: null,
            epoch,
            disabled: fetched?.manifest.disabled === true,
          };
        }
        const { keyId, epoch } = fetched.manifest;
        set({ remoteExists: true, remoteKeyId: keyId, remoteKeyEpoch: epoch });
        return { exists: true, keyId, epoch, disabled: false };
      },
    }),
    {
      name: 'backup-storage',
      version: 3,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        enrollmentStatus: state.enrollmentStatus,
        storageBackend: state.storageBackend,
        storageChosen: state.storageChosen,
        encryptionMode: state.encryptionMode,
        localKeyId: state.localKeyId,
        localKeyEpoch: state.localKeyEpoch,
        lastSyncedVersion: state.lastSyncedVersion,
        lastSyncedEtag: state.lastSyncedEtag,
        lastBackupAt: state.lastBackupAt,
        lastSyncError: state.lastSyncError,
      }),
      migrate: (persistedState) => {
        const state = persistedState as Record<string, unknown> | null;
        // Guard against corrupted storage — fall back to pristine defaults.
        if (!state || typeof state !== 'object') {
          return {
            enrollmentStatus: 'unset',
            storageBackend: 'app',
            storageChosen: false,
            encryptionMode: 'encrypted',
            localKeyId: null,
            localKeyEpoch: 1,
            lastSyncedVersion: null,
            lastSyncedEtag: null,
            lastBackupAt: null,
            lastSyncError: null,
          };
        }
        // v1 → v2: pre-OneDrive enrollments are app-storage by definition.
        if (
          state.storageBackend !== 'app' &&
          state.storageBackend !== 'onedrive'
        ) {
          state.storageBackend = 'app';
        }
        // v2 → v3: earlier states predate the OneDrive default + plain mode;
        // an existing backend value counts as a made choice.
        if (typeof state.storageChosen !== 'boolean') {
          state.storageChosen = state.enrollmentStatus === 'enrolled';
        }
        if (
          state.encryptionMode !== 'encrypted' &&
          state.encryptionMode !== 'plain'
        ) {
          state.encryptionMode = 'encrypted';
        }
        return state;
      },
      onRehydrateStorage: () => (state, error) => {
        if (error) {
          console.error('[BackupStore] Hydration error:', error);
          return;
        }
        if (
          state &&
          !['unset', 'enrolled', 'declined'].includes(state.enrollmentStatus)
        ) {
          state.enrollmentStatus = 'unset';
        }
      },
    },
  ),
);
