'use client';

import {
  IconAlertTriangle,
  IconBrandOnedrive,
  IconChevronDown,
  IconChevronRight,
  IconFile,
  IconFolder,
  IconPlayerPause,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FC, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';
import { useHiddenAdminAgents } from '@/client/hooks/useHiddenAdminAgents';
import { useM365Enabled } from '@/client/hooks/useM365Enabled';

import type {
  M365AgentManifest,
  M365AgentSource,
} from '@/lib/services/agentAccess/types';

import { isModelSelectableInRegion } from '@/lib/utils/shared/modelRegion';

import type { M365DriveEntry } from '@/types/m365';
import { OpenAIModels } from '@/types/openai';

import M365FilePickerModal from '@/components/Chat/ChatInput/M365FilePickerModal';

import { CanonicalKeyChip } from './CanonicalKeyChip';
import { ConflictDiff, ConflictDiffRow } from './ConflictDiff';
import {
  HiddenBadge,
  HideAgentButton,
  ShowHiddenToggle,
} from './HiddenAgentsControls';
import {
  DEFAULT_AUTO_OCR_MAX_PAGES_PER_FILE,
  DEFAULT_OCR_MAX_PAGES,
  M365PrepareAllButton,
  M365SourcePlanView,
  SourceSelection,
  formatBytes,
  ocrNoteFor,
  selectUnpreparedScannedPdfs,
} from './M365SourcePlanView';
import { RuleEditor } from './RuleEditor';
import {
  AdminM365AgentsResponse,
  AdminStoredM365Agent,
  AdminStoredRule,
  CLIENT_M365_AGENT_SOURCE,
  ClientAgentPlan,
  ClientIndexJobSummary,
  ClientRefreshPreview,
  ClientSourcePlan,
  clientCanonicalAgentKey,
} from './types';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { useUIStore } from '@/client/stores/uiStore';
import { M365_AGENT_ACCEPT_EXTENSIONS } from '@/lib/constants/m365AgentFileTypes';

type M365AgentRecord = AdminStoredM365Agent['agent'];

/**
 * The two Graph failures an admin can only fix outside this page: no
 * usable session (refresh token gone — sign out and back in) or the tenant
 * consent gap. Every plan/index/step response can carry them; the section
 * turns them into one persistent notice instead of a bare toast.
 */
type M365SessionProblem = 'not_connected' | 'consent_missing';

function m365SessionProblemFromCode(
  code: string | undefined,
): M365SessionProblem | null {
  if (code === 'M365_NOT_CONNECTED') return 'not_connected';
  if (code === 'M365_CONSENT_MISSING') return 'consent_missing';
  return null;
}

/** Error shape thrown by the fetch helpers below (status + API code). */
interface ApiCallError extends Error {
  code?: string;
  status?: number;
}

function apiCallError(
  message: string,
  status: number,
  code?: string,
): ApiCallError {
  const error = new Error(message) as ApiCallError;
  error.status = status;
  error.code = code;
  return error;
}

/**
 * A step/status call worth retrying: the browser lost the network, the
 * route timed out or the ingress answered 5xx, or Graph throttled (429).
 * 4xx other than 429 are decisions (not connected, not authorised, job
 * gone) and must surface immediately.
 */
function isRetryableStepError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as ApiCallError).status;
  if (status === undefined) return true; // fetch threw: network/abort
  return status === 429 || status >= 500;
}

/** Retry schedule for a lost step call (design §4: the browser is the runner). */
const STEP_RETRY_DELAYS_MS = [2000, 4000, 8000];

/**
 * Amber notice for a session/consent problem with the same "open
 * Settings › Connections" exit the file picker uses (there is no section
 * deep link; the label names the section).
 */
const M365SessionProblemNotice: FC<{
  problem: M365SessionProblem | 'disconnected';
  detail?: string;
}> = ({ problem, detail }) => {
  const t = useTranslations('agentAccess');
  const setIsSettingsOpen = useUIStore((s) => s.setIsSettingsOpen);
  const message =
    problem === 'not_connected'
      ? t('m365SessionNotConnected')
      : problem === 'consent_missing'
        ? t('m365SessionConsentMissing')
        : t('m365SessionDisconnected');
  return (
    <div
      role="status"
      className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300"
    >
      <IconAlertTriangle size={14} className="shrink-0" />
      <span className="min-w-0 flex-1">
        {message}
        {detail && (
          <span className="block text-amber-700/80 dark:text-amber-400/80">
            {detail}
          </span>
        )}
      </span>
      <button
        type="button"
        onClick={() => setIsSettingsOpen(true)}
        className="shrink-0 rounded-md border border-amber-300 px-2 py-0.5 font-medium hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900/40"
      >
        {t('m365OpenConnections')}
      </button>
    </div>
  );
};

