'use client';

import { IconLock, IconSparkles, IconX } from '@tabler/icons-react';
import { useState } from 'react';

import { useTranslations } from 'next-intl';

import { fieldStatus, isLocked } from '@/lib/services/workflows/form/status';
import {
  coerceInput,
  formatValue,
  isListType,
} from '@/lib/services/workflows/form/validation';

import { FieldValue, FillSourceRecord, FormDocument } from '@/types/formFill';

import { statusPillClass } from './FieldLedger';

interface FieldDetailProps {
  document: FormDocument;
  fieldId: string;
  sources: FillSourceRecord[];
  busy: boolean;
  onSetValue: (fieldId: string, value: FieldValue) => void;
  onConfirm: (fieldId: string) => void;
  onUnlock: (fieldId: string) => void;
  onNotApplicable: (fieldId: string, on: boolean) => void;
  onFillField: (fieldId: string) => void;
  onClose: () => void;
}

const inputClass =
  'w-full rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-900 focus:border-blue-600 focus:outline-none disabled:opacity-60 dark:border-gray-700 dark:bg-surface-dark dark:text-gray-100';
const actionClass =
  'inline-flex min-h-[32px] items-center gap-1 rounded-lg px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-300 dark:hover:bg-surface-dark-elevated';

/**
 * One field: editable value (type-aware), validation issues, gaps,
 * provenance, confidence and the decisions (confirm / unlock / N/A /
 * re-fill). Editing here confirms the field — the user's word outranks a
 * proposal, and a confirmed field is never overwritten by a fill run.
 */
