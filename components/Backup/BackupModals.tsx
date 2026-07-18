'use client';

import { useFlags } from 'launchdarkly-react-client-sdk';
import { useSession } from 'next-auth/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { useBackupSync } from '@/client/hooks/backup/useBackupSync';

import {
  getBackupKeys,
  loadMasterKey,
  resetBackupKeyCache,
  saveMasterKey,
} from '@/client/services/backup/keystore';
import { runSync } from '@/lib/services/backup/syncEngine';

import {
  buildBackupSyncDeps,
  pushFullBackup,
} from '@/lib/utils/app/backup/backupOps';
import { deriveBackupKeys } from '@/lib/utils/shared/backupCrypto/keyDerivation';
import { generateMasterKey } from '@/lib/utils/shared/backupCrypto/recoveryCode';

import ConfirmDialog from '@/components/UI/ConfirmDialog';

import { EnrollIntro } from './EnrollIntro';
import { EnrollProgress } from './EnrollProgress';
import { EnterKeyModal } from './EnterKeyModal';
import { RecoveryKeyCeremony } from './RecoveryKeyCeremony';
import { RestoreModal } from './RestoreModal';

import { useBackupStore } from '@/client/stores/backupStore';
import { useConversationStore } from '@/client/stores/conversationStore';
import { useUIStore } from '@/client/stores/uiStore';

/**
 * Always-mounted host for every encrypted-backup modal, mounted in ChatShell.
 *
 * Mirrors the `enableEncryptedBackups` LaunchDarkly flag into backupStore
 * (AppInitializer pattern) and renders nothing unless the flag is explicitly
 * `true` — an unserved flag or LD outage must degrade to "backups off"
 * (fail-closed, like `mcpArbitraryServers`).
 */
export function BackupModals() {
  const { enableEncryptedBackups } = useFlags();
  const enabled = enableEncryptedBackups === true;

  useEffect(() => {
    useBackupStore.getState().setFlagEnabled(enabled);
  }, [enabled]);

  if (!enabled) return null;
  return <BackupModalsInner />;
}

/**
 * Sync-trigger host. Keyed by localKeyId in the parent so a key change
 * (restore / rotate / enter-new-key) remounts it — clearing the hook's
 * memoized derived keys and re-running the on-load pull-merge-push under the
 * new key.
 */
function BackupSyncHost() {
  useBackupSync();
  return null;
}

