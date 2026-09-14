'use client';

import {
  IconArrowLeft,
  IconCamera,
  IconLoader,
  IconUpload,
} from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';

import { uploadPhotos } from '@/client/services/workflows/data/photoExtraction';
import { uploadAndExtractText } from '@/client/services/workflows/fileTextExtraction';
import { deriveTemplate } from '@/client/services/workflows/form/formApi';
import { AnchorReport } from '@/lib/services/workflows/form/anchors';

import { FormTemplate } from '@/types/formFill';

import {
  EditableTemplate,
  TemplateEditor,
} from '@/components/Workflows/Form/TemplateEditor';

import { AdminFormTemplateResponse } from '../types';

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'loaded' };

const primaryClass =
  'inline-flex min-h-[32px] items-center gap-1 rounded-lg bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-30';
const buttonClass =
  'inline-flex min-h-[32px] items-center gap-1 rounded-lg px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-300 dark:hover:bg-surface-dark-elevated';
const textareaClass =
  'w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-900 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark dark:text-gray-100';

/**
 * Full-page editor for one admin form template: the workflow's own
 * TemplateEditor in admin mode (locked/prefill controls), plus the
 * upload/paste/describe derivation, CAS save with If-Match, and the
 * 409 conflict banner (same pattern as MapDatasetEditor).
 */
