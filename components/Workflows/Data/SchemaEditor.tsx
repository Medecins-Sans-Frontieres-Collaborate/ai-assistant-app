'use client';

import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';

import { useTranslations } from 'next-intl';

import { SchemaDraftColumn } from '@/lib/services/workflows/data/schemaEdit';

import { DataColumn, DataColumnType } from '@/types/workflow';

interface SchemaEditorProps {
  columns: DataColumn[];
  onApply: (draft: SchemaDraftColumn[]) => void;
  onClose: () => void;
  disabled?: boolean;
}

const COLUMN_TYPES: DataColumnType[] = ['text', 'number', 'date', 'boolean'];

const inputClasses =
  'min-h-[32px] rounded-lg border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark dark:text-gray-100';

/**
 * Inline structure editor (schema-first ingestion): define or reshape
 * the table's columns — name, type, required — before or after data
 * exists. Edits are drafted locally and applied atomically; retyping
 * re-coerces cells (non-conforming become null; single-level undo
 * covers mistakes).
 */
export function SchemaEditor({
  columns,
  onApply,
  onClose,
  disabled,
}: SchemaEditorProps) {
  const t = useTranslations('workflows.data');
  const [draft, setDraft] = useState<SchemaDraftColumn[]>(() =>
    columns.length > 0
      ? columns.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          required: c.required === true,
        }))
      : [{ name: '', type: 'text', required: false }],
  );

  const update = (index: number, patch: Partial<SchemaDraftColumn>) =>
    setDraft((prev) =>
      prev.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
    );

  const canApply =
    draft.length > 0 && draft.every((entry) => entry.name.trim().length > 0);

  return (
    <div className="border-b border-gray-200 p-3 dark:border-gray-700">
      <p className="mb-2 max-w-[75ch] text-xs text-gray-500 dark:text-gray-400">
        {t('schemaHint')}
      </p>
      <div className="space-y-1.5">
        {draft.map((entry, index) => (
          <div
            key={entry.id ?? `new-${index}`}
            className="flex flex-wrap items-center gap-2"
          >
            <input
              type="text"
              value={entry.name}
              onChange={(e) => update(index, { name: e.target.value })}
              placeholder={t('schemaFieldName')}
              aria-label={t('schemaFieldName')}
              className={`w-56 ${inputClasses}`}
            />
            <select
              value={entry.type}
              onChange={(e) =>
                update(index, { type: e.target.value as DataColumnType })
              }
              aria-label={t('schemaFieldType')}
              className={inputClasses}
            >
              {COLUMN_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
            <label className="inline-flex min-h-[32px] cursor-pointer items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300">
              <input
                type="checkbox"
                checked={entry.required}
                onChange={(e) => update(index, { required: e.target.checked })}
              />
              {t('schemaRequired')}
            </label>
            <button
              type="button"
              onClick={() =>
                setDraft((prev) => prev.filter((_, i) => i !== index))
              }
              aria-label={t('schemaDeleteField', { field: entry.name })}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-400"
            >
              <IconTrash size={15} aria-hidden />
            </button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() =>
            setDraft((prev) => [
              ...prev,
              { name: '', type: 'text', required: false },
            ])
          }
          className="inline-flex min-h-[32px] items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
        >
          <IconPlus size={13} aria-hidden />
          {t('schemaAddField')}
        </button>
        <div className="ms-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[32px] rounded-lg px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
          >
            {t('schemaCancel')}
          </button>
          <button
            type="button"
            onClick={() => onApply(draft)}
            disabled={disabled || !canApply}
            className="min-h-[32px] rounded-lg bg-gray-300 px-3 py-1 text-xs font-medium text-gray-900 hover:bg-gray-400 disabled:opacity-30 dark:bg-surface-dark-base dark:text-white dark:hover:bg-surface-dark-elevated"
          >
            {t('schemaApply')}
          </button>
        </div>
      </div>
    </div>
  );
}
