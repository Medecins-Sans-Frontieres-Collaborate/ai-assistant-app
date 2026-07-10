'use client';

import { IconCheck, IconX } from '@tabler/icons-react';

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
  disabled,
}: EditSuggestionCardProps) {
  const t = useTranslations(i18nNamespace);
  const resolved = edit.status !== 'pending';

  return (
    <div
      className={`rounded-lg border border-gray-200 p-2.5 dark:border-gray-700 ${
        resolved ? 'opacity-60' : ''
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
