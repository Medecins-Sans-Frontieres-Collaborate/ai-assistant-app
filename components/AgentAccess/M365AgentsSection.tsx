'use client';

import {
  IconBrandOnedrive,
  IconFile,
  IconFolder,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FC, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';
import { useM365Enabled } from '@/client/hooks/useM365Enabled';

import type {
  M365AgentManifest,
  M365AgentSource,
} from '@/lib/services/agentAccess/types';

import { isModelSelectableInRegion } from '@/lib/utils/shared/modelRegion';

import type { M365DriveEntry } from '@/types/m365';
import { OpenAIModels } from '@/types/openai';

import M365FilePickerModal from '@/components/Chat/ChatInput/M365FilePickerModal';

import { ConflictDiff, ConflictDiffRow } from './ConflictDiff';
import {
  M365SourcePlanView,
  SourceSelection,
  formatBytes,
} from './M365SourcePlanView';
import { RuleEditor } from './RuleEditor';
import {
  AdminM365AgentsResponse,
  AdminStoredM365Agent,
  AdminStoredRule,
  CLIENT_M365_AGENT_SOURCE,
  ClientAgentPlan,
  ClientSourcePlan,
  clientCanonicalAgentKey,
} from './types';

import { useSettingsStore } from '@/client/stores/settingsStore';

type M365AgentRecord = AdminStoredM365Agent['agent'];

const AGENT_MODEL_ID_PREFIXES = ['foundry-', 'org-', 'custom-', 'byom-'];
/**
 * Fallback while the listing (which serves the env-configured cap) hasn't
 * loaded — matches the server's M365_AGENT_MAX_DOCUMENTS default.
 */
const DEFAULT_MAX_SOURCES = 50;
/** Fallback for the byte budget (M365_AGENT_MAX_SOURCE_MB default). */
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
/** Selection edits re-plan after this pause (metadata calls only). */
const PLAN_DEBOUNCE_MS = 400;

function isServerKnownModelId(modelId: string): boolean {
  return Object.prototype.hasOwnProperty.call(OpenAIModels, modelId);
}

interface EditorSource extends SourceSelection {
  driveId: string;
  itemId: string;
  kind: 'file' | 'folder';
  title: string;
  webUrl: string;
  /** Present for sources loaded from an existing agent (status display). */
  persisted?: M365AgentSource;
}

function sourceKey(source: { driveId: string; itemId: string }): string {
  return `${source.driveId}:${source.itemId}`;
}

function toEditorSource(source: M365AgentSource): EditorSource {
  return {
    driveId: source.driveId,
    itemId: source.itemId,
    kind: source.kind,
    title: source.title,
    webUrl: source.webUrl,
    recursive: source.recursive,
    excludedItemIds: source.excludedItemIds,
    includeExtensions: source.includeExtensions,
    persisted: source,
  };
}

/** The wire shape for POST/PUT and /plan. */
function toSourcePayload(source: EditorSource) {
  return {
    driveId: source.driveId,
    itemId: source.itemId,
    kind: source.kind,
    title: source.title,
    webUrl: source.webUrl,
    recursive: source.kind === 'folder' && source.recursive,
    excludedItemIds: source.kind === 'folder' ? source.excludedItemIds : [],
    ...(source.includeExtensions?.length
      ? { includeExtensions: source.includeExtensions }
      : {}),
  };
}

interface M365AgentEditorProps {
  existing: AdminStoredM365Agent | null;
  /** Server's env-configured document cap (from the listing response). */
  maxSources: number;
  /** Server's env-configured byte budget (from the listing response). */
  maxBytes: number;
  onSaved: () => void;
  onCancel: () => void;
  onConflictReload: () => void;
}

/**
 * Create/edit form for an M365 file-backed agent: metadata + chat-model
 * default + the capped OneDrive/SharePoint sources (picked with the same
 * browse modal the chat attach flow uses). Saving manages the RECORD only;
 * indexing is the separate Index action on the row (it can take minutes and
 * uses the caller's Graph token).
 */
const M365AgentEditor: FC<M365AgentEditorProps> = ({
  existing,
  maxSources,
  maxBytes,
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
  const [systemPrompt, setSystemPrompt] = useState(
    existing?.agent.systemPrompt ?? '',
  );
  const [chatModelId, setChatModelId] = useState(
    existing?.agent.chatModelId ?? '',
  );
  const [sources, setSources] = useState<EditorSource[]>(
    (existing?.agent.sources ?? []).map(toEditorSource),
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  /** Plan for the CURRENT selection (design §1); null until the first run. */
  const [plan, setPlan] = useState<ClientAgentPlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const planRequest = useRef(0);

  // Last index run's per-item outcomes, for existing agents only.
  const manifestQuery = useQuery<M365AgentManifest | null>({
    queryKey: ['agent-access-m365-agent-manifest', existing?.agent.id],
    queryFn: async () => {
      const response = await fetch(
        `/api/agent-access/m365-agents/manifest?id=${encodeURIComponent(existing!.agent.id)}`,
      );
      if (!response.ok) return null;
      const data = unwrapApiData<{ manifest: M365AgentManifest | null }>(
        await response.json(),
      );
      return data?.manifest ?? null;
    },
    enabled: existing !== null,
    retry: 0,
    refetchOnWindowFocus: false,
  });
  const manifestBySourceId = useMemo(() => {
    const map = new Map<string, M365AgentManifest['sources'][number]>();
    for (const source of manifestQuery.data?.sources ?? []) {
      map.set(source.sourceId, source);
    }
    return map;
  }, [manifestQuery.data]);

  // Re-plan whenever the selection changes (debounced). The plan is what
  // the server enforces at save and index time, so the numbers shown are
  // the numbers that count.
  const selectionKey = JSON.stringify(sources.map(toSourcePayload));
  useEffect(() => {
    if (sources.length === 0) {
      setPlan(null);
      setPlanError(null);
      return;
    }
    const requestId = ++planRequest.current;
    const timer = setTimeout(async () => {
      setPlanLoading(true);
      try {
        const response = await fetch('/api/agent-access/m365-agents/plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sources: sources.map(toSourcePayload) }),
        });
        if (requestId !== planRequest.current) return;
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          setPlanError(body?.error || t('m365PlanFailed'));
          return;
        }
        const data = unwrapApiData<ClientAgentPlan>(await response.json());
        setPlan(data ?? null);
        setPlanError(null);
      } catch {
        if (requestId === planRequest.current)
          setPlanError(t('m365PlanFailed'));
      } finally {
        if (requestId === planRequest.current) setPlanLoading(false);
      }
    }, PLAN_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey]);

  const planBySourceKey = useMemo(() => {
    const map = new Map<string, ClientSourcePlan>();
    for (const sourcePlan of plan?.plans ?? []) {
      map.set(sourceKey(sourcePlan), sourcePlan);
    }
    return map;
  }, [plan]);

  const updateSelection = (
    target: EditorSource,
    patch: Partial<SourceSelection>,
  ) => {
    setSources((prev) =>
      prev.map((source) =>
        sourceKey(source) === sourceKey(target)
          ? { ...source, ...patch }
          : source,
      ),
    );
  };

  const overCap = !!plan && (plan.overDocumentCap || plan.overByteCap);
  const [isSaving, setIsSaving] = useState(false);
  /**
   * 409 state: the record that won the race (null = deleted meanwhile).
   * The admin's draft stays in the form; ConflictDiff offers the choice.
   */
  const [conflict, setConflict] = useState<{
    latest: AdminStoredM365Agent | null;
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

  const addSource = (entry: M365DriveEntry) => {
    setSources((prev) => {
      if (
        prev.some(
          (s) => s.driveId === entry.driveId && s.itemId === entry.itemId,
        )
      ) {
        return prev;
      }
      if (prev.length >= maxSources) {
        toast.error(t('m365AgentTooManySources', { max: maxSources }));
        return prev;
      }
      return [
        ...prev,
        {
          driveId: entry.driveId,
          itemId: entry.itemId,
          kind: entry.isFolder ? 'folder' : 'file',
          title: entry.name,
          webUrl: entry.webUrl ?? '',
          // New folders include their subtree by default (review decision);
          // the plan view shows the consequence immediately.
          recursive: entry.isFolder,
          excludedItemIds: [],
        },
      ];
    });
  };

  const canSave =
    name.trim().length > 0 &&
    sources.length > 0 &&
    !isSaving &&
    !overCap &&
    conflict === null;

  const sourcesSummary = (list: { title: string }[]) =>
    list.map((s) => s.title).join(', ');

  const conflictRows = (latest: M365AgentRecord): ConflictDiffRow[] => {
    const yours: Record<string, string> = {
      [t('agentNamePlaceholder')]: name.trim(),
      [t('agentDescriptionPlaceholder')]: description.trim(),
      [t('m365AgentSystemPromptPlaceholder')]: systemPrompt.trim(),
      [t('agentModelLabel')]: chatModelId || '',
      [t('m365AgentSources')]: sourcesSummary(sources),
    };
    const theirs: Record<string, string> = {
      [t('agentNamePlaceholder')]: latest.name,
      [t('agentDescriptionPlaceholder')]: latest.description,
      [t('m365AgentSystemPromptPlaceholder')]: latest.systemPrompt,
      [t('agentModelLabel')]: latest.chatModelId ?? '',
      [t('m365AgentSources')]: sourcesSummary(latest.sources),
    };
    return Object.keys(yours)
      .filter((label) => yours[label] !== theirs[label])
      .map((label) => ({ label, yours: yours[label], theirs: theirs[label] }));
  };

  /** Loads the winning record's values into the form (take-theirs). */
  const adoptRecord = (latest: AdminStoredM365Agent) => {
    setName(latest.agent.name);
    setDescription(latest.agent.description);
    setSystemPrompt(latest.agent.systemPrompt);
    setChatModelId(latest.agent.chatModelId ?? '');
    setSources(latest.agent.sources.map(toEditorSource));
  };

  /**
   * On 409 (or a stale-target 404), fetch the record that won the race so
   * the conflict UI can show a yours/theirs diff — the draft is KEPT.
   */
  const loadConflictState = async () => {
    try {
      const response = await fetch('/api/agent-access/m365-agents');
      if (response.ok) {
        const data = unwrapApiData<AdminM365AgentsResponse>(
          await response.json(),
        );
        const latest =
          data?.m365Agents.find(
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
      const response = await fetch('/api/agent-access/m365-agents', {
        method: existing ? 'PUT' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(existing && ifMatch ? { 'If-Match': ifMatch } : {}),
        },
        body: JSON.stringify({
          ...(existing ? { id: existing.agent.id } : {}),
          name: name.trim(),
          description: description.trim(),
          systemPrompt: systemPrompt.trim(),
          chatModelId: chatModelId || null,
          topK: existing?.agent.ragConfig.topK ?? 10,
          sources: sources.map(toSourcePayload),
        }),
      });
      if (response.status === 409 || (existing && response.status === 404)) {
        await loadConflictState();
        return;
      }
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        if (response.status === 400 && body?.error) toast.error(body.error);
        setSaveError(true);
        return;
      }
      toast.success(
        t(existing ? 'm365AgentSaveSuccess' : 'm365AgentCreateSuccess'),
      );
      onSaved();
    } finally {
      setIsSaving(false);
    }
  };

  const inputClass =
    'w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-900 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100';

  return (
    <div className="mt-2 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
      <h4 className="mb-3 text-sm font-semibold text-black dark:text-white">
        {t(existing ? 'editM365AgentTitle' : 'newM365AgentTitle')}
      </h4>
      <div className="space-y-4">
        <div>
          <label
            htmlFor="m365-agent-name"
            className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-300"
          >
            {t('m365AgentNameLabel')}
          </label>
          <input
            id="m365-agent-name"
            type="text"
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('m365AgentNamePlaceholder')}
            className={inputClass}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t('m365AgentNameHelp')}
          </p>
        </div>
        <div>
          <label
            htmlFor="m365-agent-description"
            className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-300"
          >
            {t('m365AgentDescriptionLabel')}
          </label>
          <input
            id="m365-agent-description"
            type="text"
            value={description}
            maxLength={300}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('m365AgentDescriptionPlaceholder')}
            className={inputClass}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t('m365AgentDescriptionHelp')}
          </p>
        </div>
        <div>
          <label
            htmlFor="m365-agent-system-prompt"
            className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-300"
          >
            {t('m365AgentSystemPromptLabel')}
          </label>
          <textarea
            id="m365-agent-system-prompt"
            value={systemPrompt}
            maxLength={10000}
            rows={4}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder={t('m365AgentSystemPromptPlaceholder')}
            className={inputClass}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t('m365AgentSystemPromptHelp')}
          </p>
        </div>
        <div>
          <label
            htmlFor="m365-agent-model"
            className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-300"
          >
            {t('m365AgentModelLabel')}
          </label>
          <select
            id="m365-agent-model"
            value={chatModelId}
            onChange={(e) => setChatModelId(e.target.value)}
            className={inputClass}
          >
            <option value="">{t('m365AgentDefaultModel')}</option>
            {selectableModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t('m365AgentModelHelp')}
          </p>
        </div>

        {/* Sources */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">
              {t('m365AgentSources')} ({sources.length}/{maxSources})
            </span>
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              disabled={sources.length >= maxSources}
              className="flex items-center gap-1 rounded-md border border-neutral-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-40 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-700"
            >
              <IconPlus size={14} /> {t('m365AgentAddSource')}
            </button>
          </div>
          <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
            {t('m365AgentSourcesHelp')}
          </p>
          {sources.length > 0 && (
            <div
              className={`mb-2 rounded-md px-2 py-1 text-xs ${
                overCap
                  ? 'bg-red-50 text-red-800 dark:bg-red-900/20 dark:text-red-300'
                  : 'bg-gray-50 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
              }`}
            >
              <span className="font-semibold">
                {t('m365CapDocuments', {
                  count: plan?.totalDocuments ?? 0,
                  max: maxSources,
                })}
              </span>
              {' · '}
              {t('m365CapBytes', {
                bytes: formatBytes(plan?.totalBytes ?? 0),
                max: formatBytes(maxBytes),
              })}
              {planLoading && (
                <span className="ml-2 text-gray-500 dark:text-gray-400">
                  {t('m365PlanScanning')}
                </span>
              )}
              {plan?.overDocumentCap && (
                <p className="mt-1">
                  {t('m365CapOverDocuments', { max: maxSources })}
                </p>
              )}
              {plan?.overByteCap && (
                <p className="mt-1">
                  {t('m365CapOverBytes', { max: formatBytes(maxBytes) })}
                </p>
              )}
              {planError && (
                <p className="mt-1 text-amber-700 dark:text-amber-400">
                  {planError}
                </p>
              )}
            </div>
          )}
          {sources.length === 0 ? (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t('m365AgentNoSources', { max: maxSources })}
            </p>
          ) : (
            <ul className="space-y-1">
              {sources.map((source) => (
                <li
                  key={`${source.driveId}-${source.itemId}`}
                  className="rounded-md border border-neutral-200 px-2 py-1 text-sm dark:border-neutral-700"
                >
                  <div className="flex items-center gap-2">
                    {source.kind === 'folder' ? (
                      <IconFolder
                        size={15}
                        className="shrink-0 text-amber-500"
                      />
                    ) : (
                      <IconFile size={15} className="shrink-0 text-gray-400" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-gray-800 dark:text-gray-200">
                      {source.title}
                    </span>
                    {source.persisted && (
                      <span className="shrink-0 text-xs text-gray-400">
                        {t(`m365SourceStatus.${source.persisted.status}`)}
                      </span>
                    )}
                    <button
                      type="button"
                      aria-label={t('m365AgentRemoveSource')}
                      onClick={() =>
                        setSources((prev) =>
                          prev.filter(
                            (s) =>
                              !(
                                s.driveId === source.driveId &&
                                s.itemId === source.itemId
                              ),
                          ),
                        )
                      }
                      className="shrink-0 text-gray-400 hover:text-red-600"
                    >
                      <IconX size={14} />
                    </button>
                  </div>
                  <M365SourcePlanView
                    kind={source.kind}
                    selection={{
                      recursive: source.recursive,
                      excludedItemIds: source.excludedItemIds,
                      includeExtensions: source.includeExtensions,
                    }}
                    plan={planBySourceKey.get(sourceKey(source))}
                    loading={planLoading}
                    manifestSource={
                      source.persisted
                        ? manifestBySourceId.get(source.persisted.sourceId)
                        : undefined
                    }
                    onChange={(patch) => updateSelection(source, patch)}
                  />
                </li>
              ))}
            </ul>
          )}
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

      <M365FilePickerModal
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={addSource}
      />
    </div>
  );
};

