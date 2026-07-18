'use client';

import { IconArrowBackUp, IconCheck, IconX } from '@tabler/icons-react';

import { useTranslations } from 'next-intl';

import { ReviewEdit } from '@/types/workflow';

import { InlineWordDiff } from './InlineWordDiff';

interface EditSuggestionCardProps {
  edit: ReviewEdit;
  /** Builtin ids resolve via i18n; custom ids via the label snapshot. */
  resolveCriterionLabel: (id: string) => string;
  /** e.g. 'workflows.translation' — provides the review-chrome strings. */
  i18nNamespace: string;
  /** Where the edit applies (e.g. "row 3f · Amount") for non-text targets. */
  locationLabel?: string;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  /** Pointer/focus entered or left this card; drives the in-text preview. */
  onPreview?: (id: string | null) => void;
  /** This card's span is currently previewed in the text. */
  previewing?: boolean;
  /** Puts a resolved edit back in the queue (undoing the text change). */
  onRevert?: (id: string) => void;
  disabled?: boolean;
}

const SEVERITY_BADGE: Record<ReviewEdit['severity'], string> = {
  major: 'bg-red-100 text-red-900 dark:bg-red-900/30 dark:text-red-200',
  minor: 'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200',
};

/** One proposed edit: chips, inline diff, reasoning, accept/reject. */
export function EditSuggestionCard({
  edit,
  resolveCriterionLabel,
  i18nNamespace,
  locationLabel,
  onAccept,
  onReject,
  onPreview,
  previewing,
  onRevert,
  disabled,
}: EditSuggestionCardProps) {
  const t = useTranslations(i18nNamespace);
  const resolved = edit.status !== 'pending';
  // Resolved edits are already in (or absent from) the text — nothing to preview.
  const previewable = Boolean(onPreview) && !resolved;

  return (
    <div
      // Focus events bubble here from the accept/reject buttons, so tabbing
      // through the queue previews each edit the same way hovering does.
      onMouseEnter={previewable ? () => onPreview?.(edit.id) : undefined}
      onMouseLeave={previewable ? () => onPreview?.(null) : undefined}
      onFocus={previewable ? () => onPreview?.(edit.id) : undefined}
      onBlur={previewable ? () => onPreview?.(null) : undefined}
      className={`rounded-lg border p-2.5 transition-colors ${
        resolved ? 'opacity-60' : ''
      } ${
        previewing
          ? 'border-amber-400 bg-amber-50/60 dark:border-amber-500/60 dark:bg-amber-400/5'
          : 'border-gray-200 dark:border-gray-700'
      }`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={`rounded-sm px-1.5 py-0.5 text-[10px] font-medium ${SEVERITY_BADGE[edit.severity]}`}
        >
          {t(`severity.${edit.severity}`)}
        </span>
        <span className="rounded-sm bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-surface-dark-elevated dark:text-gray-400">
          {resolveCriterionLabel(edit.criterion)}
        </span>
        {resolved && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {edit.status === 'accepted'
              ? t('editAccepted')
              : edit.status === 'rejected'
                ? t('editRejected')
                : t('editUnapplicable')}
          </span>
        )}
        {resolved && onRevert && (
          <button
            type="button"
            onClick={() => onRevert(edit.id)}
            disabled={disabled}
            title={t('undoEdit')}
            className="ms-auto inline-flex min-h-[24px] items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
          >
            <IconArrowBackUp size={13} aria-hidden />
            {t('undoEdit')}
          </button>
        )}
      </div>

      {locationLabel && (
        <p className="mt-1 font-mono text-[11px] text-gray-500 dark:text-gray-400">
          {locationLabel}
        </p>
      )}
      <p className="mt-1.5 text-sm text-gray-800 dark:text-gray-200">
        <InlineWordDiff before={edit.before} after={edit.after} />
      </p>
      <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
        {edit.reason}
      </p>

      {!resolved && (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => onAccept(edit.id)}
            disabled={disabled}
            className="inline-flex min-h-[32px] items-center gap-1 rounded-lg bg-gray-200 px-2.5 py-1 text-xs font-medium text-gray-900 hover:bg-gray-300 disabled:opacity-40 dark:bg-surface-dark-elevated dark:text-gray-100 dark:hover:bg-gray-700"
          >
            <IconCheck size={13} aria-hidden />
            {t('acceptEdit')}
          </button>
          <button
            type="button"
            onClick={() => onReject(edit.id)}
            disabled={disabled}
            className="inline-flex min-h-[32px] items-center gap-1 rounded-lg px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
          >
            <IconX size={13} aria-hidden />
            {t('rejectEdit')}
          </button>
        </div>
      )}
    </div>
  );
}
