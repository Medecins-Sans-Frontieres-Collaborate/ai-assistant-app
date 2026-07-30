'use client';

import { IconDatabase, IconPlus, IconTrash, IconX } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FC, useMemo, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';

import { isModelSelectableInRegion } from '@/lib/utils/shared/modelRegion';

import { OpenAIModels } from '@/types/openai';

import { RuleEditor } from './RuleEditor';
import {
  AdminOrgAgentsResponse,
  AdminStoredOrgAgent,
  AdminStoredRule,
  CLIENT_ORG_AGENT_SOURCE,
  clientCanonicalAgentKey,
} from './types';

import { useSettingsStore } from '@/client/stores/settingsStore';

const AGENT_MODEL_ID_PREFIXES = ['foundry-', 'org-', 'custom-', 'byom-'];

function isServerKnownModelId(modelId: string): boolean {
  return Object.prototype.hasOwnProperty.call(OpenAIModels, modelId);
}

interface EditorSource {
  name: string;
  url: string;
}

interface OrgAgentEditorProps {
  existing: AdminStoredOrgAgent | null;
  /** Index names on the org search endpoint (picked, never typed). */
  indexNames: string[];
  indexesLoading: boolean;
  /** Static config ids offered as override targets (create only). */
  staticAgentIds: string[];
  onSaved: () => void;
  onCancel: () => void;
  onConflictReload: () => void;
}

/**
 * Create/edit form for an organization RAG agent: display metadata, system
 * prompt, the backing search index (picked from the endpoint's real index
 * list), attribution sources, tool toggles, and the base chat model. The
 * server validates the index against the retrieval contract on every save
 * and persists the outcome — a failed validation saves but never serves.
 */
