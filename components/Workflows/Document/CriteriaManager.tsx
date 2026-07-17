'use client';

import { IconPlus, IconTrash, IconX } from '@tabler/icons-react';
import { useState } from 'react';

import { useTranslations } from 'next-intl';

import { DocumentCustomCriterion } from '@/types/workflow';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { v4 as uuidv4 } from 'uuid';

interface CriteriaManagerProps {
  onClose: () => void;
}

/**
 * Inline editor for user-defined document quality criteria (e.g. "brand
 * considerations", "organizational language"): a name plus a rubric that
 * is injected into assessment and revision prompts verbatim.
 */
export function CriteriaManager({ onClose }: CriteriaManagerProps) {
  const t = useTranslations('workflows.document');
  const criteria = useSettingsStore((s) => s.documentCriteria);
  const addDocumentCriterion = useSettingsStore((s) => s.addDocumentCriterion);
  const updateDocumentCriterion = useSettingsStore(
    (s) => s.updateDocumentCriterion,
  );
  const deleteDocumentCriterion = useSettingsStore(
    (s) => s.deleteDocumentCriterion,
  );

  const [editingId, setEditingId] = useState<string | null>(
    criteria[0]?.id ?? null,
  );
  const editing = criteria.find((c) => c.id === editingId);

  const handleCreate = () => {
    const criterion: DocumentCustomCriterion = {
      id: `custom:${uuidv4()}`,
      name: t('newCriterionName'),
      rubric: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    addDocumentCriterion(criterion);
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
                    updateDocumentCriterion(editing.id, {
                      name: e.target.value,
                    })
                  }
                  aria-label={t('criterionName')}
                  className={`${inputClass} flex-1`}
                />
                <button
                  type="button"
                  onClick={() => {
                    deleteDocumentCriterion(editing.id);
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
                  updateDocumentCriterion(editing.id, {
                    rubric: e.target.value,
                  })
                }
                rows={5}
                placeholder={t('criterionRubricPlaceholder')}
                aria-label={t('criterionRubric')}
                className={`${inputClass} w-full resize-y`}
              />
              <p className="mt-1 max-w-[65ch] text-xs text-gray-500 dark:text-gray-400">
                {t('criterionRubricHint')}
              </p>
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
