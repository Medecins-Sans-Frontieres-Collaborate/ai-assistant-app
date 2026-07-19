'use client';

import { IconPlus, IconTrash, IconX } from '@tabler/icons-react';
import { useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  MAX_CRITERION_RUBRIC_CHARS,
  customCriterionId,
} from '@/lib/utils/shared/review/customCriteria';

import { CustomCriterion } from '@/types/workflow';

import { v4 as uuidv4 } from 'uuid';

interface CriteriaManagerProps {
  criteria: readonly CustomCriterion[];
  /** e.g. 'workflows.translation' — provides the manager's strings. */
  i18nNamespace: string;
  onCreate: (criterion: CustomCriterion) => void;
  onUpdate: (id: string, updates: Partial<Omit<CustomCriterion, 'id'>>) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

/**
 * Inline editor for user-defined quality criteria: a name plus a rubric
 * injected verbatim into the workflow's assessment prompt.
 *
 * Shared by the document and translation workflows — the CRUD shape is
 * identical, only the backing list and namespace differ, so the store
 * actions arrive as props rather than being read here.
 *
 * Edits are saved on every keystroke (no save button); the store stamps
 * `updatedAt`.
 */
export function CriteriaManager({
  criteria,
  i18nNamespace,
  onCreate,
  onUpdate,
  onDelete,
  onClose,
}: CriteriaManagerProps) {
  const t = useTranslations(i18nNamespace);

  const [editingId, setEditingId] = useState<string | null>(
    criteria[0]?.id ?? null,
  );
  const editing = criteria.find((c) => c.id === editingId);
  // Not clamped with `maxLength`: a criterion saved before this limit was
  // surfaced would be silently truncated on the next keystroke, destroying
  // text the user never asked to lose. Show the overage and let them cut it.
  const rubricOverBy = editing
    ? editing.rubric.length - MAX_CRITERION_RUBRIC_CHARS
    : 0;

  const handleCreate = () => {
    const now = new Date().toISOString();
    const criterion: CustomCriterion = {
      id: customCriterionId(uuidv4()),
      name: t('newCriterionName'),
      rubric: '',
      createdAt: now,
      updatedAt: now,
    };
    onCreate(criterion);
    setEditingId(criterion.id);
  };

  const inputClass =
    'rounded-lg border border-gray-300 bg-gray-50 px-2 py-1.5 text-sm text-gray-900 placeholder-gray-500 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100 dark:placeholder-gray-400';

  return (
    <div className="flex h-full flex-col border-t border-gray-200 dark:border-gray-700">
      <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t('customCriteria')}
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('closeCriteria')}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
        >
          <IconX size={15} aria-hidden />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="w-44 shrink-0 overflow-y-auto border-e border-gray-200 p-2 dark:border-gray-700">
          {criteria.map((criterion) => (
            <button
              key={criterion.id}
              type="button"
              onClick={() => setEditingId(criterion.id)}
              className={`mb-1 block w-full truncate rounded-md px-2 py-1.5 text-start text-sm ${
                criterion.id === editingId
                  ? 'bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-gray-100'
                  : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-surface-dark-elevated'
              }`}
            >
              {criterion.name}
            </button>
          ))}
          <button
            type="button"
            onClick={handleCreate}
            className="mt-1 inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
          >
            <IconPlus size={14} aria-hidden />
            {t('newCriterion')}
          </button>
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto p-3">
          {editing ? (
            <>
              <div className="mb-2 flex items-center gap-2">
                <input
                  value={editing.name}
                  onChange={(e) =>
                    onUpdate(editing.id, { name: e.target.value })
                  }
                  aria-label={t('criterionName')}
                  className={`${inputClass} flex-1`}
                />
                <button
                  type="button"
                  onClick={() => {
                    onDelete(editing.id);
                    setEditingId(null);
                  }}
                  aria-label={t('deleteCriterion')}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
                >
                  <IconTrash size={15} aria-hidden />
                </button>
              </div>
              <textarea
                value={editing.rubric}
                onChange={(e) =>
                  onUpdate(editing.id, { rubric: e.target.value })
                }
                rows={5}
                placeholder={t('criterionRubricPlaceholder')}
                aria-label={t('criterionRubric')}
                aria-invalid={rubricOverBy > 0}
                className={`${inputClass} w-full resize-y ${
                  rubricOverBy > 0 ? 'border-red-500 dark:border-red-500' : ''
                }`}
              />
              {/* The rubric goes verbatim into every assessment prompt, so the
                  server caps it. Without a visible count an over-long rubric
                  saved fine and then failed each assessment at request time,
                  where the cause was far from the cause. */}
              <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3">
                <p className="max-w-[65ch] text-xs text-gray-500 dark:text-gray-400">
                  {t('criterionRubricHint')}
                </p>
                <span
                  className={`shrink-0 text-xs tabular-nums ${
                    rubricOverBy > 0
                      ? 'font-medium text-red-700 dark:text-red-400'
                      : 'text-gray-400 dark:text-gray-500'
                  }`}
                >
                  {editing.rubric.length} / {MAX_CRITERION_RUBRIC_CHARS}
                </span>
              </div>
              {rubricOverBy > 0 && (
                <p
                  role="alert"
                  className="mt-1 max-w-[65ch] text-xs text-red-700 dark:text-red-400"
                >
                  {t('criterionRubricTooLong', { over: rubricOverBy })}
                </p>
              )}
            </>
          ) : (
            <p className="max-w-[50ch] text-sm text-gray-500 dark:text-gray-400">
              {t('criteriaEmpty')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
