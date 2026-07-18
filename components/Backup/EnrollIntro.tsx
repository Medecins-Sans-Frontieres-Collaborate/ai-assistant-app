'use client';

import { IconLock } from '@tabler/icons-react';
import React from 'react';

import { useTranslations } from 'next-intl';

import Modal from '@/components/UI/Modal';

export interface EnrollIntroProps {
  isOpen: boolean;
  /** Primary action — proceed to key creation. */
  onCreate: () => void;
  /**
   * Any dismissal (X / ESC / backdrop / secondary button) — the caller
   * persists `declined` and shows the "anytime in Settings" toast.
   */
  onDecline: () => void;
}

/** Opt-in pitch for encrypted backup. */
export function EnrollIntro({ isOpen, onCreate, onDecline }: EnrollIntroProps) {
  const t = useTranslations('backup');

  return (
    <Modal
      isOpen={isOpen}
      onClose={onDecline}
      title={t('intro.title')}
      icon={<IconLock size={22} className="text-blue-500" />}
      size="md"
    >
      <div className="space-y-3 text-sm text-gray-700 dark:text-gray-300">
        <p>{t('intro.body')}</p>
        <p className="font-medium">{t('intro.keyWarning')}</p>
      </div>
      <div className="mt-6 flex flex-col gap-2">
        <button
          type="button"
          onClick={onCreate}
          className="w-full px-4 py-2 rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors"
        >
          {t('intro.create')}
        </button>
        <button
          type="button"
          onClick={onDecline}
          className="w-full px-4 py-2 rounded-lg bg-neutral-200 dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 hover:bg-neutral-300 dark:hover:bg-neutral-600 transition-colors"
        >
          {t('intro.decline')}
        </button>
      </div>
    </Modal>
  );
}
