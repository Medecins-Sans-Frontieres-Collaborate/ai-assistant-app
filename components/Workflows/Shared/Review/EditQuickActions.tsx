'use client';

import { IconCheck, IconX } from '@tabler/icons-react';

import { useTranslations } from 'next-intl';

/** Where the user clicked, relative to the positioned text container. */
export interface PinPoint {
  x: number;
  y: number;
}

interface EditQuickActionsProps {
  editId: string;
  /** e.g. 'workflows.document' — provides the review-chrome strings. */
  i18nNamespace: string;
  /** Anchor point; the bar sits just below-right of it. */
  position: PinPoint;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  disabled?: boolean;
}

/**
 * Accept/reject for the edit currently pinned in the text, floating at the
 * point the user clicked — on a long span, a bar parked at the end can be
 * lines away from where you were reading.
 *
 * Absolutely positioned rather than fixed, so it is laid out against the
 * text container and scrolls with the content instead of detaching from it.
 */
export function EditQuickActions({
  editId,
  i18nNamespace,
  position,
  onAccept,
  onReject,
  disabled,
}: EditQuickActionsProps) {
  const t = useTranslations(i18nNamespace);

  return (
    <span
      contentEditable={false}
      style={{ left: position.x, top: position.y }}
      // Keep clicks from bubbling to the dismiss-on-outside-click handler.
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      className="absolute z-20 inline-flex -translate-y-1/2 select-none items-center gap-0.5 whitespace-nowrap rounded-md border border-amber-300 bg-white p-0.5 shadow-md dark:border-amber-500/50 dark:bg-surface-dark-elevated"
    >
      <button
        type="button"
        onClick={() => onAccept(editId)}
        disabled={disabled}
        title={t('acceptEdit')}
        aria-label={t('acceptEdit')}
        className="inline-flex h-5 w-5 items-center justify-center rounded text-green-700 hover:bg-green-100 disabled:opacity-40 dark:text-green-400 dark:hover:bg-green-900/40"
      >
        <IconCheck size={13} aria-hidden />
      </button>
      <button
        type="button"
        onClick={() => onReject(editId)}
        disabled={disabled}
        title={t('rejectEdit')}
        aria-label={t('rejectEdit')}
        className="inline-flex h-5 w-5 items-center justify-center rounded text-red-700 hover:bg-red-100 disabled:opacity-40 dark:text-red-400 dark:hover:bg-red-900/40"
      >
        <IconX size={13} aria-hidden />
      </button>
    </span>
  );
}
