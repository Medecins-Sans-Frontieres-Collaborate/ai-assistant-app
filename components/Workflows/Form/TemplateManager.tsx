'use client';

import {
  IconCamera,
  IconFileText,
  IconLoader,
  IconPencil,
  IconTrash,
  IconUpload,
  IconX,
} from '@tabler/icons-react';
import { useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  AvailableFormTemplate,
  useAvailableFormTemplates,
} from '@/client/hooks/settings/useAvailableFormTemplates';

import { uploadPhotos } from '@/client/services/workflows/data/photoExtraction';
import { uploadAndExtractText } from '@/client/services/workflows/fileTextExtraction';
import { deriveTemplate } from '@/client/services/workflows/form/formApi';
import { AnchorReport } from '@/lib/services/workflows/form/anchors';
import { layoutFromStructure } from '@/lib/services/workflows/form/deriveSchema';

import { FormTemplate } from '@/types/formFill';

import { EditableTemplate, TemplateEditor } from './TemplateEditor';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { v4 as uuidv4 } from 'uuid';

interface TemplateManagerProps {
  modelId?: string;
  conversationId: string;
  /** Attach the chosen template to the conversation (the "Use" action). */
  onUse: (template: FormTemplate) => void;
  onClose: () => void;
}

type CreateMode = 'upload' | 'paste' | 'instructions' | 'screenshot';

const buttonClass =
  'inline-flex min-h-[32px] items-center gap-1 rounded-lg px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-300 dark:hover:bg-surface-dark-elevated';
const primaryClass =
  'inline-flex min-h-[32px] items-center gap-1 rounded-lg bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-30';
const textareaClass =
  'w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-900 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark dark:text-gray-100';

function emptyDraft(): EditableTemplate {
  const sectionId = 'general';
  const draft = {
    name: 'Untitled form',
    sections: [{ id: sectionId, heading: 'General' }],
    fields: [],
  };
  return { ...draft, layout: layoutFromStructure(draft) };
}

/**
 * User templates (settingsStore.formTemplates): list, create from an
 * upload / pasted text / a description via the derive route, edit, delete,
 * and hand one to the workspace. Admin templates land in phase 2.
 */