interface M365AgentsSectionProps {
  /** Rules from the panel's rules query — reused for the access pill/editor. */
  rules: AdminStoredRule[];
  /** Invalidate shared panel data (rules + discovery) after a change. */
  onDataChanged: () => void;
}

/**
 * The M365 file-backed agents block inside the agents admin section:
 * create/edit/delete + per-agent Index action + the standard RuleEditor
 * over `m365-agent::<id>` keys.
 */
export const M365AgentsSection: FC<M365AgentsSectionProps> = ({
  rules,
  onDataChanged,
}) => {
  const t = useTranslations('agentAccess');
  const queryClient = useQueryClient();
  const { agentsEnabled } = useM365Enabled();
  const [isCreating, setIsCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingRuleKey, setEditingRuleKey] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const agentsQuery = useQuery<AdminM365AgentsResponse>({
    queryKey: ['agent-access-m365-agents'],
    queryFn: async () => {
      const response = await fetch('/api/agent-access/m365-agents');
      if (!response.ok) {
        throw new Error(`Failed to fetch m365 agents: ${response.status}`);
      }
      return unwrapApiData<AdminM365AgentsResponse>(await response.json());
    },
    retry: 1,
    refetchOnWindowFocus: false,
    enabled: agentsEnabled,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: ['agent-access-m365-agents'],
    });
    onDataChanged();
  };

  const rulesByKey = useMemo(
    () => new Map(rules.map((rule) => [rule.canonicalKey, rule])),
    [rules],
  );

  const indexMutation = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch('/api/agent-access/m365-agents/index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || `Indexing failed (${response.status})`);
      }
      return response.json() as Promise<{
        data?: {
          outcomes?: {
            sourceId: string;
            status: string;
            indexedChunks: number;
            error?: string;
          }[];
        };
      }>;
    },
    onSuccess: (result) => {
      // The route returns 200 for the RUN completing — individual sources
      // can still have failed. A success toast on a failed run is a lie
      // the admin acts on; report per-source outcomes honestly.
      const outcomes = result.data?.outcomes ?? [];
      const failed = outcomes.filter((o) => o.status !== 'indexed');
      if (failed.length > 0) {
        toast.error(
          t('m365AgentIndexPartialFailure', {
            failed: failed.length,
            count: outcomes.length,
            error: failed[0].error ?? '',
          }),
        );
      } else {
        toast.success(t('m365AgentIndexSuccess'));
      }
      invalidate();
    },
    onError: (error: Error) => {
      toast.error(error.message || t('m365AgentIndexFailed'));
      invalidate();
    },
  });

  const handleDelete = async (entry: AdminStoredM365Agent) => {
    setConfirmDeleteId(null);
    const response = await fetch(
      `/api/agent-access/m365-agents?id=${encodeURIComponent(entry.agent.id)}`,
      { method: 'DELETE', headers: { 'If-Match': entry.etag } },
    );
    if (response.ok || response.status === 404) {
      toast.success(t('m365AgentDeleteSuccess'));
    } else {
      toast.error(t('saveError'));
    }
    invalidate();
  };

  if (!agentsEnabled) return null;

  const agents = agentsQuery.data?.m365Agents ?? [];
  const maxDocuments = agentsQuery.data?.maxDocuments ?? DEFAULT_MAX_SOURCES;
  const maxBytes = agentsQuery.data?.maxBytes ?? DEFAULT_MAX_BYTES;

  return (
    <div className="mt-6 border-t border-gray-200 pt-4 dark:border-gray-700">
      <div className="mb-2 flex items-center gap-2">
        <IconBrandOnedrive size={18} className="text-blue-500" />
        <h3 className="text-sm font-semibold text-black dark:text-white">
          {t('m365AgentsHeading')}
        </h3>
      </div>
      <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
        {t('m365AgentsDescription')}
      </p>

      <button
        type="button"
        aria-expanded={isCreating}
        onClick={() => setIsCreating((creating) => !creating)}
        className="mb-3 flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-black hover:bg-gray-100 dark:border-gray-700 dark:text-white dark:hover:bg-gray-800"
      >
        <IconPlus size={16} />
        {t('addM365Agent')}
      </button>

      {isCreating && (
        <div className="mb-4">
          <M365AgentEditor
            existing={null}
            maxSources={maxDocuments}
            maxBytes={maxBytes}
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

      {agentsQuery.data?.m365AgentsUnavailable && (
        <p className="mb-2 text-xs text-amber-700 dark:text-amber-400">
          {t('m365AgentsUnavailableWarning')}
        </p>
      )}

      {agents.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('noM365Agents')}
        </p>
      ) : (
        <ul className="space-y-2">
          {agents.map((entry) => {
            const stored = rulesByKey.get(entry.canonicalKey) ?? null;
            const isRestricted = stored?.rule.access.type === 'restricted';
            const sources = entry.agent.sources;
            // Content-bearing = indexed with chunks (undefined = legacy
            // record from before chunk counts, trust the status).
            const contentSources = sources.filter(
              (s) => s.status === 'indexed' && (s.indexedChunks ?? 1) > 0,
            ).length;
            const unindexedSources = sources.filter(
              (s) => s.status !== 'indexed',
            ).length;
            // "Indexed" with zero chunks means extraction found no text
            // (e.g. a scanned PDF without a text layer) — a silently empty
            // agent unless surfaced here.
            const emptySources = sources.filter(
              (s) => s.status === 'indexed' && (s.indexedChunks ?? 0) === 0,
            ).length;
            const firstSourceError = sources.find((s) => s.error)?.error;
            // Seventh-pass per-document counts (absent on records that were
            // never indexed under the planner).
            const docCounts = sources.reduce(
              (acc, s) => {
                if (!s.counts) return acc;
                acc.present = true;
                acc.indexed += s.counts.indexed ?? 0;
                acc.failed += (s.counts.failed ?? 0) + (s.counts.missing ?? 0);
                acc.noText += s.counts.noText ?? 0;
                acc.needsPreparation += s.counts.needsPreparation;
                acc.skipped += s.counts.skipped;
                return acc;
              },
              {
                present: false,
                indexed: 0,
                failed: 0,
                noText: 0,
                needsPreparation: 0,
                skipped: 0,
              },
            );
            const lastIndexedAt = sources
              .map((s) => s.lastIndexedAt)
              .filter((d): d is string => !!d)
              .sort()
              .at(-1);
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
                      <span className="shrink-0 rounded-full bg-sky-100 px-2 py-0.5 text-xs text-sky-800 dark:bg-sky-900/30 dark:text-sky-300">
                        {t('m365AgentBadge')}
                      </span>
                    </div>
                    {contentSources === 0 ? (
                      <p className="text-xs font-medium text-red-700 dark:text-red-400">
                        {t('m365AgentStatusNotIndexed')}
                      </p>
                    ) : contentSources < sources.length ? (
                      <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
                        {t('m365AgentStatusPartial', {
                          indexed: contentSources,
                          count: sources.length,
                        })}
                      </p>
                    ) : (
                      <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                        {t('m365AgentSourceSummary', {
                          count: sources.length,
                          pending: unindexedSources,
                        })}
                      </p>
                    )}
                    {docCounts.present && (
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {t('m365AgentDocCounts', {
                          indexed: docCounts.indexed,
                          failed: docCounts.failed,
                          noText: docCounts.noText,
                          needsPreparation: docCounts.needsPreparation,
                          skipped: docCounts.skipped,
                        })}
                      </p>
                    )}
                    {lastIndexedAt && (
                      <p className="text-xs text-gray-400 dark:text-gray-500">
                        {t('m365AgentLastIndexed', {
                          date: new Date(lastIndexedAt).toLocaleString(),
                        })}
                      </p>
                    )}
                    {firstSourceError && (
                      <p
                        className="truncate text-xs text-red-600 dark:text-red-400"
                        title={firstSourceError}
                      >
                        {firstSourceError}
                      </p>
                    )}
                    {emptySources > 0 && (
                      <p className="text-xs text-amber-700 dark:text-amber-400">
                        {t('m365AgentEmptySourcesWarning', {
                          count: emptySources,
                        })}
                      </p>
                    )}
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
                    disabled={indexMutation.isPending}
                    onClick={() => indexMutation.mutate(entry.agent.id)}
                    className="flex shrink-0 items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-sm text-black hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-white dark:hover:bg-gray-800"
                    title={t('m365AgentIndexHint')}
                  >
                    <IconRefresh
                      size={14}
                      className={indexMutation.isPending ? 'animate-spin' : ''}
                    />
                    {t('m365AgentIndex')}
                  </button>
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

                {confirmDeleteId === entry.agent.id && (
                  <div className="mt-2 flex items-center justify-between rounded-md bg-red-50 p-2 text-sm text-red-800 dark:bg-red-900/20 dark:text-red-300">
                    <span>{t('m365AgentDeleteConfirm')}</span>
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
                          CLIENT_M365_AGENT_SOURCE,
                          entry.agent.id,
                        ),
                        source: CLIENT_M365_AGENT_SOURCE,
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
                  <M365AgentEditor
                    key={`${entry.agent.id}:${entry.etag}`}
                    existing={entry}
                    maxSources={maxDocuments}
                    maxBytes={maxBytes}
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
