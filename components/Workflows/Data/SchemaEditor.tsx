'use client';

import {
  IconDeviceFloppy,
  IconLibrary,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  FormulaIssue,
  compileFormula,
  formulaToDisplay,
  topoOrderFormulas,
} from '@/lib/services/workflows/data/derived';
import {
  SchemaDraftColumn,
  applySchemaChanges,
} from '@/lib/services/workflows/data/schemaEdit';
import {
  columnsToStructure,
  structureToColumns,
} from '@/lib/services/workflows/data/structureAdapters';
import { MAX_COLUMNS } from '@/lib/services/workflows/data/tableUtils';

import { DataColumn, DataColumnType } from '@/types/workflow';

import { useSettingsStore } from '@/client/stores/settingsStore';

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
  const tStructures = useTranslations('structures');
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

  /* ---------------- saved structures ---------------- */

  const savedStructures = useSettingsStore((s) => s.savedStructures);
  const addSavedStructure = useSettingsStore((s) => s.addSavedStructure);
  const [picking, setPicking] = useState(false);
  const [saveName, setSaveName] = useState<string | null>(null);
  /** Lossy-conversion messages from the last load/save, shown inline. */
  const [notices, setNotices] = useState<string[]>([]);

  const handleLoad = (structureId: string) => {
    const structure = savedStructures.find((s) => s.id === structureId);
    if (!structure) return;
    const {
      columns: loaded,
      downgraded,
      truncated,
    } = structureToColumns(structure);

    // Ids are regenerated from the structure, so nothing matches the current
    // table by id — applySchemaChanges will treat every entry as new. That is
    // the intent: loading a structure replaces the shape.
    setDraft(
      loaded.map((column) => ({
        name: column.name,
        type: column.type,
        required: column.required === true,
      })),
    );

    const next: string[] = [];
    if (downgraded.length > 0) {
      next.push(
        tStructures('downgradedNotice', {
          count: downgraded.length,
          names: downgraded.join(', '),
        }),
      );
    }
    if (truncated.length > 0) {
      next.push(
        tStructures('truncatedNotice', {
          count: truncated.length,
          max: MAX_COLUMNS,
          names: truncated.join(', '),
        }),
      );
    }
    setNotices(next);
    setPicking(false);
  };

  const handleSave = () => {
    const name = (saveName ?? '').trim();
    if (!name || !canApply) return;
    // Run the draft through the real apply path (with no rows) so ids are
    // assigned and formulas canonicalised exactly as they would be on Apply
    // — the structure then reflects what the user is actually looking at,
    // not the pre-edit table.
    const { columns: resolved } = applySchemaChanges(columns, [], draft);
    const now = new Date().toISOString();
    const { structure, skipped } = columnsToStructure(resolved, {
      id: `structure_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      now,
    });
    addSavedStructure(structure);

    const next = [tStructures('savedToast', { name })];
    if (skipped.length > 0) {
      next.push(
        tStructures('skippedDerivedNotice', {
          count: skipped.length,
          names: skipped.join(', '),
        }),
      );
    }
    setNotices(next);
    setSaveName(null);
  };

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

        <button
          type="button"
          onClick={() => {
            setPicking((prev) => !prev);
            setSaveName(null);
          }}
          disabled={savedStructures.length === 0}
          title={
            savedStructures.length === 0
              ? tStructures('pickerEmpty')
              : tStructures('loadFromStructureTitle')
          }
          className="inline-flex min-h-[32px] items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
        >
          <IconLibrary size={13} aria-hidden />
          {tStructures('loadFromStructure')}
        </button>

        <button
          type="button"
          onClick={() => {
            setSaveName((prev) => (prev === null ? '' : null));
            setPicking(false);
          }}
          disabled={!canApply}
          title={tStructures('saveAsStructureTitle')}
          className="inline-flex min-h-[32px] items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
        >
          <IconDeviceFloppy size={13} aria-hidden />
          {tStructures('saveAsStructure')}
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

      {picking && (
        <div
          role="listbox"
          aria-label={tStructures('pickerTitle')}
          className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-gray-200 p-1 dark:border-gray-700"
        >
          <p className="px-2 py-1 text-xs text-gray-500 dark:text-gray-400">
            {tStructures('loadReplacesColumns')}
          </p>
          {savedStructures.map((structure) => (
            <button
              key={structure.id}
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => handleLoad(structure.id)}
              className="flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-start text-sm text-gray-800 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-surface-dark-elevated"
            >
              <span className="truncate">{structure.name}</span>
              <span className="ms-auto flex-shrink-0 text-xs text-gray-500 dark:text-gray-400">
                {structure.fields.length === 1
                  ? tStructures('fieldCountOne')
                  : tStructures('fieldCount', {
                      count: structure.fields.length,
                    })}
              </span>
            </button>
          ))}
        </div>
      )}

      {saveName !== null && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSave();
          }}
          className="mt-2 flex items-center gap-2"
        >
          <input
            type="text"
            autoFocus
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder={tStructures('namePlaceholder')}
            aria-label={tStructures('namePlaceholder')}
            className={`w-64 ${inputClasses}`}
          />
          <button
            type="submit"
            disabled={saveName.trim().length === 0}
            className="min-h-[32px] rounded-lg bg-gray-300 px-3 py-1 text-xs font-medium text-gray-900 hover:bg-gray-400 disabled:opacity-30 dark:bg-surface-dark-base dark:text-white dark:hover:bg-surface-dark-elevated"
          >
            {tStructures('saveAsStructure')}
          </button>
          <button
            type="button"
            onClick={() => setSaveName(null)}
            className="min-h-[32px] rounded-lg px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
          >
            {t('schemaCancel')}
          </button>
        </form>
      )}

      {notices.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {notices.map((notice) => (
            <li
              key={notice}
              className="max-w-[75ch] text-xs text-amber-700 dark:text-amber-500"
            >
              {notice}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