/**
 * "N files need attention" on an agent row: the per-file reasons from the
 * last run (failed / no text / skipped) without opening the editor. The
 * manifest is fetched only when expanded — one request per row would not
 * scale, and most rows never need it.
 */
const M365AttentionFiles: FC<{
  agentId: string;
  count: number;
  /** Items already reported on a source line — not repeated here. */
  excludeItemIds?: readonly string[];
  ocrMaxPages: number;
  autoOcrMaxPagesPerFile: number;
  /** Batch preparation finished with at least one prepared file. */
  onPrepared?: () => void;
}> = ({
  agentId,
  count,
  excludeItemIds = [],
  ocrMaxPages,
  autoOcrMaxPagesPerFile,
  onPrepared,
}) => {
  const t = useTranslations('agentAccess');
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const manifestQuery = useQuery<M365AgentManifest | null>({
    queryKey: ['agent-access-m365-agent-manifest', agentId],
    queryFn: async () => {
      const response = await fetch(
        `/api/agent-access/m365-agents/manifest?id=${encodeURIComponent(agentId)}`,
      );
      if (!response.ok) throw new Error(`manifest ${response.status}`);
      const data = unwrapApiData<{ manifest: M365AgentManifest | null }>(
        await response.json(),
      );
      return data?.manifest ?? null;
    },
    enabled: expanded,
    retry: 0,
    refetchOnWindowFocus: false,
  });
  const excluded = useMemo(() => new Set(excludeItemIds), [excludeItemIds]);
  const rows = useMemo(() => {
    const out: { key: string; name: string; note: string }[] = [];
    for (const source of manifestQuery.data?.sources ?? []) {
      for (const item of source.items) {
        // A single-file source already shows this item's error on its
        // own line — listing it twice reads as two problems.
        if (excluded.has(item.itemId)) continue;
        const name = item.path ? `${item.path}/${item.name}` : item.name;
        if (item.status === 'failed' || item.status === 'missing') {
          out.push({
            key: `${source.sourceId}:${item.itemId}`,
            name,
            note: item.error
              ? `${t(`m365ItemStatus.${item.status}`)} — ${item.error}`
              : t(`m365ItemStatus.${item.status}`),
          });
        } else if (item.status === 'noText') {
          const ocrNote = ocrNoteFor(item, t, autoOcrMaxPagesPerFile);
          out.push({
            key: `${source.sourceId}:${item.itemId}`,
            name,
            note:
              ocrNote ??
              (item.name.toLowerCase().endsWith('.pdf')
                ? t('m365ItemNoTextOcr')
                : t('m365ItemStatus.noText')),
          });
        } else if (item.tier === 'skipped') {
          out.push({
            key: `${source.sourceId}:${item.itemId}`,
            name,
            note: t(`m365SkipReason.${item.reason ?? 'unsupported'}`),
          });
        }
      }
    }
    return out;
  }, [manifestQuery.data, excluded, autoOcrMaxPagesPerFile, t]);
  // Scanned PDFs still awaiting OCR — the batch Prepare action's input.
  const scannedPdfs = useMemo(
    () =>
      selectUnpreparedScannedPdfs(
        (manifestQuery.data?.sources ?? []).flatMap((source) => source.items),
      ),
    [manifestQuery.data],
  );
  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="flex items-center gap-0.5 text-amber-700 hover:underline dark:text-amber-400"
      >
        {expanded ? (
          <IconChevronDown size={12} />
        ) : (
          <IconChevronRight size={12} />
        )}
        {t('m365AgentAttentionFiles', { count })}
      </button>
      {expanded && (
        <div className="mt-1 rounded-md border border-gray-200 p-2 dark:border-gray-700">
          {manifestQuery.isLoading ? (
            <p className="text-gray-500 dark:text-gray-400">
              {t('m365AgentAttentionLoading')}
            </p>
          ) : manifestQuery.isError ? (
            <p className="text-red-600 dark:text-red-400">
              {t('m365AgentAttentionFailed')}
            </p>
          ) : (
            <>
              <ul className="max-h-48 space-y-1 overflow-y-auto">
                {rows.map((row) => (
                  <li
                    key={row.key}
                    className="flex flex-col text-gray-800 dark:text-gray-200"
                  >
                    {/* Name and reason on their own lines: side by side, a
                        long reason squeezed the name to nothing. */}
                    <span
                      className="min-w-0 truncate font-medium"
                      title={row.name}
                    >
                      {row.name}
                    </span>
                    <span className="break-words text-red-600 dark:text-red-400">
                      {row.note}
                    </span>
                  </li>
                ))}
                {rows.length === 0 && (
                  <li className="text-gray-500 dark:text-gray-400">
                    {t('m365AgentAttentionNone')}
                  </li>
                )}
              </ul>
              {scannedPdfs.length > 0 && (
                <div className="mt-2">
                  <M365PrepareAllButton
                    agentId={agentId}
                    items={scannedPdfs}
                    ocrMaxPages={ocrMaxPages}
                    onDone={(result) => {
                      void queryClient.invalidateQueries({
                        queryKey: ['agent-access-m365-agent-manifest', agentId],
                      });
                      if (result.prepared > 0) {
                        toast.success(
                          t('m365PrepareAllDone', {
                            prepared: result.prepared,
                            total: result.total,
                          }),
                        );
                        onPrepared?.();
                      }
                    }}
                  />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

const AGENT_MODEL_ID_PREFIXES = ['foundry-', 'org-', 'custom-', 'byom-'];
/**
 * Fallback while the listing (which serves the env-configured cap) hasn't
 * loaded — matches the server's M365_AGENT_MAX_DOCUMENTS default.
 */
const DEFAULT_MAX_SOURCES = 50;
/** Fallback for the byte budget (M365_AGENT_MAX_SOURCE_MB default). */
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
/** Auto-OCR per-run page budget default (env M365_AGENT_AUTO_OCR_MAX_PAGES_PER_RUN). */
const DEFAULT_AUTO_OCR_MAX_PAGES_PER_RUN = 200;
/** Selection edits re-plan after this pause (metadata calls only). */
const PLAN_DEBOUNCE_MS = 400;
/**
 * When a step returns without progress (another admin's browser holds
 * the in-flight claims), wait this long before stepping again.
 */
const STEP_IDLE_RETRY_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJobResponse(
  response: Response,
): Promise<ClientIndexJobSummary> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw apiCallError(
      body?.error || `Indexing request failed (${response.status})`,
      response.status,
      body?.code,
    );
  }
  const job = unwrapApiData<{ job: ClientIndexJobSummary | null }>(body)?.job;
  if (!job) throw new Error('No job in response');
  return job;
}

/**
 * One step call with the retry schedule above. Gives up on the first
 * non-retryable error, or after the schedule is exhausted — the caller
 * then tells the admin the job is still on the server, not "failed".
 */
async function stepWithRetry(
  agentId: string,
  jobId: string,
  isCancelled: () => boolean,
): Promise<ClientIndexJobSummary> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch('/api/agent-access/m365-agents/index/step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: agentId, jobId }),
      });
      return await readJobResponse(response);
    } catch (error) {
      if (
        !isRetryableStepError(error) ||
        attempt >= STEP_RETRY_DELAYS_MS.length ||
        isCancelled()
      ) {
        throw error;
      }
      await sleep(STEP_RETRY_DELAYS_MS[attempt]);
    }
  }
}

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
  /** OCR page caps (from the listing response), for copy and Prepare-all. */
  ocrMaxPages: number;
  autoOcrMaxPagesPerRun: number;
  autoOcrMaxPagesPerFile: number;
  /** Starts an index job for the agent being edited (existing agents). */
  onStartIndex?: (mode: 'full' | 'refresh') => void;
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
  ocrMaxPages,
  autoOcrMaxPagesPerRun,
  autoOcrMaxPagesPerFile,
  onStartIndex,
  onSaved,
  onCancel,
  onConflictReload,
}) => {
  const t = useTranslations('agentAccess');
  const models = useSettingsStore((s) => s.models);
  const userRegion = useSettingsStore((s) => s.userRegion);
  // Client-side off switch (Settings › Connections). Planning and indexing
  // run with the admin's own Graph token, so a disconnected admin can edit
  // metadata but cannot add or scan sources.
  const m365Connected = useSettingsStore((s) => s.m365Connected);

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
  // Off by default: OCR is billed per page, so it is an explicit opt-in.
  const [autoOcr, setAutoOcr] = useState(existing?.agent.autoOcr ?? false);
  const [sources, setSources] = useState<EditorSource[]>(
    (existing?.agent.sources ?? []).map(toEditorSource),
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  /** Plan for the CURRENT selection (design §1); null until the first run. */
  const [plan, setPlan] = useState<ClientAgentPlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  /**
   * A plan failure the admin must fix outside the editor (no M365 session /
   * consent gap). Blocks Save: the server skips the cap check on a Graph
   * failure, so saving now would only defer the same error to Index.
   */
  const [planProblem, setPlanProblem] = useState<M365SessionProblem | null>(
    null,
  );
  const planRequest = useRef(0);
  /** Bumped when a file is prepared so the plan re-runs unchanged sources. */
  const [planVersion, setPlanVersion] = useState(0);

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
  // Change detection on open (design §7): what a refresh would do, from
  // the stored delta links — metadata only, nothing is indexed here.
  const changesQuery = useQuery<ClientRefreshPreview | null>({
    queryKey: ['agent-access-m365-agent-changes', existing?.agent.id],
    queryFn: async () => {
      const response = await fetch(
        `/api/agent-access/m365-agents/changes?id=${encodeURIComponent(existing!.agent.id)}`,
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || t('m365ChangesFailed'));
      }
      return unwrapApiData<ClientRefreshPreview>(await response.json()) ?? null;
    },
    enabled: existing !== null,
    retry: 0,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  const changeTotal = changesQuery.data?.preview
    ? changesQuery.data.preview.changes.added +
      changesQuery.data.preview.changes.modified +
      changesQuery.data.preview.changes.removed
    : 0;

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
      setPlanProblem(null);
      return;
    }
    const requestId = ++planRequest.current;
    const timer = setTimeout(async () => {
      setPlanLoading(true);
      try {
        const response = await fetch('/api/agent-access/m365-agents/plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sources: sources.map(toSourcePayload),
            ...(existing ? { agentId: existing.agent.id } : {}),
          }),
        });
        if (requestId !== planRequest.current) return;
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          // A failed re-plan must not leave the previous selection's cap
          // numbers on screen next to the error.
          setPlan(null);
          setPlanProblem(m365SessionProblemFromCode(body?.code));
          setPlanError(body?.error || t('m365PlanFailed'));
          return;
        }
        const data = unwrapApiData<ClientAgentPlan>(await response.json());
        setPlan(data ?? null);
        setPlanError(null);
        setPlanProblem(null);
      } catch {
        if (requestId === planRequest.current) {
          setPlan(null);
          setPlanProblem(null);
          setPlanError(t('m365PlanFailed'));
        }
      } finally {
        if (requestId === planRequest.current) setPlanLoading(false);
      }
    }, PLAN_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey, planVersion]);

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
    planProblem === null &&
    conflict === null;

  /** Unsaved edits relative to the stored record (new agents: anything typed). */
  const isDirty = existing
    ? name.trim() !== existing.agent.name ||
      description.trim() !== existing.agent.description ||
      systemPrompt.trim() !== existing.agent.systemPrompt ||
      (chatModelId || null) !== (existing.agent.chatModelId ?? null) ||
      autoOcr !== (existing.agent.autoOcr ?? false) ||
      JSON.stringify(sources.map(toSourcePayload)) !==
        JSON.stringify(
          existing.agent.sources.map(toEditorSource).map(toSourcePayload),
        )
    : name.trim().length > 0 || sources.length > 0;

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
          autoOcr,
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
        <div>
          <label className="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              checked={autoOcr}
              onChange={(e) => setAutoOcr(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-blue-600"
            />
            <span className="font-semibold">{t('m365AgentAutoOcrLabel')}</span>
          </label>
          <p className="ml-6 mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t('m365AgentAutoOcrHelp', {
              perRun: autoOcrMaxPagesPerRun,
              perFile: autoOcrMaxPagesPerFile,
            })}
          </p>
        </div>

        {existing && (
          <div
            className={`rounded-md px-2 py-1.5 text-xs ${
              changeTotal > 0
                ? 'bg-amber-50 text-amber-800 dark:bg-amber-900/20 dark:text-amber-300'
                : 'bg-gray-50 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
            }`}
          >
            {changesQuery.isLoading ? (
              t('m365ChangesChecking')
            ) : changesQuery.isError ? (
              <span className="text-amber-700 dark:text-amber-400">
                {changesQuery.error instanceof Error
                  ? changesQuery.error.message
                  : t('m365ChangesFailed')}
              </span>
            ) : !changesQuery.data?.preview ? (
              t('m365ChangesNeverIndexed')
            ) : (
              <span className="flex flex-wrap items-center gap-2">
                <span>
                  {changeTotal > 0
                    ? t('m365ChangesFound', {
                        count: changeTotal,
                        added: changesQuery.data.preview.changes.added,
                        modified: changesQuery.data.preview.changes.modified,
                        removed: changesQuery.data.preview.changes.removed,
                      })
                    : t('m365ChangesNone', {
                        date: changesQuery.data.lastIndexedAt
                          ? new Date(
                              changesQuery.data.lastIndexedAt,
                            ).toLocaleString()
                          : '',
                      })}
                </span>
                {changeTotal > 0 && onStartIndex && (
                  <button
                    type="button"
                    disabled={!m365Connected}
                    title={
                      !m365Connected
                        ? t('m365ActionNeedsConnection')
                        : undefined
                    }
                    onClick={() => {
                      // Refresh runs against the STORED record and closes
                      // the editor — never silently drop a draft.
                      if (
                        isDirty &&
                        !window.confirm(t('m365AgentDiscardEditsConfirm'))
                      ) {
                        return;
                      }
                      onStartIndex('refresh');
                      onCancel();
                    }}
                    className="rounded-md border border-amber-300 px-2 py-0.5 font-medium hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900/40"
                  >
                    {t('m365AgentRefresh')}
                  </button>
                )}
              </span>
            )}
          </div>
        )}

        {/* Sources */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">
              {t('m365AgentSources')} ({sources.length})
            </span>
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              // The cap is per DOCUMENT (the meter below); the source count
              // is only a coarse guard against pathological lists.
              disabled={sources.length >= maxSources || !m365Connected}
              title={
                !m365Connected
                  ? t('m365ActionNeedsConnection')
                  : sources.length >= maxSources
                    ? t('m365AgentTooManySources', { max: maxSources })
                    : undefined
              }
              className="flex items-center gap-1 rounded-md border border-neutral-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-40 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-700"
            >
              <IconPlus size={14} /> {t('m365AgentAddSource')}
            </button>
          </div>
          <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
            {t('m365AgentSourcesHelp')}
          </p>
          {!m365Connected && (
            <M365SessionProblemNotice problem="disconnected" />
          )}
          {planProblem && (
            <M365SessionProblemNotice
              problem={planProblem}
              detail={planError ?? undefined}
            />
          )}
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
              {planError && !planProblem && (
                <p className="mt-1 text-amber-700 dark:text-amber-400">
                  {planError}
                  <span className="block text-gray-600 dark:text-gray-400">
                    {t('m365PlanFailedSaveAnyway')}
                  </span>
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
                    agentId={existing?.agent.id}
                    onPrepared={() => setPlanVersion((v) => v + 1)}
                    ocrMaxPages={ocrMaxPages}
                    autoOcrMaxPagesPerFile={autoOcrMaxPagesPerFile}
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
        // Files the index run cannot use stay visible but inert, so an
        // admin never adds a source that can only end up "skipped".
        acceptExtensions={M365_AGENT_ACCEPT_EXTENSIONS}
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
  const m365Connected = useSettingsStore((s) => s.m365Connected);
  /**
   * Last session/consent failure reported by an index/step/status call —
   * shown as one persistent notice above the list until a call succeeds.
   */
  const [sessionProblem, setSessionProblem] = useState<{
    problem: M365SessionProblem;
    detail?: string;
  } | null>(null);
  /**
   * Agents whose job reached a terminal state in THIS tab: the row keeps a
   * visibility verdict ("now visible" / "still hidden") after the toast is
   * gone, computed from the refreshed record so it reflects what discovery
   * will actually serve.
   */
  const [finishedIds, setFinishedIds] = useState<Set<string>>(new Set());
  const [isCreating, setIsCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingRuleKey, setEditingRuleKey] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const hiddenAgents = useHiddenAdminAgents();
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

  /**
   * Live job view per agent: seeded from the listing, then updated by the
   * step loop this browser drives (design §4 — the admin's browser is the
   * job runner because Graph tokens exist only in their session).
   */
  const [jobs, setJobs] = useState<Record<string, ClientIndexJobSummary>>({});
  const [drivingIds, setDrivingIds] = useState<Set<string>>(new Set());
  const drivingRef = useRef(new Set<string>());
  const unmountedRef = useRef(false);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);
  useEffect(() => {
    const listed = agentsQuery.data?.jobs;
    if (!listed) return;
    setJobs((prev) => {
      const next = { ...prev };
      for (const [agentId, job] of Object.entries(listed)) {
        const local = prev[agentId];
        if (!local || local.updatedAt <= job.updatedAt) next[agentId] = job;
      }
      return next;
    });
  }, [agentsQuery.data?.jobs]);

  const setDriving = (agentId: string, on: boolean) => {
    if (on) drivingRef.current.add(agentId);
    else drivingRef.current.delete(agentId);
    setDrivingIds(new Set(drivingRef.current));
  };

  const reportTerminal = (job: ClientIndexJobSummary) => {
    if (job.status === 'succeeded') {
      const fn = job.failed + job.missing > 0 ? toast.error : toast.success;
      fn(
        job.mode === 'refresh' && job.changes
          ? t('m365AgentRefreshDone', {
              added: job.changes.added,
              modified: job.changes.modified,
              removed: job.changes.removed,
              failed: job.failed + job.missing,
            })
          : t('m365AgentIndexDone', {
              indexed: job.indexed,
              failed: job.failed + job.missing,
              noText: job.noText,
            }),
      );
    } else if (job.status === 'failed') {
      toast.error(t('m365AgentIndexJobFailed', { error: job.error ?? '' }));
    } else if (job.status === 'cancelled') {
      toast(t('m365AgentIndexCancelled'));
    }
  };

  /**
   * Turns a failed index/step/status call into the right signal: a
   * session/consent problem becomes the persistent notice, anything else a
   * toast. Returns true when the error was a session problem.
   */
  const reportCallError = (error: unknown, fallbackKey: string): boolean => {
    const code =
      error instanceof Error ? (error as ApiCallError).code : undefined;
    const problem = m365SessionProblemFromCode(code);
    if (problem) {
      setSessionProblem({
        problem,
        detail: error instanceof Error ? error.message : undefined,
      });
      return true;
    }
    toast.error(error instanceof Error ? error.message : t(fallbackKey));
    return false;
  };

  const stepUntilDone = async (agentId: string, jobId: string) => {
    if (drivingRef.current.has(agentId)) return;
    setDriving(agentId, true);
    try {
      let lastDone = -1;
      for (;;) {
        if (unmountedRef.current) return;
        const job = await stepWithRetry(
          agentId,
          jobId,
          () => unmountedRef.current,
        );
        setSessionProblem(null);
        setJobs((prev) => ({ ...prev, [agentId]: job }));
        if (job.status !== 'running') {
          reportTerminal(job);
          setFinishedIds((prev) => new Set(prev).add(agentId));
          invalidate();
          return;
        }
        if (job.done === lastDone) await sleep(STEP_IDLE_RETRY_MS);
        lastDone = job.done;
      }
    } catch (error) {
      if (unmountedRef.current) return;
      if (isRetryableStepError(error)) {
        // Retries exhausted: the job record is on the server with its
        // outcomes so far — say so, and leave Resume as the way back.
        toast.error(t('m365AgentIndexStepLost'));
      } else {
        reportCallError(error, 'm365AgentIndexFailed');
      }
      invalidate();
    } finally {
      setDriving(agentId, false);
    }
  };

  const startIndex = async (
    agentId: string,
    mode: 'full' | 'refresh' = 'full',
  ) => {
    try {
      const response = await fetch('/api/agent-access/m365-agents/index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: agentId, mode }),
      });
      let job: ClientIndexJobSummary;
      try {
        job = await readJobResponse(response);
      } catch (error) {
        if ((error as { code?: string }).code !== 'M365_INDEX_JOB_ACTIVE') {
          throw error;
        }
        // Someone else's job is live — join it instead of failing.
        job = await readJobResponse(
          await fetch(
            `/api/agent-access/m365-agents/index/status?id=${encodeURIComponent(agentId)}`,
          ),
        );
      }
      setSessionProblem(null);
      setFinishedIds((prev) => {
        if (!prev.has(agentId)) return prev;
        const next = new Set(prev);
        next.delete(agentId);
        return next;
      });
      setJobs((prev) => ({ ...prev, [agentId]: job }));
      invalidate();
      if (job.status === 'running') await stepUntilDone(agentId, job.jobId);
    } catch (error) {
      reportCallError(error, 'm365AgentIndexFailed');
      invalidate();
    }
  };

  const cancelIndex = async (agentId: string, jobId: string) => {
    try {
      const response = await fetch(
        '/api/agent-access/m365-agents/index/cancel',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: agentId, jobId }),
        },
      );
      const job = await readJobResponse(response);
      setJobs((prev) => ({ ...prev, [agentId]: job }));
      reportTerminal(job);
    } catch (error) {
      reportCallError(error, 'm365AgentIndexFailed');
    }
    invalidate();
  };

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
  const { visible: visibleAgents, hiddenCount } = hiddenAgents.partition(
    agents,
    (entry) => entry.canonicalKey,
  );
  const maxDocuments = agentsQuery.data?.maxDocuments ?? DEFAULT_MAX_SOURCES;
  const maxBytes = agentsQuery.data?.maxBytes ?? DEFAULT_MAX_BYTES;
  const ocrMaxPages = agentsQuery.data?.ocrMaxPages ?? DEFAULT_OCR_MAX_PAGES;
  const autoOcrMaxPagesPerRun =
    agentsQuery.data?.autoOcrMaxPagesPerRun ??
    DEFAULT_AUTO_OCR_MAX_PAGES_PER_RUN;
  const autoOcrMaxPagesPerFile =
    agentsQuery.data?.autoOcrMaxPagesPerFile ??
    DEFAULT_AUTO_OCR_MAX_PAGES_PER_FILE;

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
            ocrMaxPages={ocrMaxPages}
            autoOcrMaxPagesPerRun={autoOcrMaxPagesPerRun}
            autoOcrMaxPagesPerFile={autoOcrMaxPagesPerFile}
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
      {/* Indexing runs with THIS admin's Graph token: a disconnected account
          or a dead session blocks every source action, so say it once, up
          front, with the way out — not as a toast after the click. */}
      {!m365Connected ? (
        <M365SessionProblemNotice problem="disconnected" />
      ) : (
        sessionProblem && (
          <M365SessionProblemNotice
            problem={sessionProblem.problem}
            detail={sessionProblem.detail}
          />
        )
      )}

      <ShowHiddenToggle
        hiddenCount={hiddenCount}
        showHidden={hiddenAgents.showHidden}
        onToggle={hiddenAgents.setShowHidden}
      />
      {visibleAgents.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {agents.length === 0 ? t('noM365Agents') : t('allAgentsHidden')}
        </p>
      ) : (
        <ul className="space-y-2">
          {visibleAgents.map((entry) => {
            const stored = rulesByKey.get(entry.canonicalKey) ?? null;
            const isRestricted = stored?.rule.access.type === 'restricted';
            const sources = entry.agent.sources;
            // Content-bearing = has chunks and is not broken. A legacy
            // `indexed` record without chunk counts is trusted; a record
            // still carrying a transient `indexing`/`pending` status from
            // an older run keeps counting as long as its chunks exist —
            // "6 documents indexed" and "Not indexed" must never both show.
            const contentSources = sources.filter(
              (s) =>
                s.status !== 'error' &&
                s.status !== 'missing' &&
                (s.indexedChunks ?? (s.status === 'indexed' ? 1 : 0)) > 0,
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
            // Every source-level error, with its source, not just the
            // first one — an admin with 6 files needs to know WHICH 2.
            const sourceErrors = sources
              .filter((s) => !!s.error)
              .map((s) => ({ title: s.title, error: s.error as string }));
            const job = jobs[entry.agent.id];
            const jobActive = job?.status === 'running';
            const driving = drivingIds.has(entry.agent.id);
            // Verdict after a job this tab finished, once the refreshed
            // record is in (a stale record would flash the wrong answer).
            const finishedVerdict =
              finishedIds.has(entry.agent.id) &&
              !jobActive &&
              !agentsQuery.isFetching
                ? contentSources > 0
                  ? 'visible'
                  : 'hidden'
                : null;
            const actionDisabledTitle = !m365Connected
              ? t('m365ActionNeedsConnection')
              : undefined;
            // Refresh needs a manifest to diff against; a source that was
            // ever indexed under the planner implies one.
            const hasBeenIndexed = sources.some((s) => !!s.counts);
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
                      <span
                        className="truncate text-sm font-medium text-black dark:text-white"
                        title={entry.agent.name}
                      >
                        {entry.agent.name}
                      </span>
                      <span className="shrink-0 rounded-full bg-sky-100 px-2 py-0.5 text-xs text-sky-800 dark:bg-sky-900/30 dark:text-sky-300">
                        {t('m365AgentBadge')}
                      </span>
                    </div>
                    <CanonicalKeyChip canonicalKey={entry.canonicalKey} />
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
                    {jobActive && (
                      <p
                        className={`flex items-center gap-1 text-xs font-medium ${
                          job.stale && !driving
                            ? 'text-amber-700 dark:text-amber-400'
                            : 'text-blue-700 dark:text-blue-400'
                        }`}
                      >
                        {driving && (
                          <IconRefresh size={12} className="animate-spin" />
                        )}
                        {job.stale && !driving
                          ? t('m365AgentIndexInterrupted', {
                              done: job.done,
                              total: job.total,
                            })
                          : t(
                              job.mode === 'refresh'
                                ? 'm365AgentRefreshProgress'
                                : 'm365AgentIndexProgress',
                              { done: job.done, total: job.total },
                            )}
                        {!driving && (
                          <span className="font-normal text-gray-500 dark:text-gray-400">
                            ·{' '}
                            {t('m365AgentIndexStartedBy', {
                              name: job.startedBy,
                            })}
                          </span>
                        )}
                      </p>
                    )}
                    {job?.status === 'failed' && (
                      <div className="flex items-start gap-2 text-xs text-red-700 dark:text-red-400">
                        <p
                          className="line-clamp-2 min-w-0 break-words"
                          title={job.error}
                        >
                          {t('m365AgentIndexJobFailed', {
                            error: job.error ?? '',
                          })}
                        </p>
                        <button
                          type="button"
                          onClick={() =>
                            void startIndex(entry.agent.id, 'full')
                          }
                          disabled={!m365Connected}
                          className="shrink-0 rounded-md border border-red-300 px-2 py-0.5 font-medium hover:bg-red-50 disabled:opacity-40 dark:border-red-700 dark:hover:bg-red-900/20"
                          title={actionDisabledTitle ?? t('m365AgentIndexHint')}
                        >
                          {t('m365AgentIndexRetry')}
                        </button>
                      </div>
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
                    {finishedVerdict === 'visible' && (
                      <p
                        role="status"
                        className="text-xs font-medium text-green-700 dark:text-green-400"
                      >
                        {t('m365AgentRunVisible')}
                      </p>
                    )}
                    {finishedVerdict === 'hidden' && (
                      <p
                        role="status"
                        className="text-xs font-medium text-red-700 dark:text-red-400"
                      >
                        {t('m365AgentRunHidden')}
                      </p>
                    )}
                    {sourceErrors.length > 0 && (
                      <ul className="text-xs text-red-600 dark:text-red-400">
                        {sourceErrors.map(({ title, error }) => (
                          <li
                            key={`${title}:${error}`}
                            className="line-clamp-2 break-words"
                            title={`${title}: ${error}`}
                          >
                            <span className="font-medium">{title}</span>:{' '}
                            {error}
                          </li>
                        ))}
                      </ul>
                    )}
                    {emptySources > 0 && (
                      <p className="text-xs text-amber-700 dark:text-amber-400">
                        {t('m365AgentEmptySourcesWarning', {
                          count: emptySources,
                        })}
                      </p>
                    )}
                    {docCounts.present &&
                      docCounts.failed + docCounts.noText + docCounts.skipped >
                        0 && (
                        <M365AttentionFiles
                          agentId={entry.agent.id}
                          count={
                            docCounts.failed +
                            docCounts.noText +
                            docCounts.skipped
                          }
                          excludeItemIds={sources
                            .filter((s) => s.kind === 'file' && !!s.error)
                            .map((s) => s.itemId)}
                          ocrMaxPages={ocrMaxPages}
                          autoOcrMaxPagesPerFile={autoOcrMaxPagesPerFile}
                          onPrepared={invalidate}
                        />
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
                  {hiddenAgents.isHidden(entry.canonicalKey) && <HiddenBadge />}
                  <HideAgentButton
                    hidden={hiddenAgents.isHidden(entry.canonicalKey)}
                    onHide={() => hiddenAgents.hide(entry.canonicalKey)}
                    onUnhide={() => hiddenAgents.unhide(entry.canonicalKey)}
                  />
                  {jobActive ? (
                    <>
                      {(!driving || job?.stale) && (
                        <button
                          type="button"
                          onClick={() =>
                            void stepUntilDone(entry.agent.id, job!.jobId)
                          }
                          disabled={!m365Connected}
                          className="flex shrink-0 items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-sm text-black hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-white dark:hover:bg-gray-800"
                          title={
                            actionDisabledTitle ?? t('m365AgentIndexResumeHint')
                          }
                        >
                          <IconRefresh size={14} />
                          {t('m365AgentIndexResume')}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          void cancelIndex(entry.agent.id, job!.jobId)
                        }
                        className="flex shrink-0 items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-sm text-red-700 hover:bg-red-50 dark:border-gray-700 dark:text-red-400 dark:hover:bg-red-900/20"
                      >
                        <IconPlayerPause size={14} />
                        {t('m365AgentIndexCancel')}
                      </button>
                    </>
                  ) : hasBeenIndexed ? (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          void startIndex(entry.agent.id, 'refresh')
                        }
                        disabled={!m365Connected}
                        className="flex shrink-0 items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-sm text-black hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-white dark:hover:bg-gray-800"
                        title={actionDisabledTitle ?? t('m365AgentRefreshHint')}
                      >
                        <IconRefresh size={14} />
                        {t('m365AgentRefresh')}
                      </button>
                      <button
                        type="button"
                        onClick={() => void startIndex(entry.agent.id, 'full')}
                        disabled={!m365Connected}
                        className="shrink-0 rounded-md border border-gray-200 px-2 py-1 text-sm text-gray-600 hover:bg-gray-100 hover:text-black disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-white"
                        title={actionDisabledTitle ?? t('m365AgentIndexHint')}
                      >
                        {t('m365AgentReindexAll')}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void startIndex(entry.agent.id, 'full')}
                      disabled={!m365Connected}
                      className="flex shrink-0 items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-sm text-black hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-white dark:hover:bg-gray-800"
                      title={actionDisabledTitle ?? t('m365AgentIndexHint')}
                    >
                      <IconRefresh size={14} />
                      {t('m365AgentIndex')}
                    </button>
                  )}
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
                    ocrMaxPages={ocrMaxPages}
                    autoOcrMaxPagesPerRun={autoOcrMaxPagesPerRun}
                    autoOcrMaxPagesPerFile={autoOcrMaxPagesPerFile}
                    onStartIndex={(mode) =>
                      void startIndex(entry.agent.id, mode)
                    }
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
