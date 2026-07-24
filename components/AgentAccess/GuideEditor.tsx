'use client';

import { FC, useId, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import {
  MAX_GUIDE_BODY_CHARS,
  MAX_GUIDE_NAME_CHARS,
} from '@/lib/utils/shared/review/guideCriteria';

import { ChipListInput } from './ChipListInput';
import { AdminStoredGuide } from './types';

interface GuideEditorProps {
  /** null = create (POST); otherwise edit (PUT with If-Match). */
  existing: AdminStoredGuide | null;
  onSaved: () => void;
  onCancel: () => void;
  /** 409 conflict acknowledged — parent refetches and closes. */
  onConflictReload: () => void;
}

type GuideKind = 'style' | 'terminology' | 'compliance' | 'structure' | 'tone';

const GUIDE_KINDS: GuideKind[] = [
  'style',
  'terminology',
  'compliance',
  'structure',
  'tone',
];

/** The kinds pinned to the document workflow (spec/tone slot fillers). */
const DOCUMENT_ONLY_KINDS: ReadonlySet<GuideKind> = new Set([
  'structure',
  'tone',
]);

/**
 * Inline create/edit card for one admin-authored workflow guide. Follows the
 * ConnectorEditor idiom: bordered card, Cancel/Save footer, 409 → conflict
 * banner + reload, remounted by the parent on etag change.
 *
 * The body is the point of the feature — a long-form prompt beyond the
 * custom-criterion cap — so the textarea is deliberately large and the
 * counter is informational until the (generous) storage cap is exceeded.
 */
export const GuideEditor: FC<GuideEditorProps> = ({
  existing,
  onSaved,
  onCancel,
  onConflictReload,
}) => {
  const t = useTranslations('agentAccess');

  const [name, setName] = useState(existing?.guide.name ?? '');
  const [description, setDescription] = useState(
    existing?.guide.description ?? '',
  );
  const [kind, setKind] = useState<GuideKind>(existing?.guide.kind ?? 'style');
  const [workflows, setWorkflows] = useState<Array<'document' | 'translation'>>(
    existing?.guide.workflows ?? ['document'],
  );
  const [languages, setLanguages] = useState<string[]>(
    existing?.guide.languages ?? [],
  );
  const [body, setBody] = useState(existing?.guide.body ?? '');
  const [isSaving, setIsSaving] = useState(false);
  const [isConflict, setIsConflict] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const baseId = useId();

  const documentOnly = DOCUMENT_ONLY_KINDS.has(kind);
  // Mirrors the server's cross-field rule: structure/tone ⇒ document only.
  const effectiveWorkflows: Array<'document' | 'translation'> = documentOnly
    ? ['document']
    : workflows;

  const changeKind = (next: GuideKind) => {
    setKind(next);
    if (DOCUMENT_ONLY_KINDS.has(next)) setWorkflows(['document']);
  };

  const toggleWorkflow = (workflow: 'document' | 'translation') => {
    setWorkflows((prev) =>
      prev.includes(workflow)
        ? prev.filter((w) => w !== workflow)
        : [...prev, workflow],
    );
  };

  const bodyOverBy = body.length - MAX_GUIDE_BODY_CHARS;
  const canSave =
    name.trim().length > 0 &&
    name.trim().length <= MAX_GUIDE_NAME_CHARS &&
    body.length > 0 &&
    bodyOverBy <= 0 &&
    effectiveWorkflows.length > 0;

  const handleSave = async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      const response = await fetch('/api/agent-access/guides', {
        method: existing ? 'PUT' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(existing ? { 'If-Match': existing.etag } : {}),
        },
        body: JSON.stringify({
          ...(existing ? { id: existing.guide.id } : {}),
          name: name.trim(),
          description: description.trim(),
          kind,
          languages,
          body,
          workflows: effectiveWorkflows,
        }),
      });
      if (response.status === 409) {
        setIsConflict(true);
        return;
      }
      // Update-path 404: deleted while this editor was open. A PUT can never
      // mint a new record, so retrying is a dead end — route it to the
      // conflict banner whose Reload drops the stale row.
      if (existing && response.status === 404) {
        setIsConflict(true);
        return;
      }
      if (!response.ok) {
        const responseBody = (await response.json().catch(() => ({}))) as {
          error?: unknown;
        };
        setSaveError(
          typeof responseBody.error === 'string'
            ? responseBody.error
            : t('saveError'),
        );
        return;
      }
      toast.success(t(existing ? 'guideSaveSuccess' : 'guideCreateSuccess'));
      onSaved();
    } catch {
      setSaveError(t('saveError'));
    } finally {
      setIsSaving(false);
    }
  };

  const inputClass =
    'w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm text-black dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500';
  const labelClass =
    'mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300';

  if (isConflict) {
    return (
      <div className="mt-2 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-800 dark:text-amber-300">
        <p>{t('conflictError')}</p>
        <button
          type="button"
          className="mt-2 rounded-md bg-amber-600 px-3 py-1 text-sm font-medium text-white hover:bg-amber-700"
          onClick={onConflictReload}
        >
          {t('reload')}
        </button>
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-4">
      <p className="mb-3 text-sm font-semibold text-black dark:text-white">
        {existing ? t('editGuideTitle') : t('newGuideTitle')}
      </p>

      <div className="space-y-4">
        <div>
          <label className={labelClass} htmlFor={`${baseId}-name`}>
            {t('guideNameLabel')}
          </label>
          <input
            id={`${baseId}-name`}
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('guideNamePlaceholder')}
          />
        </div>

        <div>
          <label className={labelClass} htmlFor={`${baseId}-description`}>
            {t('guideDescriptionLabel')}
          </label>
          <input
            id={`${baseId}-description`}
            className={inputClass}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div className="flex gap-4">
          <div className="flex-1">
            <label className={labelClass} htmlFor={`${baseId}-kind`}>
              {t('guideKindLabel')}
            </label>
            <select
              id={`${baseId}-kind`}
              className={inputClass}
              value={kind}
              onChange={(e) => changeKind(e.target.value as GuideKind)}
            >
              {GUIDE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`guideKind_${k}`)}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t(`guideKindHint_${kind}`)}
            </p>
          </div>
          <div className="flex-1">
            <span className={labelClass}>{t('guideWorkflowsLabel')}</span>
            <div className="flex flex-col gap-1 pt-1">
              <label className="inline-flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={effectiveWorkflows.includes('document')}
                  disabled={documentOnly}
                  onChange={() => toggleWorkflow('document')}
                />
                {t('guideWorkflowDocument')}
              </label>
              <label className="inline-flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={effectiveWorkflows.includes('translation')}
                  disabled={documentOnly}
                  onChange={() => toggleWorkflow('translation')}
                />
                {t('guideWorkflowTranslation')}
              </label>
              {documentOnly && (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t('guideDocumentOnlyHint')}
                </p>
              )}
            </div>
          </div>
        </div>

        <div>
          <span className={labelClass}>{t('guideLanguagesLabel')}</span>
          <ChipListInput
            values={languages}
            onChange={setLanguages}
            placeholder={t('guideLanguagesPlaceholder')}
            addHint={t('guideLanguagesHint')}
            removeLabel={t('removeChip')}
          />
        </div>

        <div>
          <label className={labelClass} htmlFor={`${baseId}-body`}>
            {t('guideBodyLabel')}
          </label>
          <textarea
            id={`${baseId}-body`}
            className={`${inputClass} font-mono`}
            rows={14}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t('guideBodyPlaceholder')}
            aria-invalid={bodyOverBy > 0}
            spellCheck={false}
          />
          <p
            className={`mt-1 text-xs ${
              bodyOverBy > 0
                ? 'text-red-600 dark:text-red-400'
                : 'text-gray-500 dark:text-gray-400'
            }`}
          >
            {bodyOverBy > 0
              ? t('guideBodyTooLong', { over: String(bodyOverBy) })
              : t('guideBodyCounter', {
                  length: String(body.length),
                  max: String(MAX_GUIDE_BODY_CHARS),
                })}
          </p>
        </div>
      </div>

      {saveError && (
        <p className="mt-3 text-xs text-red-600 dark:text-red-400">
          {saveError}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          className="rounded-md bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          onClick={handleSave}
          disabled={!canSave || isSaving}
        >
          {t('save')}
        </button>
        <button
          type="button"
          className="rounded-md px-3 py-1 text-sm text-gray-700 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700"
          onClick={onCancel}
          disabled={isSaving}
        >
          {t('cancel')}
        </button>
      </div>
    </div>
  );
};