export function TemplateManager({
  modelId,
  conversationId,
  onUse,
  onClose,
}: TemplateManagerProps) {
  const t = useTranslations('workflows.form');
  const templates = useSettingsStore((s) => s.formTemplates);
  const { templates: adminTemplates } = useAvailableFormTemplates();
  const [notice, setNotice] = useState<string | null>(null);

  const loadAdminTemplate = async (
    meta: AvailableFormTemplate,
  ): Promise<FormTemplate> => {
    const response = await fetch(`/api/form-templates/${meta.id}`);
    const parsed = await response.json().catch(() => null);
    if (!response.ok || !parsed?.success) {
      throw new Error(parsed?.error || `Load failed (${response.status})`);
    }
    return parsed.data.template as FormTemplate;
  };

  const handleUseAdmin = async (meta: AvailableFormTemplate) => {
    setError(null);
    setBusy(t('loadingTemplate'));
    try {
      onUse(await loadAdminTemplate(meta));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('deriveFailed'));
    } finally {
      setBusy(null);
    }
  };

  const handleCopyAdmin = async (meta: AvailableFormTemplate) => {
    setError(null);
    setBusy(t('loadingTemplate'));
    try {
      const template = await loadAdminTemplate(meta);
      const now = new Date().toISOString();
      addFormTemplate({
        ...template,
        // Locks are the point of an admin template; the copy keeps them.
        id: uuidv4(),
        origin: 'user',
        createdAt: now,
        updatedAt: now,
      });
      setNotice(t('copied'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('deriveFailed'));
    } finally {
      setBusy(null);
    }
  };
  const addFormTemplate = useSettingsStore((s) => s.addFormTemplate);
  const updateFormTemplate = useSettingsStore((s) => s.updateFormTemplate);
  const deleteFormTemplate = useSettingsStore((s) => s.deleteFormTemplate);

  const [mode, setMode] = useState<CreateMode | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<AnchorReport | null>(null);
  const [editing, setEditing] = useState<{
    id?: string;
    draft: EditableTemplate;
  } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);

  const handleScreenshots = async (files: File[]) => {
    if (files.length === 0) return;
    setError(null);
    setBusy(t('uploading'));
    try {
      const uploaded = await uploadPhotos(files.slice(0, 10));
      await runDerive({
        sourceKind: 'image',
        imageRefs: uploaded.map((u) => u.url),
        instructions: instructions || undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('uploadFailed'));
      setBusy(null);
    }
  };

  const runDerive = async (input: Parameters<typeof deriveTemplate>[0]) => {
    setError(null);
    setReport(null);
    setBusy(t('deriving'));
    try {
      const result = await deriveTemplate({
        ...input,
        modelId,
        conversationId,
      });
      setReport(result.anchorReport ?? null);
      setEditing({ draft: result.template });
      setMode(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('deriveFailed'));
    } finally {
      setBusy(null);
    }
  };

  const handleUpload = async (file: File) => {
    setError(null);
    setBusy(t('uploading'));
    try {
      const extracted = await uploadAndExtractText(file);
      if (!extracted.text.trim()) throw new Error(t('deriveFailed'));
      const ext = file.name.toLowerCase().split('.').pop();
      const isOriginal = (ext === 'docx' || ext === 'pdf') && extracted.url;
      await runDerive({
        sourceKind: 'file',
        text: extracted.text,
        instructions: instructions || undefined,
        fileId: isOriginal ? extracted.url : undefined,
        fileName: file.name,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('uploadFailed'));
      setBusy(null);
    }
  };

  const save = () => {
    if (!editing) return;
    const now = new Date().toISOString();
    if (editing.id) {
      updateFormTemplate(editing.id, editing.draft);
    } else {
      addFormTemplate({
        ...editing.draft,
        id: uuidv4(),
        origin: 'user',
        createdAt: now,
        updatedAt: now,
      });
    }
    setEditing(null);
    setReport(null);
  };

  const canSave =
    !!editing &&
    editing.draft.name.trim() !== '' &&
    editing.draft.fields.length > 0 &&
    editing.draft.sections.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {editing
            ? editing.id
              ? editing.draft.name
              : t('newTemplate')
            : t('templates')}
        </h3>
        <button
          type="button"
          onClick={editing ? () => setEditing(null) : onClose}
          aria-label={t('closeTemplates')}
          className="ms-auto flex h-7 w-7 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
        >
          <IconX size={15} aria-hidden />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {editing ? (
          <>
            {report && (
              <p className="mb-3 rounded-lg bg-gray-50 px-2.5 py-2 text-xs text-gray-700 dark:bg-surface-dark-elevated dark:text-gray-300">
                {report.fillMode === 'none'
                  ? t('anchorNone')
                  : t('anchorReport', {
                      anchored: String(report.anchoredCount),
                      total: String(editing.draft.fields.length),
                    })}
                {report.unmatchedSlots.length > 0 &&
                  ` ${t('anchorUnmatched', { count: String(report.unmatchedSlots.length) })}`}
              </p>
            )}
            <TemplateEditor
              value={editing.draft}
              onChange={(draft) => setEditing({ ...editing, draft })}
              disabled={busy !== null}
            />
          </>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              <input
                ref={fileInput}
                type="file"
                accept=".docx,.pdf,.doc,.txt,.md,.html"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleUpload(file);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => setMode(mode === 'upload' ? null : 'upload')}
                aria-pressed={mode === 'upload'}
                className={buttonClass}
              >
                <IconUpload size={13} aria-hidden />
                {t('createFromUpload')}
              </button>
              <input
                ref={imageInput}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  void handleScreenshots(Array.from(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  setMode(mode === 'screenshot' ? null : 'screenshot')
                }
                aria-pressed={mode === 'screenshot'}
                className={buttonClass}
              >
                <IconCamera size={13} aria-hidden />
                {t('createFromScreenshot')}
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => setMode(mode === 'paste' ? null : 'paste')}
                aria-pressed={mode === 'paste'}
                className={buttonClass}
              >
                <IconFileText size={13} aria-hidden />
                {t('createFromPaste')}
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  setMode(mode === 'instructions' ? null : 'instructions')
                }
                aria-pressed={mode === 'instructions'}
                className={buttonClass}
              >
                <IconPencil size={13} aria-hidden />
                {t('createFromInstructions')}
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  setReport(null);
                  setEditing({ draft: emptyDraft() });
                }}
                className={buttonClass}
              >
                {t('newTemplate')}
              </button>
            </div>

            {mode === 'upload' && (
              <div className="mb-3 space-y-2">
                <p className="text-xs text-gray-600 dark:text-gray-400">
                  {t('uploadHint')}
                </p>
                <textarea
                  rows={2}
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder={t('instructionsHint')}
                  className={textareaClass}
                />
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => fileInput.current?.click()}
                  className={primaryClass}
                >
                  <IconUpload size={13} aria-hidden />
                  {t('createFromUpload')}
                </button>
              </div>
            )}
            {mode === 'screenshot' && (
              <div className="mb-3 space-y-2">
                <p className="text-xs text-gray-600 dark:text-gray-400">
                  {t('screenshotHint')}
                </p>
                <textarea
                  rows={2}
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder={t('instructionsHint')}
                  className={textareaClass}
                />
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => imageInput.current?.click()}
                  className={primaryClass}
                >
                  <IconCamera size={13} aria-hidden />
                  {t('createFromScreenshot')}
                </button>
              </div>
            )}
            {mode === 'paste' && (
              <div className="mb-3 space-y-2">
                <textarea
                  rows={8}
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  placeholder={t('pastePlaceholder')}
                  className={textareaClass}
                />
                <textarea
                  rows={2}
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder={t('instructionsHint')}
                  className={textareaClass}
                />
                <button
                  type="button"
                  disabled={busy !== null || !pasteText.trim()}
                  onClick={() =>
                    runDerive({
                      sourceKind: 'paste',
                      text: pasteText,
                      instructions: instructions || undefined,
                    })
                  }
                  className={primaryClass}
                >
                  {t('derive')}
                </button>
              </div>
            )}
            {mode === 'instructions' && (
              <div className="mb-3 space-y-2">
                <textarea
                  rows={4}
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder={t('instructionsPlaceholder')}
                  className={textareaClass}
                />
                <button
                  type="button"
                  disabled={busy !== null || !instructions.trim()}
                  onClick={() =>
                    runDerive({ sourceKind: 'instructions', instructions })
                  }
                  className={primaryClass}
                >
                  {t('derive')}
                </button>
              </div>
            )}

            {busy && (
              <p className="mb-2 inline-flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
                <IconLoader size={13} className="animate-spin" aria-hidden />
                {busy}
              </p>
            )}
            {error && (
              <p
                className="mb-2 text-xs text-red-700 dark:text-red-400"
                role="alert"
              >
                {error}
              </p>
            )}

            {notice && (
              <p
                className="mb-2 text-xs text-green-700 dark:text-green-400"
                role="status"
              >
                {notice}
              </p>
            )}
            {adminTemplates.length > 0 && (
              <div className="mb-4">
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  {t('adminTemplates')}
                </p>
                <ul className="space-y-1.5">
                  {adminTemplates.map((meta) => (
                    <li
                      key={meta.id}
                      className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50/40 px-2.5 py-2 dark:border-blue-900/40 dark:bg-blue-900/10"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-gray-900 dark:text-gray-100">
                          {meta.name}
                        </p>
                        <p className="truncate text-[11px] text-gray-500 dark:text-gray-400">
                          {meta.fieldCount} · {t(`fillMode.${meta.fillMode}`)}
                          {meta.language ? ` · ${meta.language}` : ''}
                          {meta.description ? ` · ${meta.description}` : ''}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void handleUseAdmin(meta)}
                        className={primaryClass}
                      >
                        {t('useTemplate')}
                      </button>
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void handleCopyAdmin(meta)}
                        className={buttonClass}
                      >
                        {t('copyToMine')}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {templates.length === 0 ? (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {t('templatesEmpty')}
              </p>
            ) : (
              <ul className="space-y-1.5">
                {templates.map((template) => (
                  <li
                    key={template.id}
                    className="flex items-center gap-2 rounded-lg border border-gray-200 px-2.5 py-2 dark:border-gray-700"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-gray-900 dark:text-gray-100">
                        {template.name}
                      </p>
                      <p className="truncate text-[11px] text-gray-500 dark:text-gray-400">
                        {template.fields.length} ·{' '}
                        {template.original
                          ? t(`fillMode.${template.original.fillMode}`)
                          : t('fillMode.none')}
                        {template.language ? ` · ${template.language}` : ''}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => onUse(template)}
                      className={primaryClass}
                    >
                      {t('useTemplate')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const {
                          id,
                          origin: _origin,
                          createdAt: _c,
                          updatedAt: _u,
                          ...draft
                        } = template;
                        void _origin;
                        void _c;
                        void _u;
                        setReport(null);
                        setEditing({ id, draft });
                      }}
                      disabled={busy !== null}
                      aria-label={t('editTemplate')}
                      className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
                    >
                      <IconPencil size={14} aria-hidden />
                    </button>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => deleteFormTemplate(template.id)}
                      aria-label={t('deleteTemplate')}
                      className="rounded-lg p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-700 disabled:opacity-30 dark:text-gray-400 dark:hover:bg-red-900/20"
                    >
                      <IconTrash size={14} aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {editing && (
        <div className="flex items-center gap-2 border-t border-gray-200 px-3 py-2 dark:border-gray-700">
          <button
            type="button"
            onClick={() => setEditing(null)}
            className={buttonClass}
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!canSave}
            className={`${primaryClass} ms-auto`}
          >
            {t('saveTemplate')}
          </button>
        </div>
      )}
    </div>
  );
}
