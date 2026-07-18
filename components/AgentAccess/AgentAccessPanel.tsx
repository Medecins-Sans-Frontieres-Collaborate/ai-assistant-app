'use client';

import { IconArrowLeft, IconPlus, IconUserShield } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FC, useMemo, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import {
  unwrapApiData,
  useAgentAccessAdmin,
} from '@/client/hooks/settings/useAgentAccessAdmin';

import { LocalAdminsSection } from './LocalAdminsSection';
import { PromptAgentEditor } from './PromptAgentEditor';
import { RuleEditor } from './RuleEditor';
import {
  AdminPromptAgentsResponse,
  AdminRulesResponse,
  AgentsApiResponse,
  CLIENT_PROMPT_AGENT_SOURCE,
  MergedAgentRow,
  clientCanonicalAgentKey,
} from './types';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { Link } from '@/lib/navigation';

type PanelTab = 'rules' | 'localAdmins';

/**
 * Admin panel for app-layer agent access rules
 * (docs/AGENT_ACCESS_CONTROL.md "Admin UI"). Merges the admin's OWN
 * /api/agents discovery with all stored rules: discovered agents without a
 * rule are implicitly "Everyone"; rules whose agent is outside the admin's
 * discovery get a "not discoverable by you" badge. Local admins only see
 * their delegated canonical keys. The server component gates access — this
 * client is presentation only.
 */
