'use client';

import { FC } from 'react';

import { useTranslations } from 'next-intl';

import Modal from '@/components/UI/Modal';

interface PendingEditsDialogProps {
  isOpen: boolean;
  /** How many suggestions are still awaiting a decision. */
  pendingCount: number;
  /** What the user asked for, already localized ("Revising", "Translating"). */
  actionLabel: string;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  onCancel: () => void;
}

/**
 * Gate for an AI run while a review still has open suggestions
 * (docs/REVIEW_EDIT_UNFREEZE_DESIGN.md §6b).
 *
 * A revision, a re-assessment or a re-translation can rewrite any part of the
 * text — including passages with suggestions the user has not judged yet — and
 * a new assessment replaces the queue outright. So the queue is decided
 * first, in bulk, and the run follows. Three answers, no default: accepting
 * everything and rejecting everything are equally legitimate ways to clear a
 * queue, and neither is something to land by mistake.
 */
export const PendingEditsDialog: FC<PendingEditsDialogProps> = ({
  isOpen,
  pendingCount,
  actionLabel,
  onAcceptAll,
  onRejectAll,
  onCancel,
}) => {
  const t = useTranslations('workflows.shared.pendingRun');

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={t('title', { count: String(pendingCount) })}
      size="sm"
      showCloseButton={false}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg bg-neutral-200 px-4 py-2 text-neutral-900 transition-colors hover:bg-neutral-300 dark:bg-neutral-700 dark:text-neutral-100 dark:hover:bg-neutral-600"
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            onClick={onRejectAll}
            className="rounded-lg border border-neutral-300 px-4 py-2 text-neutral-900 transition-colors hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-100 dark:hover:bg-neutral-700"
          >
            {t('rejectAll')}
          </button>
          <button
            type="button"
            onClick={onAcceptAll}
            className="rounded-lg bg-blue-500 px-4 py-2 text-white transition-colors hover:bg-blue-600"
          >
            {t('acceptAll')}
          </button>
        </div>
      }
    >
      <p className="text-sm text-gray-700 dark:text-gray-300">
        {t('body', { action: actionLabel })}
      </p>
    </Modal>
  );
};
