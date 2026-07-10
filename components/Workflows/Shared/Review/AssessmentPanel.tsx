'use client';

import { IconX } from '@tabler/icons-react';

import { useTranslations } from 'next-intl';

import { ReviewCriterionRating, ReviewEdit } from '@/types/workflow';

import { EditSuggestionCard } from './EditSuggestionCard';

export interface ReviewAssessment {
  criteria: ReviewCriterionRating[];
  overallSummary: string;
  edits: ReviewEdit[];
}

interface AssessmentPanelProps {
  assessment: ReviewAssessment;
  resolveCriterionLabel: (id: string) => string;
  /** e.g. 'workflows.document' — provides the review-chrome strings. */
  i18nNamespace: string;
  /** Scope badge (e.g. "Selection") when not the whole text. */
  scopeLabel?: string;
  /** Per-edit location line (e.g. "row 3f · Amount") for non-text targets. */
  getEditLocationLabel?: (edit: ReviewEdit) => string | undefined;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  onClose: () => void;
  disabled?: boolean;
}

/** Rating pill color ramp: 1 red → 5 green (paired with the number). */
function ratingClasses(rating: number): string {
  if (rating <= 2) {
    return 'bg-red-100 text-red-900 dark:bg-red-900/30 dark:text-red-200';
  }
  if (rating === 3) {
    return 'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200';
  }
  return 'bg-green-100 text-green-900 dark:bg-green-900/30 dark:text-green-200';
}

/**
 * The quality-review column, shared by the translation and document
 * workflows: criterion ratings up top, then the suggested-edit queue.
 * Rendered as a dedicated pane BESIDE the working text (not in a bottom
 * paper-trail strip) because pending edits are an actionable work queue
 * the user must see and resolve, not history. Resolved edits stay
 * visible (greyed) as the decision record.
 */
export function AssessmentPanel({
  assessment,
  resolveCriterionLabel,
  i18nNamespace,
  scopeLabel,
  getEditLocationLabel,
  onAccept,
  onReject,
  onAcceptAll,
  onRejectAll,
  onClose,
  disabled,
}: AssessmentPanelProps) {
  const t = useTranslations(i18nNamespace);
  const pendingCount = assessment.edits.filter(
    (e) => e.status === 'pending',
  ).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t('assessmentTitle')}
        </h3>
        {scopeLabel && (
          <span className="rounded-sm bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-900 dark:bg-blue-900/30 dark:text-blue-200">
            {scopeLabel}
          </span>
        )}
        {pendingCount > 0 && (
          <span className="rounded-sm bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">
            {t('pendingCount', { count: String(pendingCount) })}
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label={t('closeReview')}
          className="ms-auto flex h-7 w-7 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
        >
          <IconX size={15} aria-hidden />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Ratings */}
        <div className="border-b border-gray-100 px-3 py-2.5 dark:border-gray-800">
          <div className="flex flex-wrap gap-1.5">
            {assessment.criteria.map((criterion) => (
              <span
                key={criterion.criterionId}
                title={criterion.summary}
                className={`inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] font-medium ${ratingClasses(criterion.rating)}`}
              >
                {resolveCriterionLabel(criterion.criterionId)}
                <span className="tabular-nums">
                  {t('ratingOf', { rating: String(criterion.rating) })}
                </span>
              </span>
            ))}
          </div>
          {assessment.overallSummary && (
            <p className="mt-1.5 text-sm text-gray-700 dark:text-gray-300">
              {assessment.overallSummary}
            </p>
          )}
        </div>

        {/* Edit queue */}
        {assessment.edits.length === 0 ? (
          <p className="px-3 py-3 text-sm text-gray-500 dark:text-gray-400">
            {t('noEditsSuggested')}
          </p>
        ) : (
          <div className="px-3 py-2.5">
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                {t('suggestedEdits')}
              </h4>
              {pendingCount > 1 && (
                <>
                  <button
                    type="button"
                    onClick={onAcceptAll}
                    disabled={disabled}
                    className="min-h-[28px] rounded-lg px-2 py-0.5 text-xs text-gray-600 underline-offset-2 hover:underline disabled:opacity-40 dark:text-gray-400"
                  >
                    {t('acceptAll')}
                  </button>
                  <button
                    type="button"
                    onClick={onRejectAll}
                    disabled={disabled}
                    className="min-h-[28px] rounded-lg px-2 py-0.5 text-xs text-gray-600 underline-offset-2 hover:underline disabled:opacity-40 dark:text-gray-400"
                  >
                    {t('rejectAll')}
                  </button>
                </>
              )}
            </div>
            <div className="space-y-2">
              {/* Pending first: the actionable queue leads, the record follows. */}
              {[...assessment.edits]
                .sort(
                  (a, b) =>
                    Number(a.status !== 'pending') -
                    Number(b.status !== 'pending'),
                )
                .map((edit) => (
                  <EditSuggestionCard
                    key={edit.id}
                    edit={edit}
                    resolveCriterionLabel={resolveCriterionLabel}
                    i18nNamespace={i18nNamespace}
                    locationLabel={getEditLocationLabel?.(edit)}
                    onAccept={onAccept}
                    onReject={onReject}
                    disabled={disabled}
                  />
                ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