export const AgentAccessPanel: FC = () => {
  const t = useTranslations('agentAccess');
  const queryClient = useQueryClient();
  const {
    me,
    isGlobalAdmin,
    isLoading: isMeLoading,
    error: meError,
    refetch: refetchMe,
  } = useAgentAccessAdmin();

  // The admin's own discovery includes their configured custom sources,
  // mirroring useFoundryAgents — but WITHOUT per-source selection filtering:
  // hidden-from-picker agents are still manageable here.
  const customAgentSources = useSettingsStore((s) => s.customAgentSources);
  const sourcePaths = customAgentSources.map((s) => s.resourcePath);

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

  const agentsQuery = useQuery<AgentsApiResponse>({
    queryKey: ['agent-access-admin-agents', ...sourcePaths],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (sourcePaths.length > 0) {
        params.set('sources', sourcePaths.join(','));
      }
      const url = `/api/agents${params.toString() ? '?' + params.toString() : ''}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch agents: ${response.status}`);
      }
      return response.json();
    },
    staleTime: 60 * 60 * 1000,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const promptAgentsQuery = useQuery<AdminPromptAgentsResponse>({
    queryKey: ['agent-access-prompt-agents'],
    queryFn: async () => {
      const response = await fetch('/api/agent-access/prompt-agents');
      if (!response.ok) {
        throw new Error(`Failed to fetch prompt agents: ${response.status}`);
      }
      return unwrapApiData<AdminPromptAgentsResponse>(await response.json());
    },
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const [activeTab, setActiveTab] = useState<PanelTab>('rules');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [isCreatingAgent, setIsCreatingAgent] = useState(false);
  const [editingAgentKey, setEditingAgentKey] = useState<string | null>(null);
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);
  const [deleteConflictKey, setDeleteConflictKey] = useState<string | null>(
    null,
  );
  const [isDeletingAgent, setIsDeletingAgent] = useState(false);

  const rows = useMemo<MergedAgentRow[]>(() => {
    const editableAgentKeys = me?.editableAgentKeys ?? [];
    const map = new Map<string, MergedAgentRow>();
    for (const agent of agentsQuery.data?.agents ?? []) {
      if (!agent.source || !agent.agentName) continue;
      const key = clientCanonicalAgentKey(agent.source, agent.agentName);
      if (!map.has(key)) {
        map.set(key, {
          canonicalKey: key,
          source: agent.source,
          agentName: agent.agentName,
          displayName: agent.name || agent.agentName,
          discoverable: true,
          stored: null,
          promptAgent: null,
        });
      }
    }
    for (const stored of rulesQuery.data?.rules ?? []) {
      const existing = map.get(stored.canonicalKey);
      if (existing) {
        existing.stored = stored;
      } else {
        map.set(stored.canonicalKey, {
          canonicalKey: stored.canonicalKey,
          source: stored.rule.source,
          agentName: stored.rule.agentName,
          displayName: stored.rule.agentName,
          discoverable: false,
          stored,
          promptAgent: null,
        });
      }
    }
    // Prompt agents usually also arrive via /api/agents (type 'prompt') and
    // already seeded a row above; the admin route additionally supplies the
    // record + CAS etag that the Edit-agent/Delete actions need. An agent
    // whose access rule excludes the admin only exists here.
    for (const entry of promptAgentsQuery.data?.promptAgents ?? []) {
      const existing = map.get(entry.canonicalKey);
      if (existing) {
        existing.promptAgent = entry;
        existing.displayName = entry.agent.name;
      } else {
        map.set(entry.canonicalKey, {
          canonicalKey: entry.canonicalKey,
          source: CLIENT_PROMPT_AGENT_SOURCE,
          agentName: entry.agent.id,
          displayName: entry.agent.name,
          discoverable: false,
          stored: null,
          promptAgent: entry,
        });
      }
    }
    let list = [...map.values()];
    if (editableAgentKeys !== '*') {
      // Rows with a promptAgent record came from the admin prompt-agents
      // GET, which the server already filtered to this admin's delegated
      // keys against FRESH config. /me answers from a ≤60s-stale snapshot
      // that may not know about a just-created agent's auto-delegation yet
      // (another replica), so re-filtering those rows through
      // editableAgentKeys would make a fresh create vanish from a zero-key
      // local admin's list. Trust the server-filtered listing instead.
      list = list.filter(
        (row) =>
          row.promptAgent !== null ||
          editableAgentKeys.includes(row.canonicalKey),
      );
    }
    return list.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [
    agentsQuery.data,
    rulesQuery.data,
    promptAgentsQuery.data,
    me?.editableAgentKeys,
  ]);

  const refetchRules = async () => {
    await queryClient.invalidateQueries({ queryKey: ['agent-access-rules'] });
  };

  const handleSaved = async () => {
    setEditingKey(null);
    await refetchRules();
  };

  const handleConflictReload = async () => {
    setEditingKey(null);
    await refetchRules();
  };

  /**
   * A prompt-agent mutation touches every surface that lists agents: the
   * admin list itself, the merged rows (rules + /api/agents discovery), the
   * user-facing picker (['foundry-agents']), and — because creates by local
   * admins auto-delegate — the config map and the admin's own /me status.
   */
  const invalidatePromptAgentData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ['agent-access-prompt-agents'],
      }),
      queryClient.invalidateQueries({ queryKey: ['agent-access-rules'] }),
      queryClient.invalidateQueries({
        queryKey: ['agent-access-admin-agents'],
      }),
      queryClient.invalidateQueries({ queryKey: ['foundry-agents'] }),
      queryClient.invalidateQueries({ queryKey: ['agent-access-config'] }),
      queryClient.invalidateQueries({ queryKey: ['agent-access-me'] }),
    ]);
  };

  const handleAgentSaved = async () => {
    setIsCreatingAgent(false);
    setEditingAgentKey(null);
    await invalidatePromptAgentData();
  };

  const handleAgentConflictReload = async () => {
    setIsCreatingAgent(false);
    setEditingAgentKey(null);
    await queryClient.invalidateQueries({
      queryKey: ['agent-access-prompt-agents'],
    });
  };

  const handleDeleteConflictReload = async () => {
    setDeleteConflictKey(null);
    await queryClient.invalidateQueries({
      queryKey: ['agent-access-prompt-agents'],
    });
  };

  const handleDeleteAgent = async (row: MergedAgentRow) => {
    if (!row.promptAgent) return;
    setIsDeletingAgent(true);
    try {
      const params = new URLSearchParams({ id: row.promptAgent.agent.id });
      const response = await fetch(
        `/api/agent-access/prompt-agents?${params.toString()}`,
        {
          method: 'DELETE',
          headers: { 'If-Match': row.promptAgent.etag },
        },
      );
      if (response.status === 409) {
        setConfirmDeleteKey(null);
        setDeleteConflictKey(row.canonicalKey);
        return;
      }
      // 404 = another admin already deleted it — the desired end state
      // holds, so treat it as success (mirrors RuleEditor's DELETE).
      if (!response.ok && response.status !== 404) {
        toast.error(t('saveError'));
        return;
      }
      toast.success(t('promptAgentDeleteSuccess'));
      setConfirmDeleteKey(null);
      await invalidatePromptAgentData();
    } catch {
      toast.error(t('saveError'));
    } finally {
      setIsDeletingAgent(false);
    }
  };

  // /me shapes the list (delegated-key filtering), so it participates in the
  // loading and error branches — otherwise a local admin briefly sees a
  // wrong or empty list while /me loads or after it errors.
  const isLoading =
    rulesQuery.isLoading ||
    agentsQuery.isLoading ||
    promptAgentsQuery.isLoading ||
    isMeLoading;

  // A rules-store outage answers 200 with rulesUnavailable:true and empty
  // rules. Rendering the merged list then would show every agent as
  // "Everyone" while invocation is actually failing closed — treat it
  // exactly like a rules fetch error. The prompt-agents listing shares the
  // same outage contract (an empty list would read as "none exist").
  const rulesUnavailable = rulesQuery.data?.rulesUnavailable === true;
  const promptAgentsUnavailable =
    promptAgentsQuery.data?.promptAgentsUnavailable === true;
  const loadFailed = Boolean(
    rulesQuery.error ||
    promptAgentsQuery.error ||
    meError ||
    rulesUnavailable ||
    promptAgentsUnavailable,
  );

  const handleRetry = () => {
    void rulesQuery.refetch();
    void promptAgentsQuery.refetch();
    void refetchMe();
  };

  return (
    <div className="flex-1 overflow-y-auto bg-white dark:bg-surface-dark-base">
      <div className="mx-auto max-w-4xl p-6">
        <Link
          href="/"
          className="mb-4 flex w-fit items-center gap-1.5 text-sm text-gray-500 hover:text-black dark:text-gray-400 dark:hover:text-white"
        >
          <IconArrowLeft size={16} />
          {t('backToChat')}
        </Link>

        <div className="mb-2 flex items-center gap-2">
          <IconUserShield size={24} className="text-black dark:text-white" />
          <h1 className="text-xl font-bold text-black dark:text-white">
            {t('title')}
          </h1>
        </div>
        <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
          {t('description')}
        </p>

        {/* Tabs — the delegation map is global-admin only */}
        {isGlobalAdmin && (
          <div className="mb-6 flex gap-1 border-b border-gray-200 dark:border-gray-700">
            {(['rules', 'localAdmins'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                className={`border-b-2 px-3 py-2 text-sm font-medium ${
                  activeTab === tab
                    ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
                    : 'border-transparent text-gray-500 hover:text-black dark:text-gray-400 dark:hover:text-white'
                }`}
                onClick={() => setActiveTab(tab)}
              >
                {tab === 'rules' ? t('rulesTab') : t('localAdminsTab')}
              </button>
            ))}
          </div>
        )}

        {activeTab === 'localAdmins' && isGlobalAdmin ? (
          <LocalAdminsSection rows={rows} />
        ) : isLoading ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('loading')}
          </p>
        ) : loadFailed ? (
          <div className="text-sm text-red-600 dark:text-red-400">
            <p>
              {rulesUnavailable
                ? t('rulesUnavailableWarning')
                : promptAgentsUnavailable
                  ? t('promptAgentsUnavailableWarning')
                  : t('loadError')}
            </p>
            <button
              type="button"
              className="mt-2 rounded-md border border-gray-300 dark:border-gray-600 px-3 py-1 text-sm text-black dark:text-white hover:bg-gray-100 dark:hover:bg-gray-800"
              onClick={handleRetry}
            >
              {t('retry')}
            </button>
          </div>
        ) : (
          <>
            {/* Any admin may create a prompt agent — including local admins
                with zero delegated keys (the create auto-delegates to them). */}
            <button
              type="button"
              aria-expanded={isCreatingAgent}
              className="mb-4 flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-black dark:text-white hover:bg-gray-100 dark:hover:bg-gray-800"
              onClick={() => setIsCreatingAgent((creating) => !creating)}
            >
              <IconPlus size={16} />
              {t('addAgent')}
            </button>

            {isCreatingAgent && (
              <div className="mb-4">
                <PromptAgentEditor
                  existing={null}
                  onSaved={handleAgentSaved}
                  onCancel={() => setIsCreatingAgent(false)}
                  onConflictReload={handleAgentConflictReload}
                />
              </div>
            )}

            {rows.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t('noAgents')}
              </p>
            ) : (
              <ul className="space-y-2">
                {rows.map((row) => {
                  const isRestricted =
                    row.stored?.rule.access.type === 'restricted';
                  const isPromptAgent =
                    row.source === CLIENT_PROMPT_AGENT_SOURCE;
                  return (
                    <li
                      key={row.canonicalKey}
                      className="rounded-lg border border-gray-200 dark:border-gray-700 p-3"
                    >
                      <div className="flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium text-black dark:text-white">
                              {row.displayName}
                            </span>
                            {isPromptAgent && (
                              <span className="shrink-0 rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
                                {t('promptAgentBadge')}
                              </span>
                            )}
                            {!row.discoverable && (
                              <span
                                className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
                                title={t('notDiscoverableHint')}
                              >
                                {t('notDiscoverable')}
                              </span>
                            )}
                          </div>
                          <p
                            className="truncate text-xs text-gray-500 dark:text-gray-400"
                            title={row.source}
                          >
                            {t('sourceLabel')}: {row.source}
                          </p>
                        </div>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                            isRestricted
                              ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
                              : 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                          }`}
                        >
                          {isRestricted
                            ? t('accessRestricted')
                            : t('accessEveryone')}
                        </span>
                        <button
                          type="button"
                          className="shrink-0 rounded-md border border-gray-200 dark:border-gray-700 px-3 py-1 text-sm text-black dark:text-white hover:bg-gray-100 dark:hover:bg-gray-800"
                          onClick={() =>
                            setEditingKey(
                              editingKey === row.canonicalKey
                                ? null
                                : row.canonicalKey,
                            )
                          }
                        >
                          {editingKey === row.canonicalKey
                            ? t('cancel')
                            : t('edit')}
                        </button>
                        {row.promptAgent && (
                          <>
                            <button
                              type="button"
                              className="shrink-0 rounded-md border border-gray-200 dark:border-gray-700 px-3 py-1 text-sm text-black dark:text-white hover:bg-gray-100 dark:hover:bg-gray-800"
                              onClick={() =>
                                setEditingAgentKey(
                                  editingAgentKey === row.canonicalKey
                                    ? null
                                    : row.canonicalKey,
                                )
                              }
                            >
                              {editingAgentKey === row.canonicalKey
                                ? t('cancel')
                                : t('editAgent')}
                            </button>
                            <button
                              type="button"
                              className="shrink-0 rounded-md border border-red-200 dark:border-red-900 px-3 py-1 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                              onClick={() =>
                                setConfirmDeleteKey(
                                  confirmDeleteKey === row.canonicalKey
                                    ? null
                                    : row.canonicalKey,
                                )
                              }
                            >
                              {t('deleteAgent')}
                            </button>
                          </>
                        )}
                      </div>

                      {row.stored && (
                        <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                          {t('updatedByLine', {
                            user: row.stored.rule.updatedBy,
                            date: row.stored.rule.updatedAt,
                          })}
                        </p>
                      )}

                      {editingKey === row.canonicalKey && (
                        <RuleEditor
                          // Remount when the underlying rule/etag changes so the
                          // editor state reseeds after a reload.
                          key={`${row.canonicalKey}:${row.stored?.etag ?? 'none'}`}
                          row={row}
                          onSaved={handleSaved}
                          onCancel={() => setEditingKey(null)}
                          onConflictReload={handleConflictReload}
                        />
                      )}

                      {editingAgentKey === row.canonicalKey &&
                        row.promptAgent && (
                          <PromptAgentEditor
                            // Same remount idiom as RuleEditor: reseed the form
                            // after a conflict reload lands a fresh etag.
                            key={`${row.promptAgent.agent.id}:${row.promptAgent.etag}`}
                            existing={row.promptAgent}
                            onSaved={handleAgentSaved}
                            onCancel={() => setEditingAgentKey(null)}
                            onConflictReload={handleAgentConflictReload}
                          />
                        )}

                      {confirmDeleteKey === row.canonicalKey &&
                        row.promptAgent && (
                          <div className="mt-2 rounded-md border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-800 dark:text-red-300">
                            <p>{t('deleteAgentConfirm')}</p>
                            <div className="mt-2 flex gap-2">
                              <button
                                type="button"
                                className="rounded-md bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                                onClick={() => handleDeleteAgent(row)}
                                disabled={isDeletingAgent}
                              >
                                {t('confirmDeleteAgent')}
                              </button>
                              <button
                                type="button"
                                className="rounded-md px-3 py-1 text-sm text-gray-700 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700"
                                onClick={() => setConfirmDeleteKey(null)}
                                disabled={isDeletingAgent}
                              >
                                {t('cancel')}
                              </button>
                            </div>
                          </div>
                        )}

                      {deleteConflictKey === row.canonicalKey && (
                        <div className="mt-2 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-800 dark:text-amber-300">
                          <p>{t('conflictError')}</p>
                          <button
                            type="button"
                            className="mt-2 rounded-md bg-amber-600 px-3 py-1 text-sm font-medium text-white hover:bg-amber-700"
                            onClick={handleDeleteConflictReload}
                          >
                            {t('reload')}
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
};