export function FieldDetail({
  document,
  fieldId,
  sources,
  busy,
  onSetValue,
  onConfirm,
  onUnlock,
  onNotApplicable,
  onFillField,
  onClose,
}: FieldDetailProps) {
  const t = useTranslations('workflows.form');
  const field = document.template.fields.find((f) => f.id === fieldId);
  const fill = field ? document.fields[field.id] : undefined;
  // Reset the draft when the field or its stored value changes — done
  // during render (the React "adjust state on prop change" pattern), not
  // in an effect, so there is no extra render with a stale draft.
  const externalValue = formatValue(fill?.value);
  const resetKey = `${fieldId}\u0000${externalValue}`;
  const [draft, setDraft] = useState(externalValue);
  const [lastResetKey, setLastResetKey] = useState(resetKey);
  if (resetKey !== lastResetKey) {
    setLastResetKey(resetKey);
    setDraft(externalValue);
  }

  if (!field) return null;
  const { status, issues, partialReasons } = fieldStatus(field, fill);
  const locked = isLocked(field);
  const section = document.template.sections.find(
    (s) => s.id === field.sectionId,
  );
  const dirty = draft !== formatValue(fill?.value);
  const disabled = busy || locked || status === 'not_applicable';

  const commit = () => {
    if (!dirty) return;
    onSetValue(field.id, coerceInput(field, draft));
  };

  const enumValues = field.validation?.enumValues;
  const multiline =
    field.type === 'longtext' || isListType(field.type) || draft.includes('\n');

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-700">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
            {field.label}
            {field.required && (
              <span className="ms-0.5 text-red-600" aria-hidden>
                *
              </span>
            )}
          </h3>
          <p className="truncate text-[11px] text-gray-500 dark:text-gray-400">
            {section?.heading} · {t(`types.${field.type}`)}
          </p>
        </div>
        <span
          className={`rounded-sm px-1.5 py-0.5 text-[10px] font-medium ${statusPillClass(status)}`}
        >
          {t(`status.${status}`)}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('closeReview')}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
        >
          <IconX size={15} aria-hidden />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {field.description && (
          <p className="text-xs text-gray-600 dark:text-gray-400">
            {field.description}
          </p>
        )}
        {field.validation?.rubric && (
          <p className="text-xs text-gray-600 dark:text-gray-400">
            <span className="font-medium">{t('fieldRubric')}:</span>{' '}
            {field.validation.rubric}
          </p>
        )}
        {locked && (
          <p className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
            <IconLock size={12} aria-hidden /> {t('locked')}
          </p>
        )}

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">
            {t('value')}
          </span>
          {field.type === 'boolean' ? (
            <select
              value={
                draft === ''
                  ? ''
                  : draft.toLowerCase() === 'yes' || draft === 'true'
                    ? 'yes'
                    : 'no'
              }
              disabled={disabled}
              onChange={(e) => {
                setDraft(
                  e.target.value === ''
                    ? ''
                    : e.target.value === 'yes'
                      ? 'Yes'
                      : 'No',
                );
                onSetValue(
                  field.id,
                  e.target.value === '' ? null : e.target.value === 'yes',
                );
              }}
              className={inputClass}
            >
              <option value="">—</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          ) : enumValues && enumValues.length > 0 && !isListType(field.type) ? (
            <select
              value={draft}
              disabled={disabled}
              onChange={(e) => {
                setDraft(e.target.value);
                onSetValue(
                  field.id,
                  e.target.value === '' ? null : e.target.value,
                );
              }}
              className={inputClass}
            >
              <option value="">—</option>
              {enumValues.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          ) : multiline ? (
            <textarea
              value={draft}
              rows={field.type === 'longtext' ? 8 : 4}
              disabled={disabled}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              className={inputClass}
            />
          ) : (
            <input
              type={
                field.type === 'date'
                  ? 'date'
                  : field.type === 'number'
                    ? 'number'
                    : 'text'
              }
              value={draft}
              disabled={disabled}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commit();
                }
              }}
              className={inputClass}
            />
          )}
        </label>

        {issues.length > 0 && (
          <div className="text-xs text-red-700 dark:text-red-400">
            <span className="font-medium">{t('issues')}:</span>{' '}
            {issues.map((i) => t(`issue.${i.code}`, i.params ?? {})).join('; ')}
          </div>
        )}
        {fill?.rubric && status !== 'empty' && (
          <div
            className={`text-xs ${fill.rubric.ok ? 'text-green-700 dark:text-green-400' : 'text-amber-700 dark:text-amber-400'}`}
          >
            <span className="font-medium">
              {fill.rubric.ok ? t('rubricOk') : t('rubricFailed')}
            </span>
            {fill.rubric.note ? `: ${fill.rubric.note}` : ''}
          </div>
        )}
        {fill?.gaps && (
          <div className="text-xs text-amber-700 dark:text-amber-400">
            <span className="font-medium">{t('gaps')}:</span> {fill.gaps}
          </div>
        )}
        {fill?.confidence && status !== 'empty' && (
          <div className="text-xs text-gray-600 dark:text-gray-400">
            <span className="font-medium">{t('confidence')}:</span>{' '}
            {t(`confidenceLevel.${fill.confidence}`)}
          </div>
        )}

        {status !== 'empty' && status !== 'not_applicable' && !locked && (
          <div>
            <p className="mb-1 text-xs font-medium text-gray-700 dark:text-gray-300">
              {t('provenance')}
            </p>
            {fill && fill.provenance.length > 0 ? (
              <ul className="space-y-1.5">
                {fill.provenance.map((p, index) => {
                  const source = sources.find((s) => s.id === p.sourceId);
                  return (
                    <li
                      key={`${p.sourceId}-${index}`}
                      className="rounded border border-gray-200 bg-gray-50 px-2 py-1.5 text-xs dark:border-gray-700 dark:bg-surface-dark-elevated"
                    >
                      <span className="block truncate font-medium text-gray-700 dark:text-gray-300">
                        {source?.name ?? p.sourceId}
                      </span>
                      <span className="text-gray-600 dark:text-gray-400">
                        “{p.excerpt}”
                      </span>
                      {p.verified !== undefined && (
                        <span
                          className={`mt-0.5 block text-[11px] ${
                            p.verified
                              ? 'text-green-800 dark:text-green-300'
                              : 'text-amber-800 dark:text-amber-300'
                          }`}
                        >
                          {p.verified ? '✓ ' : '⚠ '}
                          {p.verified
                            ? t('excerptFound')
                            : t('excerptNotFound')}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {fill?.generalKnowledge
                  ? t('generalKnowledge')
                  : t('noProvenance')}
              </p>
            )}
            {partialReasons.includes('unsourced') && (
              <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
                {t('partialReason.unsourced')}
              </p>
            )}
          </div>
        )}
      </div>

      {!locked && (
        <div className="flex flex-wrap items-center gap-1 border-t border-gray-200 px-3 py-2 dark:border-gray-700">
          {status === 'confirmed' ? (
            <button
              type="button"
              onClick={() => onUnlock(field.id)}
              disabled={busy}
              className={actionClass}
            >
              {t('unlock')}
            </button>
          ) : (
            status !== 'empty' &&
            status !== 'not_applicable' && (
              <button
                type="button"
                onClick={() => onConfirm(field.id)}
                disabled={busy}
                className={actionClass}
              >
                {t('confirm')}
              </button>
            )
          )}
          <button
            type="button"
            onClick={() =>
              onNotApplicable(field.id, status !== 'not_applicable')
            }
            disabled={busy}
            className={actionClass}
          >
            {status === 'not_applicable' ? t('unmarkNa') : t('markNa')}
          </button>
          {status !== 'confirmed' && status !== 'not_applicable' && (
            <button
              type="button"
              onClick={() => onFillField(field.id)}
              disabled={busy}
              className={`${actionClass} ms-auto text-blue-700 dark:text-blue-300`}
            >
              <IconSparkles size={13} aria-hidden />
              {t('fillField')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
