'use client';

import { IconCheck, IconCopy } from '@tabler/icons-react';
import { useState } from 'react';

import { useTranslations } from 'next-intl';

import { fieldStatus } from '@/lib/services/workflows/form/status';
import { formatValue } from '@/lib/services/workflows/form/validation';

import { FormDocument } from '@/types/formFill';

import { statusPillClass } from './FieldLedger';

interface CopyViewProps {
  document: FormDocument;
  onSelectField: (fieldId: string) => void;
}

/**
 * For forms the app cannot reach (a web form in another tab): every field
 * with its value, a copy button, and a local "pasted" tick. The tick is a
 * per-session checklist, not a ledger status — the ledger records what is
 * filled, this records what the user has moved across.
 */
export function CopyView({ document, onSelectField }: CopyViewProps) {
  const t = useTranslations('workflows.form');
  const [copied, setCopied] = useState<string | null>(null);
  const [pasted, setPasted] = useState<Set<string>>(new Set());

  const copy = async (fieldId: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(fieldId);
      setTimeout(() => setCopied((c) => (c === fieldId ? null : c)), 1_500);
    } catch {
      // Clipboard denied: the value is visible and selectable anyway.
    }
  };

  return (
    <div className="h-full overflow-y-auto px-4 py-3">
      <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
        {t('copyViewHint')}
      </p>
      {document.template.sections.map((section) => {
        const fields = document.template.fields.filter(
          (f) => f.sectionId === section.id,
        );
        if (fields.length === 0) return null;
        return (
          <div key={section.id} className="mb-4">
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              {section.heading}
            </h3>
            <ul className="space-y-1.5">
              {fields.map((field) => {
                const fill = document.fields[field.id];
                const { status } = fieldStatus(field, fill);
                const text =
                  status === 'not_applicable'
                    ? 'N/A'
                    : status === 'empty'
                      ? ''
                      : formatValue(fill?.value);
                const done = pasted.has(field.id);
                return (
                  <li
                    key={field.id}
                    className={`flex items-start gap-2 rounded-lg border px-2.5 py-2 ${
                      done
                        ? 'border-green-200 bg-green-50/50 dark:border-green-900/40 dark:bg-green-900/10'
                        : 'border-gray-200 dark:border-gray-700'
                    }`}
                  >
                    <label className="mt-0.5 flex shrink-0 items-center">
                      <input
                        type="checkbox"
                        checked={done}
                        onChange={(e) => {
                          const next = new Set(pasted);
                          if (e.target.checked) next.add(field.id);
                          else next.delete(field.id);
                          setPasted(next);
                        }}
                        aria-label={t('pasted')}
                        className="h-4 w-4"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => onSelectField(field.id)}
                      className="min-w-0 flex-1 text-start"
                    >
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-xs font-medium text-gray-900 dark:text-gray-100">
                          {field.label}
                        </span>
                        <span
                          className={`shrink-0 rounded-sm px-1 py-0.5 text-[10px] ${statusPillClass(status)}`}
                        >
                          {t(`status.${status}`)}
                        </span>
                      </span>
                      <span className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-xs text-gray-700 dark:text-gray-300">
                        {text || '—'}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => copy(field.id, text)}
                      disabled={!text}
                      aria-label={t('copy')}
                      className="shrink-0 rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
                    >
                      {copied === field.id ? (
                        <IconCheck
                          size={15}
                          aria-hidden
                          className="text-green-600"
                        />
                      ) : (
                        <IconCopy size={15} aria-hidden />
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
  );
}