function BackupModalsInner() {
  const t = useTranslations('backup');
  const { status: sessionStatus } = useSession();
  const view = useUIStore((state) => state.backupModalView);
  const setView = useUIStore((state) => state.setBackupModalView);
  const isTermsModalOpen = useUIStore((state) => state.isTermsModalOpen);
  const isLoaded = useConversationStore((state) => state.isLoaded);
  const enrollmentStatus = useBackupStore((state) => state.enrollmentStatus);
  const localKeyId = useBackupStore((state) => state.localKeyId);

  const [ceremonyMode, setCeremonyMode] = useState<'create' | 'rotate'>(
    'create',
  );
  // The master key in flight between ceremony steps (create: intro →
  // ceremony → progress; rotate: progress → forced re-save ceremony).
  const [pendingKey, setPendingKey] = useState<Uint8Array | null>(null);
  const promptedRef = useRef(false);

  // Auto-prompt matrix, once per mount, after session + store rehydrate +
  // remote status are known and while no other backup modal (or the terms
  // modal) is open:
  //   remote exists & no local key           → restore (outranks declined)
  //   'unset' & no remote & no local key     → enroll intro
  //   declined (and no restorable remote)    → never nagged
  useEffect(() => {
    if (promptedRef.current) return;
    if (sessionStatus !== 'authenticated' || !isLoaded) return;
    if (isTermsModalOpen) return; // re-evaluated when the terms modal closes
    if (view !== null) return;

    let cancelled = false;
    void (async () => {
      const remote = await useBackupStore.getState().refreshRemoteStatus();
      if (cancelled || promptedRef.current) return;
      if (remote === null) return; // unknown (fetch failed) — try again later
      const hasLocalKey = (await loadMasterKey().catch(() => null)) !== null;
      if (cancelled || promptedRef.current) return;
      // The matrix is now decidable — whatever the outcome, never prompt twice.
      promptedRef.current = true;
      if (remote.exists && !hasLocalKey) {
        useUIStore.getState().setBackupModalView('restore');
        return;
      }
      const { enrollmentStatus: enrollment } = useBackupStore.getState();
      if (!remote.exists && enrollment === 'unset' && !hasLocalKey) {
        useUIStore.getState().setBackupModalView('enroll-intro');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionStatus, isLoaded, isTermsModalOpen, view, enrollmentStatus]);

  const declineEnrollment = useCallback(() => {
    setPendingKey(null);
    useBackupStore.getState().setDeclined();
    setView(null);
    toast(t('toast.enrollLater'));
  }, [setView, t]);

  const handleIntroCreate = useCallback(() => {
    setPendingKey(generateMasterKey());
    setCeremonyMode('create');
    setView('enroll-ceremony');
  }, [setView]);

  // Create ceremony passed the save gate: persist the key and move to the
  // first backup. Enrollment is committed only AFTER that backup succeeds —
  // committing here would (a) persist an enrolled state a failed/blocked
  // push can't honour, and (b) flip localKeyId, remounting the sync host
  // whose on-load sync would race the ceremony's own run.
  const handleCreateContinue = useCallback(async () => {
    const master = pendingKey;
    if (!master) return;
    try {
      await saveMasterKey(master);
      resetBackupKeyCache();
      setPendingKey(null);
      setView('enroll-progress');
    } catch {
      toast.error(t('toast.opFailed'));
    }
  }, [pendingKey, setView, t]);

  // Initial full backup. runSync creates the manifest on a plain 404; a
  // disabled tombstone manifest reads as 'remote-missing', where the
  // from-scratch push (epoch+1 over the tombstone) takes over. A LIVE
  // manifest under a different key is never overwritten from here — that is
  // the restore/reset flows' job.
  const runCreateBackup = useCallback(async (): Promise<number> => {
    const keys = await getBackupKeys();
    if (!keys) throw new Error('backup key missing after enrollment');
    const store = useBackupStore.getState();
    const result = await runSync(buildBackupSyncDeps(keys));
    if (result.status === 'remote-missing') {
      const pushed = await pushFullBackup(keys);
      store.setEnrolled(keys.keyId, pushed.epoch);
      store.setSyncStatus('ok');
      return pushed.pushed;
    }
    if (result.status !== 'ok') {
      throw new Error(result.error ?? `backup failed (${result.status})`);
    }
    // recordSyncPoint already adopted the manifest epoch during the sync.
    store.setEnrolled(keys.keyId, useBackupStore.getState().localKeyEpoch);
    store.setSyncStatus('ok');
    // Report the protected corpus size, not the engine's pushed count — a
    // coalesced rerun can legitimately report 0 pushes for a full backup.
    return useConversationStore.getState().conversations.length;
  }, []);

  // Rotation (plan ordering): pull-merge under the CURRENT key first (the
  // new manifest is rebuilt from the local corpus only, so anything another
  // device pushed since our last pull must be merged in before the old key
  // stops working), then re-encrypt + upload + CAS under the NEW key, then
  // overwrite the keystore — the forced re-save ceremony follows.
  const runRotateBackup = useCallback(async (): Promise<number> => {
    const currentKeys = await getBackupKeys();
    if (currentKeys) {
      const pre = await runSync(buildBackupSyncDeps(currentKeys));
      if (pre.status !== 'ok' && pre.status !== 'remote-missing') {
        throw new Error(
          pre.error ?? `backup not in sync before rotation (${pre.status})`,
        );
      }
    }
    const master = generateMasterKey();
    const keys = await deriveBackupKeys(master);
    const result = await pushFullBackup(keys, { overwriteLive: true });
    await saveMasterKey(master);
    resetBackupKeyCache();
    useBackupStore.getState().setEnrolled(keys.keyId, result.epoch);
    useBackupStore.getState().setSyncStatus('ok');
    setPendingKey(master);
    return result.pushed;
  }, []);

  return (
    <>
      <BackupSyncHost key={localKeyId ?? 'no-key'} />

      <EnrollIntro
        isOpen={view === 'enroll-intro'}
        onCreate={handleIntroCreate}
        onDecline={declineEnrollment}
      />

      {view === 'enroll-ceremony' && (
        <RecoveryKeyCeremony
          isOpen
          mode={ceremonyMode}
          masterKey={pendingKey}
          onContinue={
            ceremonyMode === 'create'
              ? () => void handleCreateContinue()
              : () => {
                  // Rotation is already committed — this just ends the
                  // forced re-save.
                  setPendingKey(null);
                  setView(null);
                }
          }
          onClose={
            ceremonyMode === 'create'
              ? declineEnrollment
              : () => {
                  setPendingKey(null);
                  setView(null);
                }
          }
        />
      )}

      {view === 'view-key' && (
        <RecoveryKeyCeremony
          isOpen
          mode="view"
          masterKey={null}
          onContinue={() => setView(null)}
          onClose={() => setView(null)}
        />
      )}

      {view === 'enroll-progress' && (
        <EnrollProgress
          isOpen
          mode={ceremonyMode}
          run={ceremonyMode === 'create' ? runCreateBackup : runRotateBackup}
          onSuccess={() => {
            if (ceremonyMode === 'rotate') setView('enroll-ceremony');
          }}
          onClose={() => setView(null)}
        />
      )}

      <ConfirmDialog
        isOpen={view === 'rotate-confirm'}
        title={t('rotate.confirmTitle')}
        message={t('rotate.confirmBody')}
        confirmLabel={t('rotate.confirmAction')}
        onConfirm={() => {
          setCeremonyMode('rotate');
          setView('enroll-progress');
        }}
        onCancel={() => setView(null)}
      />

      <RestoreModal
        isOpen={view === 'restore'}
        onSkip={declineEnrollment}
        onDone={() => setView(null)}
      />

      <EnterKeyModal
        isOpen={view === 'enter-key'}
        onClose={() => setView(null)}
        onAdopted={() => setView(null)}
      />
    </>
  );
}
