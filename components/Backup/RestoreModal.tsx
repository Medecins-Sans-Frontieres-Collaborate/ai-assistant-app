'use client';

import { IconCircleCheck } from '@tabler/icons-react';
import React, { useCallback, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  resetBackupKeyCache,
  saveMasterKey,
} from '@/client/services/backup/keystore';
import { restoreFromRemote } from '@/lib/services/backup/syncEngine';

import { buildBackupSyncDeps } from '@/lib/utils/app/backup/backupOps';
import {
  computeKeyId,
  deriveBackupKeys,
} from '@/lib/utils/shared/backupCrypto/keyDerivation';

import Modal from '@/components/UI/Modal';

import { RecoveryCodeInput } from './RecoveryCodeInput';

import { useBackupStore } from '@/client/stores/backupStore';

export interface RestoreModalProps {
  isOpen: boolean;
  /** Skip / dismiss during the prompt — the caller persists `declined`. */
  onSkip: () => void;
  /** Close after a successful restore. */
  onDone: () => void;
}

type Phase =
  | 'prompt'
  | 'restoring'
  | 'success'
  | 'wrong-key'
  | 'corrupt'
  | 'network-error';

/**
 * "We found a backup" restore flow. The checksum in RecoveryCodeInput already
 * rejects typos locally; a checksum-valid code whose fingerprint doesn't match
 * the remote manifest is an old/rotated key ("wrong-key" branch), while
 * decrypt/read failures on matching-key data are the "corrupt" branch.
 */
export function RestoreModal({ isOpen, onSkip, onDone }: RestoreModalProps) {
  const t = useTranslations('backup');
  const [phase, setPhase] = useState<Phase>('prompt');
  const [restoredCount, setRestoredCount] = useState(0);

  const handleSubmit = useCallback(async (key: Uint8Array) => {
    setPhase('restoring');
    try {
      // Always refresh — a cached fingerprint may predate a rotation on
      // another device, which would reject the correct (newest) code on
      // every retry until a reload.
      const remote = await useBackupStore.getState().refreshRemoteStatus();
      if (remote === null) {
        setPhase('network-error');
        return;
      }
      const keyId = await computeKeyId(key);
      if (remote.keyId === null || keyId !== remote.keyId) {
        setPhase('wrong-key');
        return;
      }

      const keys = await deriveBackupKeys(key);
      const result = await restoreFromRemote(buildBackupSyncDeps(keys));
      if (result.status === 'ok') {
        // Commit the key and enrollment only after the restore verified
        // end-to-end — never persist an enrolled state under an unproven key.
        await saveMasterKey(key);
        resetBackupKeyCache();
        useBackupStore.getState().setEnrolled(keyId, remote.epoch ?? 1);
        setRestoredCount(result.pulled);
        setPhase('success');
      } else if (result.status === 'key-out-of-date') {
        setPhase('wrong-key');
      } else if (result.errorCode === 'NETWORK') {
        setPhase('network-error');
      } else {
        setPhase('corrupt');
      }
    } catch {
      setPhase('network-error');
    }
  }, []);

  const dismissible = phase !== 'restoring';
  const handleClose =
    phase === 'success' ? onDone : dismissible ? onSkip : () => undefined;

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={
        phase === 'success' ? t('restore.successTitle') : t('restore.title')
      }
      size="md"
      preventOutsideClick={!dismissible}
      preventEscapeKey={!dismissible}
      showCloseButton={dismissible}
    >
      {phase === 'prompt' && (
        <div>
          <p className="text-sm text-gray-700 dark:text-gray-300">
            {t('restore.promptBody')}
          </p>
          <div className="mt-4">
            <RecoveryCodeInput
              onSubmit={handleSubmit}
              submitLabel={t('restore.submit')}
              autoFocus
            />
          </div>
          <button
            type="button"
            onClick={onSkip}
            className="mt-3 w-full px-4 py-2 rounded-lg bg-neutral-200 dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 hover:bg-neutral-300 dark:hover:bg-neutral-600 transition-colors"
          >
            {t('restore.skip')}
          </button>
        </div>
      )}

      {phase === 'restoring' && (
        <div className="flex items-center gap-3 text-sm text-gray-700 dark:text-gray-300">
          <span
            className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-blue-500 border-t-transparent"
            role="status"
            aria-label={t('restore.restoring')}
          />
          <p>{t('restore.restoring')}</p>
        </div>
      )}

      {phase === 'success' && (
        <div>
          <div className="flex items-center gap-3 text-sm text-gray-700 dark:text-gray-300">
            <IconCircleCheck
              size={22}
              className="shrink-0 text-green-600 dark:text-green-400"
            />
            <p>{t('restore.successBody', { count: restoredCount })}</p>
          </div>
          <div className="mt-6 flex justify-end">
            <button
              type="button"
              onClick={onDone}
              className="px-4 py-2 rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors"
            >
              {t('restore.close')}
            </button>
          </div>
        </div>
      )}

      {(phase === 'wrong-key' ||
        phase === 'corrupt' ||
        phase === 'network-error') && (
        <div>
          <p className="text-sm text-red-600 dark:text-red-400">
            {phase === 'wrong-key'
              ? t('restore.wrongKey')
              : phase === 'corrupt'
                ? t('restore.corrupt')
                : t('restore.networkError')}
          </p>
          <div className="mt-6 flex justify-end gap-3">
            <button
              type="button"
              onClick={onSkip}
              className="px-4 py-2 rounded-lg bg-neutral-200 dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 hover:bg-neutral-300 dark:hover:bg-neutral-600 transition-colors"
            >
              {t('restore.skip')}
            </button>
            <button
              type="button"
              onClick={() => setPhase('prompt')}
              className="px-4 py-2 rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors"
            >
              {t('restore.tryAgain')}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
