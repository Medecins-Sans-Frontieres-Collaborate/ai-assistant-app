'use client';

import { IconCloudOff, IconKey, IconX } from '@tabler/icons-react';
import React, { useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { useUI } from '@/client/hooks/ui/useUI';

import { getBackupKeys } from '@/client/services/backup/keystore';

import { pushFullBackup } from '@/lib/utils/app/backup/backupOps';

import ConfirmDialog from '@/components/UI/ConfirmDialog';

import { useBackupStore } from '@/client/stores/backupStore';
import { useUIStore } from '@/client/stores/uiStore';

/**
 * Persistent banner for the two states that pause syncing (plan: same-key
 * ETag races resolve silently — 'error'/'syncing' never surface here):
 * - amber `key-out-of-date`: the key changed on another device; offer
 *   entering the new key or resetting the backup with this device's key;
 * - gray `remote-missing`: the backup was wiped remotely; offer re-creating
 *   it or dismissing.
 */
export function BackupSyncBanner() {
  const t = useTranslations('backup');
  const { showChatbar } = useUI();
  const flagEnabled = useBackupStore((state) => state.flagEnabled);
  const syncStatus = useBackupStore((state) => state.syncStatus);
  const bannerCollapsed = useBackupStore((state) => state.bannerCollapsed);
  const setBackupModalView = useUIStore((state) => state.setBackupModalView);

  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const visible =
    flagEnabled &&
    !bannerCollapsed &&
    (syncStatus === 'key-out-of-date' || syncStatus === 'remote-missing');
  if (!visible) return null;

  const isKeyMismatch = syncStatus === 'key-out-of-date';

  const recreateBackup = async (overwriteLive: boolean) => {
    setBusy(true);
    try {
      const keys = await getBackupKeys();
      if (!keys) {
        // Enrolled but keyless — resetting is impossible; route to entering
        // a key instead.
        setBackupModalView('enter-key');
        return;
      }
      const result = await pushFullBackup(keys, { overwriteLive });
      const store = useBackupStore.getState();
      store.setEnrolled(keys.keyId, result.epoch);
      store.setSyncStatus('ok');
      toast.success(
        overwriteLive ? t('toast.resetDone') : t('toast.backupRestarted'),
      );
    } catch {
      toast.error(t('toast.opFailed'));
    } finally {
      setBusy(false);
    }
  };

  const styles = isKeyMismatch
    ? {
        container:
          'bg-amber-100/95 dark:bg-amber-900/40 border-b border-amber-300/70 dark:border-amber-700/50',
        icon: 'text-amber-600 dark:text-amber-400',
      }
    : {
        container:
          'bg-gray-100/95 dark:bg-gray-800/80 border-b border-gray-300/70 dark:border-gray-600/50',
        icon: 'text-gray-500 dark:text-gray-400',
      };

  return (
    <div className="fixed top-0 left-0 right-0 z-[58] pointer-events-none">
      <div className="flex">
        {/* Spacer for sidebar on desktop - matches sidebar width */}
        <div
          className={`sidebar-width-target hidden md:block transition-all duration-300 ${
            showChatbar ? 'w-[var(--sidebar-width,260px)]' : 'w-14'
          }`}
        />
        <div className="flex-1 pointer-events-auto">
          <div className={`backdrop-blur-xl shadow-lg ${styles.container}`}>
            <div className="px-3 md:px-4 py-1.5 md:py-2">
              <div className="flex items-center justify-between gap-2 md:gap-3">
                <div className="flex items-center gap-1.5 md:gap-2 flex-1 min-w-0">
                  {isKeyMismatch ? (
                    <IconKey size={16} className={styles.icon} />
                  ) : (
                    <IconCloudOff size={16} className={styles.icon} />
                  )}
                  <p className="text-xs font-semibold text-gray-900 dark:text-white truncate">
                    {isKeyMismatch
                      ? t('banner.keyMismatchTitle')
                      : t('banner.remoteMissingTitle')}
                  </p>
                </div>

                <div className="flex items-center gap-1 md:gap-1.5 flex-shrink-0">
                  {isKeyMismatch ? (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setBackupModalView('enter-key')}
                        className="px-2 md:px-2.5 py-0.5 md:py-1 text-xs font-medium bg-amber-600 hover:bg-amber-700 text-white rounded transition-colors whitespace-nowrap disabled:opacity-50"
                      >
                        {t('banner.enterNewKey')}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setShowResetConfirm(true)}
                        className="px-2 md:px-2.5 py-0.5 md:py-1 text-xs font-medium bg-transparent hover:bg-amber-200/60 dark:hover:bg-amber-800/40 text-gray-900 dark:text-gray-100 rounded transition-colors whitespace-nowrap disabled:opacity-50"
                      >
                        {t('banner.resetBackup')}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void recreateBackup(false)}
                      className="px-2 md:px-2.5 py-0.5 md:py-1 text-xs font-medium bg-gray-600 hover:bg-gray-700 text-white rounded transition-colors whitespace-nowrap disabled:opacity-50"
                    >
                      {t('banner.backUpAgain')}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      useBackupStore.getState().setBannerCollapsed(true)
                    }
                    className="p-0.5 md:p-1 hover:bg-gray-200/50 dark:hover:bg-gray-700/50 rounded transition-colors text-gray-700 dark:text-gray-300"
                    aria-label={t('banner.dismiss')}
                  >
                    <IconX size={14} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="pointer-events-auto">
        <ConfirmDialog
          isOpen={showResetConfirm}
          title={t('banner.resetConfirmTitle')}
          message={t('banner.resetConfirmBody')}
          confirmLabel={t('banner.resetConfirmAction')}
          confirmVariant="danger"
          onConfirm={() => {
            setShowResetConfirm(false);
            void recreateBackup(true);
          }}
          onCancel={() => setShowResetConfirm(false)}
        />
      </div>
    </div>
  );
}
