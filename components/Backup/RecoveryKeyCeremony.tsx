'use client';

import {
  IconCheck,
  IconCopy,
  IconDownload,
  IconQrcode,
} from '@tabler/icons-react';
import { QRCodeSVG } from 'qrcode.react';
import React, { useCallback, useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { loadMasterKey } from '@/client/services/backup/keystore';

import { downloadRecoveryKeyFile } from '@/lib/utils/app/backup/recoveryKeyFile';
import { encodeRecoveryCode } from '@/lib/utils/shared/backupCrypto/recoveryCode';

import ConfirmDialog from '@/components/UI/ConfirmDialog';
import Modal from '@/components/UI/Modal';

export type RecoveryKeyCeremonyMode = 'create' | 'rotate' | 'view';

export interface RecoveryKeyCeremonyProps {
  isOpen: boolean;
  mode: RecoveryKeyCeremonyMode;
  /**
   * Master key for create/rotate (held by the caller, not yet or already in
   * the keystore); ignored in view mode, which loads from the keystore.
   */
  masterKey: Uint8Array | null;
  /** Save-gated Continue (create/rotate) or Done (view). */
  onContinue: () => void;
  /** Backing out: confirmed cancel in create/rotate, plain close in view. */
  onClose: () => void;
}

/**
 * The recovery-key save ceremony. In create/rotate mode the modal cannot be
 * dismissed (no X, ESC and backdrop blocked); the user must Copy or Download
 * the code before the "I saved it" checkbox unlocks, and check it before
 * Continue unlocks. Cancel goes through a ConfirmDialog.
 */
export function RecoveryKeyCeremony({
  isOpen,
  mode,
  masterKey,
  onContinue,
  onClose,
}: RecoveryKeyCeremonyProps) {
  const t = useTranslations('backup');
  const gated = mode !== 'view';

  const [code, setCode] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [copiedFlash, setCopiedFlash] = useState(false);
  const [hasCopiedOrDownloaded, setHasCopiedOrDownloaded] = useState(false);
  const [savedChecked, setSavedChecked] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);

  // Reset ceremony progress whenever the modal (re)opens — state-adjust
  // during render (not an effect) per the React docs pattern.
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
  if (isOpen !== prevIsOpen) {
    setPrevIsOpen(isOpen);
    if (isOpen) {
      setCode(null);
      setLoadError(false);
      setHasCopiedOrDownloaded(false);
      setSavedChecked(false);
      setShowQr(false);
      setShowCancelConfirm(false);
    }
  }

  // Resolve the code: encode the supplied key, or load it from the keystore
  // in view mode.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void (async () => {
      try {
        const key = mode === 'view' ? await loadMasterKey() : masterKey;
        if (!key) {
          if (!cancelled) setLoadError(true);
          return;
        }
        const encoded = await encodeRecoveryCode(key);
        if (!cancelled) setCode(encoded);
      } catch {
        if (!cancelled) setLoadError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, mode, masterKey]);

  // Clipboard label-swap idiom (AssistantMessage.tsx): flash "Copied!" for 2s.
  const handleCopy = useCallback(() => {
    if (!code || !navigator.clipboard) return;
    void navigator.clipboard.writeText(code).then(() => {
      setHasCopiedOrDownloaded(true);
      setCopiedFlash(true);
      setTimeout(() => setCopiedFlash(false), 2000);
    });
  }, [code]);

  const handleDownload = useCallback(() => {
    if (!code) return;
    downloadRecoveryKeyFile({
      code,
      headerLines: [t('file.heading'), t('file.warning')],
    });
    setHasCopiedOrDownloaded(true);
  }, [code, t]);

  const title =
    mode === 'create'
      ? t('ceremony.titleCreate')
      : mode === 'rotate'
        ? t('ceremony.titleRotate')
        : t('ceremony.titleView');

  const handleModalClose = gated ? () => setShowCancelConfirm(true) : onClose;

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={handleModalClose}
        title={title}
        size="lg"
        preventOutsideClick={gated}
        preventEscapeKey={gated}
        showCloseButton={!gated}
      >
        <p className="text-sm text-gray-700 dark:text-gray-300">
          {t('ceremony.description')}
        </p>

        {loadError ? (
          <p className="mt-4 text-sm text-red-600 dark:text-red-400">
            {t('ceremony.loadError')}
          </p>
        ) : (
          <div
            className="mt-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-4 font-mono text-base leading-relaxed tracking-wider text-gray-900 dark:text-gray-100 break-all select-all"
            data-testid="recovery-code"
          >
            {code ?? '…'}
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleCopy}
            disabled={!code}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-neutral-200 dark:bg-neutral-700 text-sm text-neutral-900 dark:text-neutral-100 hover:bg-neutral-300 dark:hover:bg-neutral-600 transition-colors disabled:opacity-50"
          >
            {copiedFlash ? <IconCheck size={16} /> : <IconCopy size={16} />}
            {copiedFlash ? t('ceremony.copied') : t('ceremony.copy')}
          </button>
          <button
            type="button"
            onClick={handleDownload}
            disabled={!code}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-neutral-200 dark:bg-neutral-700 text-sm text-neutral-900 dark:text-neutral-100 hover:bg-neutral-300 dark:hover:bg-neutral-600 transition-colors disabled:opacity-50"
          >
            <IconDownload size={16} />
            {t('ceremony.download')}
          </button>
          <button
            type="button"
            onClick={() => setShowQr((current) => !current)}
            disabled={!code}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-neutral-200 dark:bg-neutral-700 text-sm text-neutral-900 dark:text-neutral-100 hover:bg-neutral-300 dark:hover:bg-neutral-600 transition-colors disabled:opacity-50"
          >
            <IconQrcode size={16} />
            {showQr ? t('ceremony.hideQr') : t('ceremony.showQr')}
          </button>
        </div>

        {showQr && code && (
          <div className="mt-4 flex justify-center rounded-lg bg-white p-4">
            <QRCodeSVG value={code} size={168} level="M" />
          </div>
        )}

        {gated && (
          <div className="mt-6">
            <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
              <input
                type="checkbox"
                checked={savedChecked}
                disabled={!hasCopiedOrDownloaded}
                onChange={(event) => setSavedChecked(event.target.checked)}
                className="mt-0.5"
              />
              <span>{t('ceremony.savedCheckbox')}</span>
            </label>
            {!hasCopiedOrDownloaded && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t('ceremony.saveFirstHint')}
              </p>
            )}
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowCancelConfirm(true)}
                className="px-4 py-2 rounded-lg bg-neutral-200 dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 hover:bg-neutral-300 dark:hover:bg-neutral-600 transition-colors"
              >
                {t('ceremony.cancel')}
              </button>
              <button
                type="button"
                onClick={onContinue}
                disabled={!savedChecked}
                className="px-4 py-2 rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t('ceremony.continue')}
              </button>
            </div>
          </div>
        )}

        {!gated && (
          <div className="mt-6 flex justify-end">
            <button
              type="button"
              onClick={onContinue}
              className="px-4 py-2 rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors"
            >
              {t('ceremony.done')}
            </button>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        isOpen={showCancelConfirm}
        title={t('ceremony.cancelConfirmTitle')}
        message={
          mode === 'rotate'
            ? t('ceremony.cancelConfirmRotateBody')
            : t('ceremony.cancelConfirmBody')
        }
        confirmLabel={t('ceremony.cancelConfirmConfirm')}
        cancelLabel={t('ceremony.cancelConfirmDismiss')}
        confirmVariant="danger"
        className="z-[60]"
        onConfirm={() => {
          setShowCancelConfirm(false);
          onClose();
        }}
        onCancel={() => setShowCancelConfirm(false)}
      />
    </>
  );
}
