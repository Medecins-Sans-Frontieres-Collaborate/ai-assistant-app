'use client';

import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  FormulaIssue,
  compileFormula,
  formulaToDisplay,
  topoOrderFormulas,
} from '@/lib/services/workflows/data/derived';
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
          ...(c.formula
            ? { formula: formulaToDisplay(c.formula, columns) }
            : {}),
        }))
      : [{ name: '', type: 'text', required: false }],
  );

  const update = (index: number, patch: Partial<SchemaDraftColumn>) =>
    setDraft((prev) =>
      prev.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
    );

  /**
   * Pre-Apply formula validation, mirroring applySchemaChanges's ref
   * resolution: draft names plus open-time names of kept columns (so a
   * same-session rename doesn't spuriously break other formulas), then
   * cycle detection across the draft.
   */
  const formulaIssues = useMemo(() => {
    const issues = new Map<number, FormulaIssue>();
    const entriesWithFormula = draft
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.formula?.trim());
    if (entriesWithFormula.length === 0) return issues;

    const keyByName = new Map<string, string>();
    const addRef = (name: string, key: string) => {
      const ref = name.trim().toLowerCase();
      if (ref && !keyByName.has(ref)) keyByName.set(ref, key);
    };
    draft.forEach((entry, index) => addRef(entry.name, `k${index}`));
    draft.forEach((entry, index) => {
      const original = entry.id
        ? columns.find((c) => c.id === entry.id)
        : undefined;
      if (original) addRef(original.name, `k${index}`);
    });

    const nodes: Array<{ key: string; refs: string[] }> = [];
    for (const { entry, index } of entriesWithFormula) {
      const result = compileFormula(
        entry.formula!,
        (ref) => keyByName.get(ref.trim().toLowerCase()) ?? null,
      );
      if (!result.ok) issues.set(index, result.issue);
      else nodes.push({ key: `k${index}`, refs: result.compiled.refs });
    }
    const { cyclic } = topoOrderFormulas(nodes);
    for (const { index } of entriesWithFormula) {
      if (cyclic.has(`k${index}`) && !issues.has(index)) {
        issues.set(index, { code: 'cycle' });
      }
    }
    return issues;
  }, [draft, columns]);

  const formulaIssueText = (issue: FormulaIssue): string => {
    switch (issue.code) {
      case 'unknownRef':
        return t('schemaFormulaUnknownRef', { ref: issue.detail ?? '' });
      case 'arity':
        return t('schemaFormulaArityError', { fn: issue.detail ?? '' });
      case 'cycle':
        return t('schemaFormulaCycleError');
      default:
        return t('schemaFormulaSyntaxError');
    }
  };

  const canApply =
    draft.length > 0 &&
    draft.every((entry) => entry.name.trim().length > 0) &&
    formulaIssues.size === 0;

  return (
    <div className="border-b border-gray-200 p-3 dark:border-gray-700">
      <p className="mb-2 max-w-[75ch] text-xs text-gray-500 dark:text-gray-400">
        {t('schemaHint')}
      </p>
      <div className="space-y-1.5">
        {draft.map((entry, index) => {
          const isDerived = !!entry.formula?.trim();
          const issue = formulaIssues.get(index);
          return (
            <div key={entry.id ?? `new-${index}`}>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={entry.name}
                  onChange={(e) => update(index, { name: e.target.value })}
                  placeholder={t('schemaFieldName')}
                  aria-label={t('schemaFieldName')}
                  className={`w-56 ${inputClasses}`}
                />
                <select
                  value={isDerived ? 'number' : entry.type}
                  disabled={isDerived}
                  onChange={(e) =>
                    update(index, { type: e.target.value as DataColumnType })
                  }
                  aria-label={t('schemaFieldType')}
                  className={`${inputClasses} disabled:opacity-50`}
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
                    checked={entry.required && !isDerived}
                    disabled={isDerived}
                    onChange={(e) =>
                      update(index, { required: e.target.checked })
                    }
                  />
                  {t('schemaRequired')}
                </label>
                <label className="flex min-w-64 flex-1 items-center gap-1.5">
                  <span
                    className="text-xs italic text-gray-500 dark:text-gray-400"
                    title={t('schemaFormulaHint')}
                  >
                    ƒx
                  </span>
                  <input
                    type="text"
                    value={entry.formula ?? ''}
                    onChange={(e) => update(index, { formula: e.target.value })}
                    placeholder={t('schemaFormulaPlaceholder')}
                    aria-label={t('schemaFormula')}
                    className={`flex-1 ${inputClasses} ${
                      issue ? 'border-red-400 dark:border-red-700' : ''
                    }`}
                  />
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
              {issue && (
                <p className="mt-0.5 text-xs text-red-700 dark:text-red-400">
                  {formulaIssueText(issue)}
                </p>
              )}
            </div>
          );
        })}
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
