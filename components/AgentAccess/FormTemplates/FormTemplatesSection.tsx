'use client';

import { IconPlus } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';

import { layoutFromStructure } from '@/lib/services/workflows/form/deriveSchema';

import { RuleEditor } from '../RuleEditor';
import {
  AdminFormTemplateResponse,
  AdminFormTemplatesResponse,
  AdminRulesResponse,
  AdminStoredFormTemplate,
  CLIENT_FORM_TEMPLATE_SOURCE,
  MergedAgentRow,
} from '../types';

/**
 * Admin list of form-fill templates with per-template access rules
 * (docs/FORM_FILL_WORKFLOW.md, phase 2). Rows reuse MergedAgentRow so the
 * shared RuleEditor works unchanged over the `form-template::<id>` key.
 * Creation mints a blank template and opens the full-page editor, where
 * the upload/paste/describe derivation lives.
 */
export function FormTemplatesSection() {
  const t = useTranslations('agentAccess');
  const tf = useTranslations('adminFormTemplates');
  const router = useRouter();
  const queryClient = useQueryClient();

  const templatesQuery = useQuery<AdminFormTemplatesResponse>({
    queryKey: ['agent-access-form-templates'],
    queryFn: async () => {
      const response = await fetch('/api/agent-access/form-templates');
      if (!response.ok) {
        throw new Error(`Failed to fetch form templates: ${response.status}`);
      }
      return unwrapApiData<AdminFormTemplatesResponse>(await response.json());
    },
    retry: 1,
    refetchOnWindowFocus: false,
  });
  const rulesQuery = useQuery<AdminRulesResponse>({
    queryKey: ['agent-access-rules'],
    queryFn: async () => {
      const response = await fetch('/api/agent-access/rules');
      if (!response.ok) {
        throw new Error(`Failed to fetch rules: ${response.status}`);
      }
      return unwrapApiData<AdminRulesResponse>(await response.json());
    },
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const [editingRuleKey, setEditingRuleKey] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(() => {
    const rulesByKey = new Map(
      (rulesQuery.data?.rules ?? []).map((r) => [r.canonicalKey, r]),
    );
    return (templatesQuery.data?.templates ?? [])
      .map((entry: AdminStoredFormTemplate) => ({
        row: {
          canonicalKey: entry.canonicalKey,
          source: CLIENT_FORM_TEMPLATE_SOURCE,
          agentName: entry.record.id,
          displayName: entry.record.name,
          discoverable: true,
          stored: rulesByKey.get(entry.canonicalKey) ?? null,
          promptAgent: null,
        } satisfies MergedAgentRow,
        entry,
      }))
      .sort((a, b) => a.row.displayName.localeCompare(b.row.displayName));
  }, [templatesQuery.data, rulesQuery.data]);

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ['agent-access-form-templates'],
      }),
      queryClient.invalidateQueries({ queryKey: ['agent-access-rules'] }),
      queryClient.invalidateQueries({ queryKey: ['available-form-templates'] }),
      queryClient.invalidateQueries({ queryKey: ['agent-access-config'] }),
      queryClient.invalidateQueries({ queryKey: ['agent-access-me'] }),
    ]);
  };

  const handleCreate = async () => {
    setBusy(true);
    setError(null);
    try {
      const sections = [{ id: 'general', heading: 'General' }];
      const fields = [
        {
          id: 'title',
          sectionId: 'general',
          label: 'Title',
          type: 'text',
          required: true,
        },
      ];
      const draft = { name: tf('untitled'), sections, fields };
      const response = await fetch('/api/agent-access/form-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...draft,
          layout: layoutFromStructure({
            name: draft.name,
            sections,
            fields: fields.map((f) => ({ ...f, type: 'text' as const })),
          }),
        }),
      });
      if (!response.ok) throw new Error(`Create failed (${response.status})`);
      const data = unwrapApiData<AdminFormTemplateResponse>(
        await response.json(),
      );
      await invalidate();
      router.push(`/admin/form-templates/${data.record.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveError'));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (entry: AdminStoredFormTemplate) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/agent-access/form-templates?id=${encodeURIComponent(entry.record.id)}`,
        { method: 'DELETE', headers: { 'If-Match': entry.etag } },
      );
      if (!response.ok && response.status !== 404) {
        throw new Error(`Delete failed (${response.status})`);
      }
      setConfirmDeleteId(null);
      await invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveError'));
    } finally {
      setBusy(false);
    }
  };

  if (templatesQuery.isLoading) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">{t('loading')}</p>
    );
  }
  if (templatesQuery.error || templatesQuery.data?.templatesUnavailable) {
    return (
      <div className="text-sm text-red-600 dark:text-red-400">
        <p>
          {templatesQuery.data?.templatesUnavailable
            ? t('formTemplatesUnavailableWarning')
            : t('loadError')}
        </p>
        <button
          type="button"
          className="mt-2 rounded-md border border-gray-300 px-3 py-1 text-sm text-black hover:bg-gray-100 dark:border-gray-600 dark:text-white dark:hover:bg-gray-800"
          onClick={() => void templatesQuery.refetch()}
        >
          {t('retry')}
        </button>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        disabled={busy}
        className="mb-4 flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-black hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:text-white dark:hover:bg-gray-800"
        onClick={() => void handleCreate()}
      >
        <IconPlus size={16} />
        {t('addFormTemplate')}
      </button>
      {error && (
        <p className="mb-3 text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('noFormTemplates')}
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map(({ row, entry }) => {
            const isRestricted = row.stored?.rule.access.type === 'restricted';
            const template = entry.record.template as {
              fields?: unknown[];
              original?: { fillMode?: string };
            };
            return (
              <li
                key={row.canonicalKey}
                className="rounded-lg border border-gray-200 p-3 dark:border-gray-700"
              >
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <span className="truncate text-sm font-medium text-black dark:text-white">
                      {row.displayName}
                    </span>
                    {entry.record.description && (
                      <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                        {entry.record.description}
                      </p>
                    )}
                  </div>
                  <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">
                    {t('formTemplateFieldCount', {
                      count: String(template.fields?.length ?? 0),
                    })}
                  </span>
                  <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                    {tf(`fillMode.${template.original?.fillMode ?? 'none'}`)}
                  </span>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                      isRestricted
                        ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
                        : 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                    }`}
                  >
                    {isRestricted ? t('accessRestricted') : t('accessEveryone')}
                  </span>
                  <button
                    type="button"
                    className="shrink-0 rounded-md border border-gray-200 px-3 py-1 text-sm text-black hover:bg-gray-100 dark:border-gray-700 dark:text-white dark:hover:bg-gray-800"
                    onClick={() =>
                      setEditingRuleKey(
                        editingRuleKey === row.canonicalKey
                          ? null
                          : row.canonicalKey,
                      )
                    }
                  >
                    {editingRuleKey === row.canonicalKey
                      ? t('cancel')
                      : t('editAccess')}
                  </button>
                  <button
                    type="button"
                    className="shrink-0 rounded-md border border-gray-200 px-3 py-1 text-sm text-black hover:bg-gray-100 dark:border-gray-700 dark:text-white dark:hover:bg-gray-800"
                    onClick={() =>
                      router.push(`/admin/form-templates/${entry.record.id}`)
                    }
                  >
                    {t('openFormTemplateEditor')}
                  </button>
                  <button
                    type="button"
                    className="shrink-0 rounded-md border border-red-200 px-3 py-1 text-sm text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-900/20"
                    onClick={() =>
                      setConfirmDeleteId(
                        confirmDeleteId === entry.record.id
                          ? null
                          : entry.record.id,
                      )
                    }
                  >
                    {t('deleteFormTemplate')}
                  </button>
                </div>
                <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                  {t('updatedByLine', {
                    user: entry.record.updatedBy,
                    date: entry.record.updatedAt,
                  })}
                </p>
                {editingRuleKey === row.canonicalKey && (
                  <RuleEditor
                    key={`${row.canonicalKey}:${row.stored?.etag ?? 'none'}`}
                    row={row}
                    onSaved={async () => {
                      setEditingRuleKey(null);
                      await invalidate();
                    }}
                    onCancel={() => setEditingRuleKey(null)}
                    onConflictReload={async () => {
                      setEditingRuleKey(null);
                      await rulesQuery.refetch();
                    }}
                  />
                )}
                {confirmDeleteId === entry.record.id && (
                  <div className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-900/20 dark:text-red-300">
                    <p>
                      {t('deleteFormTemplateConfirm', {
                        name: entry.record.name,
                      })}
                    </p>
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        className="rounded-md bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                        onClick={() => void handleDelete(entry)}
                        disabled={busy}
                      >
                        {t('confirmDeleteFormTemplate')}
                      </button>
                      <button
                        type="button"
                        className="rounded-md px-3 py-1 text-sm text-gray-700 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700"
                        onClick={() => setConfirmDeleteId(null)}
                        disabled={busy}
                      >
                        {t('cancel')}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
