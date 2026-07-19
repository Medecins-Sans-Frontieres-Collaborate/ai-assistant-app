'use client';

import React, { useCallback, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import {
  resetBackupKeyCache,
  saveMasterKey,
} from '@/client/services/backup/keystore';

import { computeKeyId } from '@/lib/utils/shared/backupCrypto/keyDerivation';

import Modal from '@/components/UI/Modal';

import { RecoveryCodeInput } from './RecoveryCodeInput';

import { useBackupStore } from '@/client/stores/backupStore';

export interface EnterKeyModalProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * The remote backup's (rotated) key was adopted on this device. The caller
   * closes the modal and restarts sync under the new key.
   */
  onAdopted: () => void;
}

/**
 * "Key changed on another device" recovery: the user enters the NEW recovery
 * code; its fingerprint must match the remote manifest's keyId before this
 * device adopts it.
 */
export function EnterKeyModal({
  isOpen,
  onClose,
  onAdopted,
}: EnterKeyModalProps) {
  const t = useTranslations('backup');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (key: Uint8Array) => {
      setBusy(true);
      setError(null);
      try {
        // Always refresh: the cached remote snapshot may predate the rotation.
        const remote = await useBackupStore.getState().refreshRemoteStatus();
        if (remote === null) {
          setError(t('restore.networkError'));
          return;
        }
        const keyId = await computeKeyId(key);
        if (remote.keyId === null || keyId !== remote.keyId) {
          setError(t('restore.wrongKey'));
          return;
        }
        await saveMasterKey(key);
        resetBackupKeyCache();
        const store = useBackupStore.getState();
        store.setEnrolled(keyId, remote.epoch ?? 1);
        store.setSyncStatus('idle');
        toast.success(t('toast.keyUpdated'));
        onAdopted();
      } finally {
        setBusy(false);
      }
    },
    [t, onAdopted],
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('enterKey.title')}
      size="md"
    >
      <p className="text-sm text-gray-700 dark:text-gray-300">
        {t('enterKey.body')}
      </p>
      <div className="mt-4">
        <RecoveryCodeInput
          onSubmit={handleSubmit}
          submitLabel={t('enterKey.submit')}
          disabled={busy}
          autoFocus
          externalError={error}
          onEdit={() => setError(null)}
        />
      </div>
    </Modal>
  );
}
