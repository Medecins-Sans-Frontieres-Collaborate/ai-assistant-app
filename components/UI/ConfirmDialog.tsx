'use client';

import React, { useCallback, useEffect } from 'react';

import { useTranslations } from 'next-intl';

import Modal from './Modal';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: 'danger' | 'primary';
  /** Optional content rendered between the message and the action buttons. */
  extraContent?: React.ReactNode;
  /**
   * Forwarded to the underlying Modal. Use this to raise the z-index when the
   * dialog is opened from within another modal/overlay — Modal defaults to
   * `z-50`, which renders behind higher-stacked parents (e.g. a `z-[150]`
   * model-select modal). Pass e.g. `z-[200]` to stack above it.
   */
  className?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A reusable confirmation dialog component.
 * Uses the Modal component as base and provides confirm/cancel actions.
 */
export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmLabel,
  cancelLabel,
  confirmVariant = 'primary',
  extraContent,
  className,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const t = useTranslations();

  const resolvedConfirmLabel = confirmLabel || t('common.confirm');
  const resolvedCancelLabel = cancelLabel || t('common.cancel');

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!isOpen) return;

      if (event.key === 'Enter') {
        // Don't trigger confirm if the user is typing in an editable field
        // inside the dialog body (e.g. a future textarea passed via
        // `extraContent`). Without this guard, pressing Enter to add a
        // newline in such a field would instead fire the confirm action.
        const target = event.target as HTMLElement | null;
        const tag = target?.tagName;
        const isEditable =
          tag === 'TEXTAREA' ||
          tag === 'INPUT' ||
          tag === 'SELECT' ||
          target?.isContentEditable === true;
        if (isEditable) return;

        event.preventDefault();
        onConfirm();
      }
      // Escape is handled by the Modal component
    },
    [isOpen, onConfirm],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const confirmButtonClasses =
    confirmVariant === 'danger'
      ? 'bg-red-500 hover:bg-red-600 text-white'
      : 'bg-blue-500 hover:bg-blue-600 text-white';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={title}
      size="sm"
      className={className}
      showCloseButton={false}
      footer={
        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg bg-neutral-200 dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 hover:bg-neutral-300 dark:hover:bg-neutral-600 transition-colors"
          >
            {resolvedCancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 rounded-lg transition-colors ${confirmButtonClasses}`}
          >
            {resolvedConfirmLabel}
          </button>
        </div>
      }
    >
      <p className="text-neutral-700 dark:text-neutral-300">{message}</p>
      {extraContent && <div className="mt-4">{extraContent}</div>}
    </Modal>
  );
}

export default ConfirmDialog;
