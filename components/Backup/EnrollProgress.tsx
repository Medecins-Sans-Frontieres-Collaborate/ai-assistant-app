'use client';

import { IconCircleCheck } from '@tabler/icons-react';
import React, { useEffect, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import Modal from '@/components/UI/Modal';

import { useConversationStore } from '@/client/stores/conversationStore';

export type EnrollProgressMode = 'create' | 'rotate';

export interface EnrollProgressProps {
  isOpen: boolean;
  mode: EnrollProgressMode;
  /** The backup work; resolves the number of conversations pushed. */
  run: () => Promise<number>;
  /** Rotate mode continues straight into the re-save ceremony. */
  onSuccess: (pushedCount: number) => void;
  /** Close after create-success "Done" or a failure "Close". */
  onClose: () => void;
}

type Phase = 'running' | 'success' | 'error';

/**
 * Non-dismissible progress modal for the initial full backup (create) and
 * key-rotation re-encryption (rotate).
 */
export function EnrollProgress({
  isOpen,
  mode,
  run,
  onSuccess,
  onClose,
}: EnrollProgressProps) {
  const t = useTranslations('backup');
  const conversationCount = useConversationStore(
    (state) => state.conversations.length,
  );

  const [phase, setPhase] = useState<Phase>('running');
  const [pushedCount, setPushedCount] = useState(0);
  const startedRef = useRef(false);

  // Latest-callback refs so the one-shot effect below never restarts the
  // (side-effecting, network-heavy) run because a parent re-rendered.
  const runRef = useRef(run);
  const onSuccessRef = useRef(onSuccess);
  useEffect(() => {
    runRef.current = run;
    onSuccessRef.current = onSuccess;
  });

  // Reset for the next open — state-adjust during render, not an effect.
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
  if (isOpen !== prevIsOpen) {
    setPrevIsOpen(isOpen);
    startedRef.current = false;
    if (isOpen) {
      setPhase('running');
      setPushedCount(0);
    }
  }

  // No synchronous setState here: the run's outcome lands via promise
  // callbacks only (react-hooks/set-state-in-effect).
  const start = React.useCallback((mode_: EnrollProgressMode) => {
    Promise.resolve()
      .then(() => runRef.current())
      .then(
        (pushed) => {
          setPushedCount(pushed);
          if (mode_ === 'rotate') {
            // Rotation continues straight into the re-save ceremony — no
            // intermediate success screen.
            onSuccessRef.current(pushed);
          } else {
            setPhase('success');
          }
        },
        () => setPhase('error'),
      );
  }, []);

  useEffect(() => {
    if (!isOpen || startedRef.current) return;
    startedRef.current = true;
    start(mode);
  }, [isOpen, mode, start]);

  const retry = () => {
    setPhase('running');
    start(mode);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        mode === 'create'
          ? t('progress.titleCreate')
          : t('progress.titleRotate')
      }
      size="sm"
      preventOutsideClick
      preventEscapeKey
      showCloseButton={false}
    >
      {phase === 'running' && (
        <div className="flex items-center gap-3 text-sm text-gray-700 dark:text-gray-300">
          <span
            className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-blue-500 border-t-transparent"
            role="status"
            aria-label={t('progress.encrypting', { count: conversationCount })}
          />
          <p>{t('progress.encrypting', { count: conversationCount })}</p>
        </div>
      )}

      {phase === 'success' && (
        <div>
          <div className="flex items-center gap-3 text-sm text-gray-700 dark:text-gray-300">
            <IconCircleCheck
              size={22}
              className="shrink-0 text-green-600 dark:text-green-400"
            />
            <p>{t('progress.success', { count: pushedCount })}</p>
          </div>
          <div className="mt-6 flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors"
            >
              {t('progress.done')}
            </button>
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div>
          <p className="text-sm text-red-600 dark:text-red-400">
            {t('progress.error')}
          </p>
          <div className="mt-6 flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-neutral-200 dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 hover:bg-neutral-300 dark:hover:bg-neutral-600 transition-colors"
            >
              {t('progress.close')}
            </button>
            <button
              type="button"
              onClick={retry}
              className="px-4 py-2 rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors"
            >
              {t('progress.retry')}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
