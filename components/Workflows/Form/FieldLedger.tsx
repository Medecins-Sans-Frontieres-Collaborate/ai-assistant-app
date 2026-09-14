'use client';

import { IconLock } from '@tabler/icons-react';
import { useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import { fieldStatus } from '@/lib/services/workflows/form/status';
import { formatValue } from '@/lib/services/workflows/form/validation';

import { FillStatus, FormDocument } from '@/types/formFill';

interface FieldLedgerProps {
  document: FormDocument;
  selectedFieldId: string | null;
  onSelect: (fieldId: string) => void;
  /** Pending proposal count per field (amber dot). */
  pendingByField: Map<string, number>;
}

type Filter = 'all' | 'open' | 'partial' | 'filled';

export function statusPillClass(status: FillStatus): string {
  switch (status) {
    case 'filled':
      return 'bg-green-100 text-green-900 dark:bg-green-900/30 dark:text-green-200';
    case 'confirmed':
      return 'bg-blue-100 text-blue-900 dark:bg-blue-900/30 dark:text-blue-200';
    case 'partial':
      return 'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200';
    case 'not_applicable':
      return 'bg-gray-100 text-gray-600 dark:bg-surface-dark-elevated dark:text-gray-400';
    default:
      return 'bg-red-100 text-red-900 dark:bg-red-900/30 dark:text-red-200';
  }
}

/**
 * The ledger: every field grouped by section with its derived status, a
 * one-line value preview and the gap text for partials. Selecting a row
 * opens the field detail; editing never happens inline here so there is
 * one write path.
 */
export function FieldLedger({
  document,
  selectedFieldId,
  onSelect,
  pendingByField,
}: FieldLedgerProps) {
  const t = useTranslations('workflows.form');
  const [filter, setFilter] = useState<Filter>('all');

  const rows = useMemo(
    () =>
      document.template.fields.map((field) => {
        const fill = document.fields[field.id];
        const result = fieldStatus(field, fill);
        return { field, fill, ...result };
      }),
    [document],
  );

  const visible = rows.filter((row) => {
    switch (filter) {
      case 'open':
        return row.status === 'empty' || row.status === 'partial';
      case 'partial':
        return row.status === 'partial';
      case 'filled':
        return row.status === 'filled' || row.status === 'confirmed';
      default:
        return true;
    }
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-gray-200 px-3 py-1.5 dark:border-gray-700">
        <span className="me-auto text-xs font-semibold text-gray-900 dark:text-gray-100">
          {t('ledger')}
        </span>
        {(['all', 'open', 'partial', 'filled'] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            aria-pressed={filter === f}
            className={`rounded px-1.5 py-0.5 text-[11px] ${
              filter === f
                ? 'bg-gray-200 text-gray-900 dark:bg-surface-dark-elevated dark:text-gray-100'
                : 'text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'
            }`}
          >
            {t(`filter.${f}`)}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {document.template.sections.map((section) => {
          const sectionRows = visible.filter(
            (r) => r.field.sectionId === section.id,
          );
          if (sectionRows.length === 0) return null;
          return (
            <div key={section.id}>
              <div className="sticky top-0 bg-gray-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:bg-surface-dark-recessed dark:text-gray-400">
                {section.heading}
              </div>
              <ul>
                {sectionRows.map(({ field, fill, status, issues }) => {
                  const selected = field.id === selectedFieldId;
                  const pending = pendingByField.get(field.id) ?? 0;
                  const preview =
                    status === 'empty' || status === 'not_applicable'
                      ? ''
                      : formatValue(fill?.value).replace(/\s+/g, ' ');
                  return (
                    <li key={field.id}>
                      <button
                        type="button"
                        onClick={() => onSelect(field.id)}
                        aria-current={selected ? 'true' : undefined}
                        className={`flex w-full flex-col gap-0.5 border-b border-gray-100 px-3 py-2 text-start hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-surface-dark-elevated ${
                          selected ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                        }`}
                      >
                        <span className="flex items-center gap-1.5">
                          <span className="min-w-0 flex-1 truncate text-sm text-gray-900 dark:text-gray-100">
                            {field.label}
                            {field.required && (
                              <span className="ms-0.5 text-red-600" aria-hidden>
                                *
                              </span>
                            )}
                          </span>
                          {field.admin?.locked && (
                            <IconLock
                              size={12}
                              aria-label={t('locked')}
                              className="shrink-0 text-gray-400"
                            />
                          )}
                          {pending > 0 && (
                            <span
                              className="h-2 w-2 shrink-0 rounded-full bg-amber-500"
                              aria-label={t('pendingCount', {
                                count: String(pending),
                              })}
                            />
                          )}
                          <span
                            className={`shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-medium ${statusPillClass(status)}`}
                          >
                            {t(`status.${status}`)}
                          </span>
                        </span>
                        {preview && (
                          <span className="truncate text-xs text-gray-600 dark:text-gray-400">
                            {preview}
                          </span>
                        )}
                        {status === 'partial' &&
                          (fill?.gaps || issues.length > 0) && (
                            <span className="truncate text-[11px] text-amber-700 dark:text-amber-400">
                              {fill?.gaps ??
                                issues
                                  .map((i) =>
                                    t(`issue.${i.code}`, i.params ?? {}),
                                  )
                                  .join('; ')}
                            </span>
                          )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
