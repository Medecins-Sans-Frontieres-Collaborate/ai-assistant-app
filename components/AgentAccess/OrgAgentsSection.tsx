'use client';

import {
  IconDatabase,
  IconHistory,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FC, useMemo, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';

import type { OrgRagAgent } from '@/lib/services/agentAccess/types';

import { isModelSelectableInRegion } from '@/lib/utils/shared/modelRegion';

import { OpenAIModels } from '@/types/openai';

import { ConflictDiff, ConflictDiffRow } from './ConflictDiff';
import { RuleEditor } from './RuleEditor';
import {
  AdminHistoryResponse,
  AdminOrgAgentsResponse,
  AdminStaticOrgAgent,
  AdminStoredOrgAgent,
  AdminStoredRule,
  CLIENT_ORG_AGENT_SOURCE,
  OrgAgentDraft,
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
  /**
   * Values to prefill the form with — a historical record (restore flow:
   * the admin reviews and Saves, which runs the normal validated CAS PUT
   * against `existing`'s etag) or a built-in agent being overridden
   * (create flow). Takes precedence over `existing.agent` for initial
   * values only.
   */
  prefill?: OrgAgentDraft | null;
  /** Create flow: preselects the built-in agent this record overrides. */
  initialOverrideId?: string;
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
  prefill,
  initialOverrideId,
  onSaved,
  onCancel,
  onConflictReload,
}) => {
  const t = useTranslations('agentAccess');
  const models = useSettingsStore((s) => s.models);
  const userRegion = useSettingsStore((s) => s.userRegion);

  // Restore flow: initial values come from the historical record while the
  // SAVE still targets `existing`'s current etag (review-then-save).
  const initial = prefill ?? existing?.agent;

  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [icon, setIcon] = useState(initial?.icon ?? 'IconHexagon');
  const [color, setColor] = useState(initial?.color ?? '#4190f2');
  const [category, setCategory] = useState(initial?.category ?? '');
  const [maintainedBy, setMaintainedBy] = useState(initial?.maintainedBy ?? '');
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? '');
  const [searchIndex, setSearchIndex] = useState(initial?.searchIndex ?? '');
  const [semanticConfig, setSemanticConfig] = useState(
    initial?.semanticConfig ?? '',
  );
  const [topK, setTopK] = useState(initial?.topK ?? 10);
  const [baseModelId, setBaseModelId] = useState(initial?.baseModelId ?? '');
  const [allowWebSearch, setAllowWebSearch] = useState(
    initial?.allowWebSearch ?? false,
  );
  const [allowCodeInterpreter, setAllowCodeInterpreter] = useState(
    initial?.allowCodeInterpreter ?? false,
  );
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [overrideId, setOverrideId] = useState(initialOverrideId ?? '');
  const [sources, setSources] = useState<EditorSource[]>(
    initial?.sources ?? [],
  );
  const [isSaving, setIsSaving] = useState(false);
  /**
   * 409 state: the record that won the race (null = deleted meanwhile).
   * The admin's draft stays in the form; ConflictDiff offers the choice.
   */
  const [conflict, setConflict] = useState<{
    latest: AdminStoredOrgAgent | null;
  } | null>(null);
  /** The If-Match token — rebased onto the winner's etag on "keep mine". */
  const [saveEtag, setSaveEtag] = useState<string | null>(
    existing?.etag ?? null,
  );
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
    conflict === null;

  /** Draft snapshot for the yours/theirs conflict comparison. */
  const draftValues = (): Record<string, string> => ({
    [t('agentNamePlaceholder')]: name.trim(),
    [t('agentDescriptionPlaceholder')]: description.trim(),
    [t('orgAgentIconPlaceholder')]: icon.trim(),
    [t('orgAgentColorLabel')]: color,
    [t('orgAgentCategoryPlaceholder')]: category.trim(),
    [t('orgAgentMaintainedByPlaceholder')]: maintainedBy.trim(),
    [t('orgAgentSystemPromptPlaceholder')]: systemPrompt.trim(),
    [t('orgAgentIndexLabel')]: searchIndex.trim(),
    [t('orgAgentSemanticPlaceholder')]: semanticConfig.trim(),
    [t('orgAgentTopKLabel')]: String(topK),
    [t('agentModelLabel')]: baseModelId || '',
    [t('orgAgentAllowWebSearch')]: String(allowWebSearch),
    [t('orgAgentAllowCodeInterpreter')]: String(allowCodeInterpreter),
    [t('orgAgentEnabled')]: String(enabled),
    [t('orgAgentSourcesLabel')]: sources
      .filter((s) => s.name.trim().length > 0)
      .map((s) => `${s.name.trim()} ${s.url.trim()}`.trim())
      .join(', '),
  });

  const recordValues = (agent: OrgRagAgent): Record<string, string> => ({
    [t('agentNamePlaceholder')]: agent.name,
    [t('agentDescriptionPlaceholder')]: agent.description,
    [t('orgAgentIconPlaceholder')]: agent.icon,
    [t('orgAgentColorLabel')]: agent.color,
    [t('orgAgentCategoryPlaceholder')]: agent.category,
    [t('orgAgentMaintainedByPlaceholder')]: agent.maintainedBy,
    [t('orgAgentSystemPromptPlaceholder')]: agent.systemPrompt,
    [t('orgAgentIndexLabel')]: agent.searchIndex,
    [t('orgAgentSemanticPlaceholder')]: agent.semanticConfig,
    [t('orgAgentTopKLabel')]: String(agent.topK),
    [t('agentModelLabel')]: agent.baseModelId ?? '',
    [t('orgAgentAllowWebSearch')]: String(agent.allowWebSearch),
    [t('orgAgentAllowCodeInterpreter')]: String(agent.allowCodeInterpreter),
    [t('orgAgentEnabled')]: String(agent.enabled),
    [t('orgAgentSourcesLabel')]: agent.sources
      .map((s) => `${s.name} ${s.url}`.trim())
      .join(', '),
  });

  const conflictRows = (latest: OrgRagAgent): ConflictDiffRow[] => {
    const yours = draftValues();
    const theirs = recordValues(latest);
    return Object.keys(yours)
      .filter((label) => yours[label] !== theirs[label])
      .map((label) => ({ label, yours: yours[label], theirs: theirs[label] }));
  };

  /** Loads the winning record's values into the form (take-theirs). */
  const adoptRecord = (latest: AdminStoredOrgAgent) => {
    const agent = latest.agent;
    setName(agent.name);
    setDescription(agent.description);
    setIcon(agent.icon);
    setColor(agent.color);
    setCategory(agent.category);
    setMaintainedBy(agent.maintainedBy);
    setSystemPrompt(agent.systemPrompt);
    setSearchIndex(agent.searchIndex);
    setSemanticConfig(agent.semanticConfig);
    setTopK(agent.topK);
    setBaseModelId(agent.baseModelId ?? '');
    setAllowWebSearch(agent.allowWebSearch);
    setAllowCodeInterpreter(agent.allowCodeInterpreter);
    setEnabled(agent.enabled);
    setSources(agent.sources.map((s) => ({ name: s.name, url: s.url })));
  };

  /**
   * On 409 (or a stale-target 404), fetch the record that won the race so
   * the conflict UI can show a yours/theirs diff — the draft is KEPT.
   */
  const loadConflictState = async () => {
    try {
      const response = await fetch('/api/agent-access/org-agents');
      if (response.ok) {
        const data = unwrapApiData<AdminOrgAgentsResponse>(
          await response.json(),
        );
        const latest =
          data?.orgAgents.find(
            (record) => record.agent.id === existing?.agent.id,
          ) ?? null;
        setConflict({ latest });
        return;
      }
    } catch {
      // Fall through to the etag-less conflict state below.
    }
    setConflict({ latest: null });
  };

  const handleSave = async (etagOverride?: string) => {
    setIsSaving(true);
    setSaveError(false);
    try {
      const ifMatch = etagOverride ?? saveEtag;
      const response = await fetch('/api/agent-access/org-agents', {
        method: existing ? 'PUT' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(existing && ifMatch ? { 'If-Match': ifMatch } : {}),
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
        await loadConflictState();
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
    'mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400';
  const fieldHelpClass = 'mt-1 text-xs text-gray-500 dark:text-gray-400';

  return (
    <div className="mt-2 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
      <h4 className="mb-3 text-sm font-semibold text-black dark:text-white">
        {t(
          existing
            ? 'editOrgAgentTitle'
            : overrideId
              ? 'orgAgentOverrideTitle'
              : 'newOrgAgentTitle',
        )}
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
        <div>
          <label htmlFor="org-agent-name" className={labelClass}>
            {t('agentNameLabel')}
          </label>
          <input
            id="org-agent-name"
            type="text"
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('agentNamePlaceholder')}
            className={inputClass}
          />
          <p className={fieldHelpClass}>{t('orgAgentNameHelp')}</p>
        </div>
        <div>
          <label htmlFor="org-agent-description" className={labelClass}>
            {t('agentDescriptionLabel')}
          </label>
          <input
            id="org-agent-description"
            type="text"
            value={description}
            maxLength={300}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('agentDescriptionPlaceholder')}
            className={inputClass}
          />
          <p className={fieldHelpClass}>{t('orgAgentDescriptionHelp')}</p>
        </div>
        <div>
          <label htmlFor="org-agent-icon" className={labelClass}>
            {t('orgAgentAppearanceLabel')}
          </label>
          <div className="flex gap-2">
            <input
              id="org-agent-icon"
              type="text"
              value={icon}
              maxLength={64}
              onChange={(e) => setIcon(e.target.value)}
              placeholder={t('orgAgentIconPlaceholder')}
              className={inputClass}
            />
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="h-9 w-14 shrink-0 cursor-pointer rounded-lg border border-gray-300 bg-gray-50 dark:border-gray-700 dark:bg-surface-dark-elevated"
              aria-label={t('orgAgentColorLabel')}
            />
          </div>
          <p className={fieldHelpClass}>{t('orgAgentAppearanceHelp')}</p>
        </div>
        <div>
          <label htmlFor="org-agent-category" className={labelClass}>
            {t('orgAgentMetadataLabel')}
          </label>
          <div className="flex gap-2">
            <input
              id="org-agent-category"
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
              aria-label={t('orgAgentMaintainedByPlaceholder')}
            />
          </div>
          <p className={fieldHelpClass}>{t('orgAgentMetadataHelp')}</p>
        </div>
        <div>
          <label htmlFor="org-agent-system-prompt" className={labelClass}>
            {t('agentSystemPromptLabel')}
          </label>
          <textarea
            id="org-agent-system-prompt"
            value={systemPrompt}
            maxLength={20000}
            rows={4}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder={t('orgAgentSystemPromptPlaceholder')}
            className={inputClass}
          />
          <p className={fieldHelpClass}>{t('orgAgentSystemPromptHelp')}</p>
        </div>

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
          <p className={fieldHelpClass}>{t('orgAgentIndexHelp')}</p>
        </div>
        <div>
          <label htmlFor="org-agent-semantic" className={labelClass}>
            {t('orgAgentRetrievalLabel')}
          </label>
          <div className="flex gap-2">
            <input
              id="org-agent-semantic"
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
          <p className={fieldHelpClass}>{t('orgAgentRetrievalHelp')}</p>
        </div>
        <div>
          <label htmlFor="org-agent-model" className={labelClass}>
            {t('agentModelLabel')}
          </label>
          <select
            id="org-agent-model"
            value={baseModelId}
            onChange={(e) => setBaseModelId(e.target.value)}
            className={inputClass}
          >
            <option value="">{t('m365AgentDefaultModel')}</option>
            {selectableModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>
          <p className={fieldHelpClass}>{t('orgAgentModelHelp')}</p>
        </div>

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

        {conflict &&
          (conflict.latest ? (
            <ConflictDiff
              rows={conflictRows(conflict.latest.agent)}
              updatedBy={conflict.latest.agent.updatedBy}
              updatedAt={conflict.latest.agent.updatedAt}
              onKeepMine={() => {
                const latestEtag = conflict.latest!.etag;
                setSaveEtag(latestEtag);
                setConflict(null);
                void handleSave(latestEtag);
              }}
              onTakeTheirs={() => {
                adoptRecord(conflict.latest!);
                setSaveEtag(conflict.latest!.etag);
                setConflict(null);
              }}
            />
          ) : (
            // The record vanished (deleted by another admin, or the reload
            // itself failed) — the draft stays visible for copy-out, but a
            // blind re-save has no target; reload is the only safe exit.
            <div className="rounded-md bg-amber-50 p-2 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
              {t('conflictRecordGone')}{' '}
              <button
                type="button"
                onClick={onConflictReload}
                className="font-medium underline"
              >
                {t('reload')}
              </button>
            </div>
          ))}
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

interface OrgAgentHistoryPanelProps {
  canonicalKey: string;
  /** updatedAt of the live record — its history entry is tagged "current". */
  currentUpdatedAt: string;
  onRestore: (agent: OrgRagAgent) => void;
}

/**
 * The immutable audit trail for one agent, newest first. "Load into editor"
 * prefills the edit form with the historical values — the admin reviews and
 * Saves, which runs the normal validated CAS PUT (and is itself audited).
 */
const OrgAgentHistoryPanel: FC<OrgAgentHistoryPanelProps> = ({
  canonicalKey,
  currentUpdatedAt,
  onRestore,
}) => {
  const t = useTranslations('agentAccess');
  const historyQuery = useQuery<AdminHistoryResponse>({
    queryKey: ['agent-access-history', canonicalKey],
    queryFn: async () => {
      const response = await fetch(
        `/api/agent-access/history?key=${encodeURIComponent(canonicalKey)}`,
      );
      if (!response.ok) {
        throw new Error(`Failed to fetch history: ${response.status}`);
      }
      return unwrapApiData<AdminHistoryResponse>(await response.json());
    },
    staleTime: 30_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  if (historyQuery.isLoading) {
    return (
      <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
        {t('historyLoading')}
      </p>
    );
  }
  if (historyQuery.isError) {
    return (
      <p className="mt-2 text-xs text-red-700 dark:text-red-400">
        {t('historyLoadFailed')}
      </p>
    );
  }

  const entries = historyQuery.data?.entries ?? [];
  if (entries.length === 0) {
    return (
      <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
        {t('historyEmpty')}
      </p>
    );
  }

  return (
    <div className="mt-2 rounded-lg border border-gray-200 p-2 dark:border-gray-700">
      <ul className="max-h-64 space-y-1 overflow-y-auto">
        {entries.map((entry) => {
          const isCurrent = entry.updatedAt === currentUpdatedAt;
          return (
            <li
              key={entry.updatedAt}
              className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-gray-700 dark:text-gray-300"
            >
              <span className="shrink-0 tabular-nums text-gray-500 dark:text-gray-400">
                {new Date(entry.updatedAt).toLocaleString()}
              </span>
              <span className="min-w-0 flex-1 truncate">{entry.updatedBy}</span>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 ${
                  entry.action === 'delete'
                    ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
                    : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
                }`}
              >
                {entry.action === 'delete'
                  ? t('historyActionDelete')
                  : t('historyActionUpsert')}
              </span>
              {isCurrent ? (
                <span className="shrink-0 rounded-full bg-blue-100 px-2 py-0.5 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
                  {t('historyCurrent')}
                </span>
              ) : (
                entry.orgAgent && (
                  <button
                    type="button"
                    onClick={() => onRestore(entry.orgAgent!)}
                    className="shrink-0 rounded-md border border-gray-200 px-2 py-0.5 text-black hover:bg-gray-100 dark:border-gray-700 dark:text-white dark:hover:bg-gray-800"
                  >
                    {t('historyRestore')}
                  </button>
                )
              )}
            </li>
          );
        })}
      </ul>
      {historyQuery.data?.truncated && (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {t('historyTruncated')}
        </p>
      )}
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
  /** Create flow seeded from a built-in agent (Override button). */
  const [overridePrefill, setOverridePrefill] =
    useState<AdminStaticOrgAgent | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingRuleKey, setEditingRuleKey] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState<string | null>(null);
  /** Restore flow: historical values to prefill the open editor with. */
  const [restorePrefill, setRestorePrefill] = useState<{
    id: string;
    agent: OrgRagAgent;
  } | null>(null);

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

  // Re-runs the index validation without editing (e.g. after a staged
  // index finished building) and persists the outcome on the record.
  const revalidateMutation = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch('/api/agent-access/org-agents/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!response.ok) {
        throw new Error(`Revalidation failed (${response.status})`);
      }
      return unwrapApiData<{
        agent?: { validation?: { status?: string; error?: string } };
      }>(await response.json());
    },
    onSuccess: (data) => {
      const validation = data?.agent?.validation;
      if (validation?.status === 'ok') {
        toast.success(t('orgAgentRevalidateOk'));
      } else {
        toast.error(
          t('orgAgentSavedButInvalid', { error: validation?.error ?? '' }),
          { duration: 8000 },
        );
      }
      invalidate();
    },
    onError: () => {
      toast.error(t('saveError'));
      invalidate();
    },
  });

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
  // Built-in agents an admin record already overrides are shown as that
  // record (the registry serves the record, not the file entry).
  const staticAgents = (agentsQuery.data?.staticAgents ?? []).filter(
    (entry) => !entry.overridden,
  );
  const staticAgentIds = agentsQuery.data?.staticAgentIds ?? [];
  const canCreate = agentsQuery.data?.canCreate !== false;
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

      {canCreate && (
        <button
          type="button"
          aria-expanded={isCreating}
          onClick={() => {
            setOverridePrefill(null);
            setIsCreating((creating) => !creating);
          }}
          className="mb-3 flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-black hover:bg-gray-100 dark:border-gray-700 dark:text-white dark:hover:bg-gray-800"
        >
          <IconPlus size={16} />
          {t('addOrgAgent')}
        </button>
      )}

      {isCreating && (
        <div className="mb-4">
          <OrgAgentEditor
            key={overridePrefill?.agent.id ?? 'new'}
            existing={null}
            indexNames={indexNames}
            indexesLoading={indexesQuery.isLoading}
            staticAgentIds={staticAgentIds}
            prefill={overridePrefill?.agent ?? null}
            initialOverrideId={overridePrefill?.agent.id}
            onSaved={() => {
              setIsCreating(false);
              setOverridePrefill(null);
              invalidate();
            }}
            onCancel={() => {
              setIsCreating(false);
              setOverridePrefill(null);
            }}
            onConflictReload={() => {
              setIsCreating(false);
              setOverridePrefill(null);
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

      {agents.length === 0 && staticAgents.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('noOrgAgents')}
        </p>
      ) : (
        <ul className="space-y-2">
          {staticAgents.map((entry) => {
            // Built-in (deployment config) agent: read-only settings, but
            // its access rule is editable under the same canonical key the
            // invocation guard and discovery filter evaluate.
            const stored = rulesByKey.get(entry.canonicalKey) ?? null;
            const isRestricted = stored?.rule.access.type === 'restricted';
            return (
              <li
                key={entry.canonicalKey}
                data-testid={`static-org-agent-${entry.agent.id}`}
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
                      <span
                        title={t('orgAgentBuiltinHint')}
                        className="shrink-0 rounded-full bg-gray-200 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-700 dark:text-gray-300"
                      >
                        {t('orgAgentBuiltinBadge')}
                      </span>
                    </div>
                    <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                      {entry.agent.searchIndex || entry.agent.id}
                    </p>
                  </div>
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
                  {canCreate && (
                    <button
                      type="button"
                      title={t('orgAgentBuiltinHint')}
                      onClick={() => {
                        setOverridePrefill(entry);
                        setIsCreating(true);
                      }}
                      className="shrink-0 rounded-md border border-gray-200 px-3 py-1 text-sm text-black hover:bg-gray-100 dark:border-gray-700 dark:text-white dark:hover:bg-gray-800"
                    >
                      {t('orgAgentOverrideAction')}
                    </button>
                  )}
                </div>

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
              </li>
            );
          })}
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
                    onClick={() => {
                      setRestorePrefill(null);
                      setEditingId(
                        editingId === entry.agent.id ? null : entry.agent.id,
                      );
                    }}
                    className="shrink-0 rounded-md border border-gray-200 px-3 py-1 text-sm text-black hover:bg-gray-100 dark:border-gray-700 dark:text-white dark:hover:bg-gray-800"
                  >
                    {t('editAgent')}
                  </button>
                  <button
                    type="button"
                    disabled={revalidateMutation.isPending}
                    onClick={() => revalidateMutation.mutate(entry.agent.id)}
                    className="flex shrink-0 items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-sm text-black hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-white dark:hover:bg-gray-800"
                    title={t('orgAgentRevalidateHint')}
                  >
                    <IconRefresh
                      size={14}
                      className={
                        revalidateMutation.isPending ? 'animate-spin' : ''
                      }
                    />
                    {t('orgAgentRevalidate')}
                  </button>
                  <button
                    type="button"
                    aria-label={t('historyTitle')}
                    title={t('historyTitle')}
                    onClick={() =>
                      setHistoryKey(
                        historyKey === entry.canonicalKey
                          ? null
                          : entry.canonicalKey,
                      )
                    }
                    className="shrink-0 rounded-md border border-gray-200 p-1.5 text-black hover:bg-gray-100 dark:border-gray-700 dark:text-white dark:hover:bg-gray-800"
                  >
                    <IconHistory size={15} />
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

                {historyKey === entry.canonicalKey && (
                  <OrgAgentHistoryPanel
                    canonicalKey={entry.canonicalKey}
                    currentUpdatedAt={entry.agent.updatedAt}
                    onRestore={(agent) => {
                      setRestorePrefill({ id: entry.agent.id, agent });
                      setEditingId(entry.agent.id);
                    }}
                  />
                )}

                {editingId === entry.agent.id && (
                  <OrgAgentEditor
                    key={`${entry.agent.id}:${entry.etag}:${
                      restorePrefill?.id === entry.agent.id
                        ? restorePrefill.agent.updatedAt
                        : 'live'
                    }`}
                    existing={entry}
                    indexNames={indexNames}
                    indexesLoading={indexesQuery.isLoading}
                    staticAgentIds={staticAgentIds}
                    prefill={
                      restorePrefill?.id === entry.agent.id
                        ? restorePrefill.agent
                        : null
                    }
                    onSaved={() => {
                      setEditingId(null);
                      setRestorePrefill(null);
                      invalidate();
                      void queryClient.invalidateQueries({
                        queryKey: ['agent-access-history'],
                      });
                    }}
                    onCancel={() => {
                      setEditingId(null);
                      setRestorePrefill(null);
                    }}
                    onConflictReload={() => {
                      setEditingId(null);
                      setRestorePrefill(null);
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