const OrgAgentEditor: FC<OrgAgentEditorProps> = ({
  existing,
  indexNames,
  indexesLoading,
  staticAgentIds,
  onSaved,
  onCancel,
  onConflictReload,
}) => {
  const t = useTranslations('agentAccess');
  const models = useSettingsStore((s) => s.models);
  const userRegion = useSettingsStore((s) => s.userRegion);

  const [name, setName] = useState(existing?.agent.name ?? '');
  const [description, setDescription] = useState(
    existing?.agent.description ?? '',
  );
  const [icon, setIcon] = useState(existing?.agent.icon ?? 'IconHexagon');
  const [color, setColor] = useState(existing?.agent.color ?? '#4190f2');
  const [category, setCategory] = useState(existing?.agent.category ?? '');
  const [maintainedBy, setMaintainedBy] = useState(
    existing?.agent.maintainedBy ?? '',
  );
  const [systemPrompt, setSystemPrompt] = useState(
    existing?.agent.systemPrompt ?? '',
  );
  const [searchIndex, setSearchIndex] = useState(
    existing?.agent.searchIndex ?? '',
  );
  const [semanticConfig, setSemanticConfig] = useState(
    existing?.agent.semanticConfig ?? '',
  );
  const [topK, setTopK] = useState(existing?.agent.topK ?? 10);
  const [baseModelId, setBaseModelId] = useState(
    existing?.agent.baseModelId ?? '',
  );
  const [allowWebSearch, setAllowWebSearch] = useState(
    existing?.agent.allowWebSearch ?? false,
  );
  const [allowCodeInterpreter, setAllowCodeInterpreter] = useState(
    existing?.agent.allowCodeInterpreter ?? false,
  );
  const [enabled, setEnabled] = useState(existing?.agent.enabled ?? true);
  const [overrideId, setOverrideId] = useState('');
  const [sources, setSources] = useState<EditorSource[]>(
    existing?.agent.sources ?? [],
  );
  const [isSaving, setIsSaving] = useState(false);
  const [isConflict, setIsConflict] = useState(false);
  const [saveError, setSaveError] = useState(false);

  const selectableModels = useMemo(
    () =>
      models.filter(
        (m) =>
          !AGENT_MODEL_ID_PREFIXES.some((prefix) => m.id.startsWith(prefix)) &&
          isServerKnownModelId(m.id) &&
          isModelSelectableInRegion(m, userRegion),
      ),
    [models, userRegion],
  );

  const canSave =
    name.trim().length > 0 &&
    searchIndex.trim().length > 0 &&
    !isSaving &&
    !isConflict;

  const handleSave = async () => {
    setIsSaving(true);
    setSaveError(false);
    try {
      const response = await fetch('/api/agent-access/org-agents', {
        method: existing ? 'PUT' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(existing ? { 'If-Match': existing.etag } : {}),
        },
        body: JSON.stringify({
          ...(existing ? { id: existing.agent.id } : {}),
          ...(!existing && overrideId ? { overrideId } : {}),
          name: name.trim(),
          description: description.trim(),
          icon: icon.trim() || 'IconHexagon',
          color,
          category: category.trim(),
          maintainedBy: maintainedBy.trim(),
          systemPrompt: systemPrompt.trim(),
          sources: sources
            .filter((s) => s.name.trim().length > 0)
            .map((s) => ({ name: s.name.trim(), url: s.url.trim() })),
          searchIndex: searchIndex.trim(),
          semanticConfig: semanticConfig.trim(),
          topK,
          baseModelId: baseModelId || null,
          allowWebSearch,
          allowCodeInterpreter,
          enabled,
        }),
      });
      if (response.status === 409 || (existing && response.status === 404)) {
        setIsConflict(true);
        return;
      }
      if (!response.ok) {
        setSaveError(true);
        return;
      }
      const data = unwrapApiData<{
        agent?: { validation?: { status?: string; error?: string } };
      }>(await response.json().catch(() => ({})));
      const validation = data?.agent?.validation;
      if (validation?.status === 'failed') {
        toast.error(
          t('orgAgentSavedButInvalid', {
            error: validation.error ?? '',
          }),
          { duration: 8000 },
        );
      } else {
        toast.success(
          t(existing ? 'orgAgentSaveSuccess' : 'orgAgentCreateSuccess'),
        );
      }
      onSaved();
    } finally {
      setIsSaving(false);
    }
  };

  const inputClass =
    'w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-900 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100';
  const labelClass =
    'text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400';

  return (
    <div className="mt-2 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
      <h4 className="mb-3 text-sm font-semibold text-black dark:text-white">
        {t(existing ? 'editOrgAgentTitle' : 'newOrgAgentTitle')}
      </h4>
      <div className="space-y-3">
        {!existing && staticAgentIds.length > 0 && (
          <div>
            <label className={labelClass}>{t('orgAgentOverrideLabel')}</label>
            <select
              value={overrideId}
              onChange={(e) => setOverrideId(e.target.value)}
              className={inputClass}
            >
              <option value="">{t('orgAgentOverrideNone')}</option>
              {staticAgentIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </div>
        )}
        <input
          type="text"
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('agentNamePlaceholder')}
          className={inputClass}
        />
        <input
          type="text"
          value={description}
          maxLength={300}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('agentDescriptionPlaceholder')}
          className={inputClass}
        />
        <div className="flex gap-2">
          <input
            type="text"
            value={icon}
            maxLength={64}
            onChange={(e) => setIcon(e.target.value)}
            placeholder={t('orgAgentIconPlaceholder')}
            className={inputClass}
            aria-label={t('orgAgentIconPlaceholder')}
          />
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="h-9 w-14 shrink-0 cursor-pointer rounded-lg border border-gray-300 bg-gray-50 dark:border-gray-700 dark:bg-surface-dark-elevated"
            aria-label={t('orgAgentColorLabel')}
          />
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={category}
            maxLength={100}
            onChange={(e) => setCategory(e.target.value)}
            placeholder={t('orgAgentCategoryPlaceholder')}
            className={inputClass}
          />
          <input
            type="text"
            value={maintainedBy}
            maxLength={120}
            onChange={(e) => setMaintainedBy(e.target.value)}
            placeholder={t('orgAgentMaintainedByPlaceholder')}
            className={inputClass}
          />
        </div>
        <textarea
          value={systemPrompt}
          maxLength={20000}
          rows={4}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder={t('orgAgentSystemPromptPlaceholder')}
          className={inputClass}
        />

        {/* Retrieval config — the index is picked from the endpoint's real
            list, so a nonexistent name cannot be submitted. */}
        <div>
          <label className={labelClass}>{t('orgAgentIndexLabel')}</label>
          <select
            value={searchIndex}
            onChange={(e) => setSearchIndex(e.target.value)}
            className={inputClass}
          >
            <option value="">
              {indexesLoading
                ? t('orgAgentIndexesLoading')
                : t('orgAgentIndexPickerEmpty')}
            </option>
            {/* Keep a stored index selectable even if it vanished from the
                listing — the save re-validates and surfaces the failure. */}
            {searchIndex && !indexNames.includes(searchIndex) && (
              <option value={searchIndex}>{searchIndex}</option>
            )}
            {indexNames.map((indexName) => (
              <option key={indexName} value={indexName}>
                {indexName}
              </option>
            ))}
          </select>
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={semanticConfig}
            maxLength={200}
            onChange={(e) => setSemanticConfig(e.target.value)}
            placeholder={t('orgAgentSemanticPlaceholder')}
            className={inputClass}
          />
          <input
            type="number"
            min={1}
            max={20}
            value={topK}
            onChange={(e) => {
              const parsed = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(parsed)) {
                setTopK(Math.min(20, Math.max(1, parsed)));
              }
            }}
            className="w-24 shrink-0 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-900 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100"
            aria-label={t('orgAgentTopKLabel')}
          />
        </div>
        <select
          value={baseModelId}
          onChange={(e) => setBaseModelId(e.target.value)}
          className={inputClass}
          aria-label={t('agentModelLabel')}
        >
          <option value="">{t('m365AgentDefaultModel')}</option>
          {selectableModels.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>

        {/* Attribution sources shown in the agent details panel. */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className={labelClass}>{t('orgAgentSourcesLabel')}</span>
            <button
              type="button"
              onClick={() =>
                setSources((prev) => [...prev, { name: '', url: '' }])
              }
              disabled={sources.length >= 20}
              className="flex items-center gap-1 rounded-md border border-neutral-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-40 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-700"
            >
              <IconPlus size={14} /> {t('orgAgentAddSource')}
            </button>
          </div>
          {sources.length > 0 && (
            <ul className="space-y-1">
              {sources.map((source, index) => (
                <li key={index} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={source.name}
                    maxLength={200}
                    onChange={(e) =>
                      setSources((prev) =>
                        prev.map((s, i) =>
                          i === index ? { ...s, name: e.target.value } : s,
                        ),
                      )
                    }
                    placeholder={t('orgAgentSourceNamePlaceholder')}
                    className={inputClass}
                  />
                  <input
                    type="url"
                    value={source.url}
                    maxLength={2000}
                    onChange={(e) =>
                      setSources((prev) =>
                        prev.map((s, i) =>
                          i === index ? { ...s, url: e.target.value } : s,
                        ),
                      )
                    }
                    placeholder={t('orgAgentSourceUrlPlaceholder')}
                    className={inputClass}
                  />
                  <button
                    type="button"
                    aria-label={t('orgAgentRemoveSource')}
                    onClick={() =>
                      setSources((prev) => prev.filter((_, i) => i !== index))
                    }
                    className="shrink-0 text-gray-400 hover:text-red-600"
                  >
                    <IconX size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
            <input
              type="checkbox"
              checked={allowWebSearch}
              onChange={(e) => setAllowWebSearch(e.target.checked)}
            />
            {t('orgAgentAllowWebSearch')}
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
            <input
              type="checkbox"
              checked={allowCodeInterpreter}
              onChange={(e) => setAllowCodeInterpreter(e.target.checked)}
            />
            {t('orgAgentAllowCodeInterpreter')}
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            {t('orgAgentEnabled')}
          </label>
        </div>

        {isConflict && (
          <div className="rounded-md bg-amber-50 p-2 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
            {t('conflictError')}{' '}
            <button
              type="button"
              onClick={onConflictReload}
              className="font-medium underline"
            >
              {t('reload')}
            </button>
          </div>
        )}
        {saveError && (
          <p className="text-sm text-red-700 dark:text-red-400">
            {t('saveError')}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-black hover:bg-gray-100 dark:border-gray-700 dark:text-white dark:hover:bg-gray-800"
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!canSave}
            className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:pointer-events-none disabled:opacity-40"
          >
            {isSaving ? t('saving') : t('save')}
          </button>
        </div>
      </div>
    </div>
  );
};

interface OrgAgentsSectionProps {
  /** Rules from the panel's rules query — reused for the access pill/editor. */
  rules: AdminStoredRule[];
  /** Invalidate shared panel data (rules + discovery) after a change. */
  onDataChanged: () => void;
}

/**
 * The organization RAG agents block inside the agents admin section: the
 * blob-store counterpart of config/organization-agents.json. Every save is
 * validated against the live search index (contract + probe query) and the
 * outcome is shown on the row — a failed record saves but never serves.
 */
export const OrgAgentsSection: FC<OrgAgentsSectionProps> = ({
  rules,
  onDataChanged,
}) => {
  const t = useTranslations('agentAccess');
  const queryClient = useQueryClient();
  const [isCreating, setIsCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingRuleKey, setEditingRuleKey] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const agentsQuery = useQuery<AdminOrgAgentsResponse>({
    queryKey: ['agent-access-org-agents'],
    queryFn: async () => {
      const response = await fetch('/api/agent-access/org-agents');
      if (!response.ok) {
        throw new Error(`Failed to fetch org agents: ${response.status}`);
      }
      return unwrapApiData<AdminOrgAgentsResponse>(await response.json());
    },
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const indexesQuery = useQuery<{ indexes: string[] }>({
    queryKey: ['agent-access-org-agent-indexes'],
    queryFn: async () => {
      const response = await fetch('/api/agent-access/org-agents/indexes');
      if (!response.ok) {
        throw new Error(`Failed to fetch indexes: ${response.status}`);
      }
      return unwrapApiData<{ indexes: string[] }>(await response.json());
    },
    staleTime: 5 * 60 * 1000,
    retry: 1,
    refetchOnWindowFocus: false,
    // Only worth fetching while an editor is (or is about to be) open.
    enabled: isCreating || editingId !== null,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: ['agent-access-org-agents'],
    });
    onDataChanged();
  };

  const rulesByKey = useMemo(
    () => new Map(rules.map((rule) => [rule.canonicalKey, rule])),
    [rules],
  );

  const handleDelete = async (entry: AdminStoredOrgAgent) => {
    setConfirmDeleteId(null);
    const response = await fetch(
      `/api/agent-access/org-agents?id=${encodeURIComponent(entry.agent.id)}`,
      { method: 'DELETE', headers: { 'If-Match': entry.etag } },
    );
    if (response.ok || response.status === 404) {
      toast.success(t('orgAgentDeleteSuccess'));
    } else {
      toast.error(t('saveError'));
    }
    invalidate();
  };

  const agents = agentsQuery.data?.orgAgents ?? [];
  const staticAgentIds = agentsQuery.data?.staticAgentIds ?? [];
  const indexNames = indexesQuery.data?.indexes ?? [];

  return (
    <div className="mt-6 border-t border-gray-200 pt-4 dark:border-gray-700">
      <div className="mb-2 flex items-center gap-2">
        <IconDatabase size={18} className="text-emerald-600" />
        <h3 className="text-sm font-semibold text-black dark:text-white">
          {t('orgAgentsHeading')}
        </h3>
      </div>
      <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
        {t('orgAgentsDescription')}
      </p>

      {agentsQuery.data?.canCreate !== false && (
        <button
          type="button"
          aria-expanded={isCreating}
          onClick={() => setIsCreating((creating) => !creating)}
          className="mb-3 flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-black hover:bg-gray-100 dark:border-gray-700 dark:text-white dark:hover:bg-gray-800"
        >
          <IconPlus size={16} />
          {t('addOrgAgent')}
        </button>
      )}

      {isCreating && (
        <div className="mb-4">
          <OrgAgentEditor
            existing={null}
            indexNames={indexNames}
            indexesLoading={indexesQuery.isLoading}
            staticAgentIds={staticAgentIds}
            onSaved={() => {
              setIsCreating(false);
              invalidate();
            }}
            onCancel={() => setIsCreating(false)}
            onConflictReload={() => {
              setIsCreating(false);
              invalidate();
            }}
          />
        </div>
      )}

      {agentsQuery.data?.orgAgentsUnavailable && (
        <p className="mb-2 text-xs text-amber-700 dark:text-amber-400">
          {t('orgAgentsUnavailableWarning')}
        </p>
      )}

      {agents.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('noOrgAgents')}
        </p>
      ) : (
        <ul className="space-y-2">
          {agents.map((entry) => {
            const stored = rulesByKey.get(entry.canonicalKey) ?? null;
            const isRestricted = stored?.rule.access.type === 'restricted';
            const validation = entry.agent.validation;
            return (
              <li
                key={entry.canonicalKey}
                className="rounded-lg border border-gray-200 p-3 dark:border-gray-700"
              >
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-black dark:text-white">
                        {entry.agent.name}
                      </span>
                      <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
                        {t('orgAgentBadge')}
                      </span>
                      {!entry.agent.enabled && (
                        <span className="shrink-0 rounded-full bg-gray-200 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-700 dark:text-gray-300">
                          {t('orgAgentDisabledBadge')}
                        </span>
                      )}
                    </div>
                    <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                      {entry.agent.searchIndex}
                    </p>
                  </div>
                  <span
                    title={
                      validation.status === 'failed'
                        ? validation.error
                        : undefined
                    }
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                      validation.status === 'ok'
                        ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                        : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
                    }`}
                  >
                    {validation.status === 'ok'
                      ? validation.documentCount !== undefined
                        ? t('orgAgentValidationOkDocs', {
                            count: validation.documentCount,
                          })
                        : t('orgAgentValidationOk')
                      : t('orgAgentValidationFailed')}
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
                    onClick={() =>
                      setEditingRuleKey(
                        editingRuleKey === entry.canonicalKey
                          ? null
                          : entry.canonicalKey,
                      )
                    }
                    className="shrink-0 rounded-md border border-gray-200 px-3 py-1 text-sm text-black hover:bg-gray-100 dark:border-gray-700 dark:text-white dark:hover:bg-gray-800"
                  >
                    {t('editAccess')}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setEditingId(
                        editingId === entry.agent.id ? null : entry.agent.id,
                      )
                    }
                    className="shrink-0 rounded-md border border-gray-200 px-3 py-1 text-sm text-black hover:bg-gray-100 dark:border-gray-700 dark:text-white dark:hover:bg-gray-800"
                  >
                    {t('editAgent')}
                  </button>
                  <button
                    type="button"
                    aria-label={t('deleteAgent')}
                    onClick={() => setConfirmDeleteId(entry.agent.id)}
                    className="shrink-0 rounded-md border border-gray-200 p-1.5 text-red-600 hover:bg-red-50 dark:border-gray-700 dark:hover:bg-red-900/20"
                  >
                    <IconTrash size={15} />
                  </button>
                </div>

                {validation.status === 'failed' && validation.error && (
                  <p className="mt-2 break-words rounded-md bg-red-50 p-2 text-xs text-red-800 dark:bg-red-900/20 dark:text-red-300">
                    {validation.error}
                  </p>
                )}

                {confirmDeleteId === entry.agent.id && (
                  <div className="mt-2 flex items-center justify-between rounded-md bg-red-50 p-2 text-sm text-red-800 dark:bg-red-900/20 dark:text-red-300">
                    <span>{t('orgAgentDeleteConfirm')}</span>
                    <span className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        className="rounded-md px-2 py-0.5 hover:bg-red-100 dark:hover:bg-red-900/40"
                      >
                        {t('cancel')}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(entry)}
                        className="rounded-md bg-red-600 px-2 py-0.5 font-medium text-white hover:bg-red-700"
                      >
                        {t('deleteAgent')}
                      </button>
                    </span>
                  </div>
                )}

                {editingRuleKey === entry.canonicalKey && (
                  <div className="mt-2">
                    <RuleEditor
                      key={`${entry.canonicalKey}:${stored?.etag ?? 'none'}`}
                      row={{
                        canonicalKey: clientCanonicalAgentKey(
                          CLIENT_ORG_AGENT_SOURCE,
                          entry.agent.id,
                        ),
                        source: CLIENT_ORG_AGENT_SOURCE,
                        agentName: entry.agent.id,
                        displayName: entry.agent.name,
                        discoverable: true,
                        stored,
                        promptAgent: null,
                      }}
                      onSaved={() => {
                        setEditingRuleKey(null);
                        invalidate();
                      }}
                      onCancel={() => setEditingRuleKey(null)}
                      onConflictReload={() => {
                        setEditingRuleKey(null);
                        invalidate();
                      }}
                    />
                  </div>
                )}

                {editingId === entry.agent.id && (
                  <OrgAgentEditor
                    key={`${entry.agent.id}:${entry.etag}`}
                    existing={entry}
                    indexNames={indexNames}
                    indexesLoading={indexesQuery.isLoading}
                    staticAgentIds={staticAgentIds}
                    onSaved={() => {
                      setEditingId(null);
                      invalidate();
                    }}
                    onCancel={() => setEditingId(null)}
                    onConflictReload={() => {
                      setEditingId(null);
                      invalidate();
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