export function FormTemplateAdminEditor({
  templateId,
}: {
  templateId: string;
}) {
  const t = useTranslations('adminFormTemplates');
  const tf = useTranslations('workflows.form');
  const router = useRouter();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);

  const [state, setState] = useState<LoadState>({ phase: 'loading' });
  const [etag, setEtag] = useState('');
  const [draft, setDraft] = useState<EditableTemplate | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [isConflict, setIsConflict] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [report, setReport] = useState<AnchorReport | null>(null);
  const [mode, setMode] = useState<'paste' | 'instructions' | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [instructions, setInstructions] = useState('');

  const seed = useCallback((data: AdminFormTemplateResponse) => {
    const template = data.record.template as unknown as FormTemplate;
    const {
      id: _id,
      origin: _o,
      createdAt: _c,
      updatedAt: _u,
      ...rest
    } = template;
    void _id;
    void _o;
    void _c;
    void _u;
    setDraft(rest);
    setEtag(data.etag);
    setDirty(false);
    setIsConflict(false);
    setSaveError(null);
  }, []);

  const load = useCallback(async () => {
    setState({ phase: 'loading' });
    try {
      const response = await fetch('/api/agent-access/form-templates');
      if (!response.ok) throw new Error(`Load failed (${response.status})`);
      const data = unwrapApiData<{
        templates: Array<{
          record: AdminFormTemplateResponse['record'];
          etag: string;
          canonicalKey: string;
        }>;
      }>(await response.json());
      const entry = data.templates.find((e) => e.record.id === templateId);
      if (!entry) throw new Error(t('notFound'));
      seed({
        record: entry.record,
        etag: entry.etag,
        canonicalKey: entry.canonicalKey,
      });
      setState({ phase: 'loaded' });
    } catch (err) {
      setState({
        phase: 'error',
        message: err instanceof Error ? err.message : t('loadError'),
      });
    }
  }, [templateId, seed, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const update = (next: EditableTemplate) => {
    setDraft(next);
    setDirty(true);
  };

  const runDerive = async (input: Parameters<typeof deriveTemplate>[0]) => {
    setBusy(tf('deriving'));
    setSaveError(null);
    try {
      const result = await deriveTemplate(input);
      setReport(result.anchorReport ?? null);
      // Keep admin-only field controls only where labels still match is
      // not knowable — a re-derive replaces the structure wholesale.
      update({ ...result.template, rules: draft?.rules });
      setMode(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : tf('deriveFailed'));
    } finally {
      setBusy(null);
    }
  };

  const handleUpload = async (file: File) => {
    setBusy(tf('uploading'));
    try {
      const extracted = await uploadAndExtractText(file);
      if (!extracted.text.trim()) throw new Error(tf('deriveFailed'));
      const ext = file.name.toLowerCase().split('.').pop();
      await runDerive({
        sourceKind: 'file',
        text: extracted.text,
        instructions: instructions || undefined,
        fileId:
          (ext === 'docx' || ext === 'pdf') && extracted.url
            ? extracted.url
            : undefined,
        fileName: file.name,
      });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : tf('uploadFailed'));
      setBusy(null);
    }
  };

  const handleScreenshots = async (files: File[]) => {
    if (files.length === 0) return;
    setBusy(tf('uploading'));
    try {
      const uploaded = await uploadPhotos(files.slice(0, 10));
      await runDerive({
        sourceKind: 'image',
        imageRefs: uploaded.map((u) => u.url),
        instructions: instructions || undefined,
      });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : tf('uploadFailed'));
      setBusy(null);
    }
  };

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      const response = await fetch('/api/agent-access/form-templates', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'If-Match': etag },
        body: JSON.stringify({ id: templateId, ...draft }),
      });
      if (response.status === 409) {
        setIsConflict(true);
        return;
      }
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? `Save failed (${response.status})`);
      }
      seed(unwrapApiData<AdminFormTemplateResponse>(await response.json()));
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['agent-access-form-templates'],
        }),
        queryClient.invalidateQueries({
          queryKey: ['available-form-templates'],
        }),
      ]);
      toast.success(t('saved'));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('saveError'));
    } finally {
      setSaving(false);
    }
  };

  if (state.phase === 'loading') {
    return (
      <p className="p-6 text-sm text-gray-500 dark:text-gray-400">
        {t('loading')}
      </p>
    );
  }
  if (state.phase === 'error' || !draft) {
    return (
      <div className="p-6 text-sm text-red-600 dark:text-red-400">
        <p>{state.phase === 'error' ? state.message : t('loadError')}</p>
        <button
          type="button"
          onClick={() => void load()}
          className={`${buttonClass} mt-2`}
        >
          {t('retry')}
        </button>
      </div>
    );
  }

  const canSave =
    dirty && !saving && draft.name.trim() !== '' && draft.fields.length > 0;

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-2 dark:border-gray-700">
        <button
          type="button"
          onClick={() => {
            if (dirty && !window.confirm(t('leaveUnsaved'))) return;
            router.push('/admin/form-templates');
          }}
          className={buttonClass}
        >
          <IconArrowLeft size={14} aria-hidden />
          {t('back')}
        </button>
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
          {draft.name}
        </h1>
        {busy && (
          <span className="inline-flex items-center gap-1 text-xs text-gray-500">
            <IconLoader size={13} className="animate-spin" aria-hidden />
            {busy}
          </span>
        )}
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!canSave}
          className={primaryClass}
        >
          {saving ? t('saving') : t('save')}
        </button>
      </div>

      {isConflict && (
        <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200">
          <span className="flex-1">{t('conflict')}</span>
          <button
            type="button"
            onClick={() => void load()}
            className={buttonClass}
          >
            {t('reload')}
          </button>
        </div>
      )}
      {saveError && (
        <p
          className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-800 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300"
          role="alert"
        >
          {saveError}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="mb-4 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
          <p className="mb-2 text-xs font-medium text-gray-700 dark:text-gray-300">
            {t('deriveTitle')}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
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
              onClick={() => fileInput.current?.click()}
              className={buttonClass}
            >
              <IconUpload size={13} aria-hidden />
              {tf('createFromUpload')}
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
              onClick={() => imageInput.current?.click()}
              className={buttonClass}
            >
              <IconCamera size={13} aria-hidden />
              {tf('createFromScreenshot')}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => setMode(mode === 'paste' ? null : 'paste')}
              className={buttonClass}
            >
              {tf('createFromPaste')}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() =>
                setMode(mode === 'instructions' ? null : 'instructions')
              }
              className={buttonClass}
            >
              {tf('createFromInstructions')}
            </button>
          </div>
          {mode === 'paste' && (
            <div className="mt-2 space-y-2">
              <textarea
                rows={6}
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder={tf('pastePlaceholder')}
                className={textareaClass}
              />
              <button
                type="button"
                disabled={busy !== null || !pasteText.trim()}
                onClick={() =>
                  void runDerive({
                    sourceKind: 'paste',
                    text: pasteText,
                    instructions: instructions || undefined,
                  })
                }
                className={primaryClass}
              >
                {tf('derive')}
              </button>
            </div>
          )}
          {mode === 'instructions' && (
            <div className="mt-2 space-y-2">
              <textarea
                rows={3}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder={tf('instructionsPlaceholder')}
                className={textareaClass}
              />
              <button
                type="button"
                disabled={busy !== null || !instructions.trim()}
                onClick={() =>
                  void runDerive({ sourceKind: 'instructions', instructions })
                }
                className={primaryClass}
              >
                {tf('derive')}
              </button>
            </div>
          )}
          {report && (
            <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">
              {report.fillMode === 'none'
                ? tf('anchorNone')
                : tf('anchorReport', {
                    anchored: String(report.anchoredCount),
                    total: String(draft.fields.length),
                  })}
            </p>
          )}
          <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
            {t('originalHint')}
          </p>
        </div>

        <TemplateEditor
          value={draft}
          onChange={update}
          disabled={busy !== null || saving}
          adminMode
        />
      </div>
    </div>
  );
}
