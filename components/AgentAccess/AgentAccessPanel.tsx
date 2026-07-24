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

import { ConnectorEditor } from './ConnectorEditor';
import { GuideEditor } from './GuideEditor';
import { LocalAdminsSection } from './LocalAdminsSection';
import { PromptAgentEditor } from './PromptAgentEditor';
import { RuleEditor } from './RuleEditor';
import {
  AdminConnectorsResponse,
  AdminGuidesResponse,
  AdminPromptAgentsResponse,
  AdminRulesResponse,
  AdminStoredConnector,
  AdminStoredGuide,
  AgentsApiResponse,
  CLIENT_GUIDE_SOURCE,
  CLIENT_MCP_CONNECTOR_SOURCE,
  CLIENT_PROMPT_AGENT_SOURCE,
  MergedAgentRow,
  clientCanonicalAgentKey,
} from './types';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { Link } from '@/lib/navigation';

type PanelTab = 'agents' | 'connectors' | 'guides' | 'localAdmins';

/**
 * Admin panel for app-layer ACCESS CONTROL — agents and MCP connectors alike
 * (docs/AGENT_ACCESS_CONTROL.md "Admin UI"). Both hang off the same
 * canonical-key namespace, so both use the same rules, the same local-admin
 * delegation, and the same RuleEditor; only the thing being scoped differs.
 *
 * The agents tab merges the admin's OWN
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

  const connectorsQuery = useQuery<AdminConnectorsResponse>({
    queryKey: ['agent-access-connectors'],
    queryFn: async () => {
      const response = await fetch('/api/agent-access/connectors');
      if (!response.ok) {
        throw new Error(`Failed to fetch connectors: ${response.status}`);
      }
      return unwrapApiData<AdminConnectorsResponse>(await response.json());
    },
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const guidesQuery = useQuery<AdminGuidesResponse>({
    queryKey: ['agent-access-guides'],
    queryFn: async () => {
      const response = await fetch('/api/agent-access/guides');
      if (!response.ok) {
        throw new Error(`Failed to fetch guides: ${response.status}`);
      }
      return unwrapApiData<AdminGuidesResponse>(await response.json());
    },
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const [activeTab, setActiveTab] = useState<PanelTab>('agents');
  const [isCreatingConnector, setIsCreatingConnector] = useState(false);
  const [editingConnectorId, setEditingConnectorId] = useState<string | null>(
    null,
  );
  const [editingConnectorRuleKey, setEditingConnectorRuleKey] = useState<
    string | null
  >(null);
  const [confirmDeleteConnectorId, setConfirmDeleteConnectorId] = useState<
    string | null
  >(null);
  const [isDeletingConnector, setIsDeletingConnector] = useState(false);
  const [isCreatingGuide, setIsCreatingGuide] = useState(false);
  const [editingGuideId, setEditingGuideId] = useState<string | null>(null);
  const [editingGuideRuleKey, setEditingGuideRuleKey] = useState<string | null>(
    null,
  );
  const [confirmDeleteGuideId, setConfirmDeleteGuideId] = useState<
    string | null
  >(null);
  const [isDeletingGuide, setIsDeletingGuide] = useState(false);
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

  /**
   * Connector rows reuse MergedAgentRow so RuleEditor works unchanged: the
   * rule it writes is keyed on source + agentName, and a connector's
   * canonical key is `mcp-connector::<id>` — the same shape a prompt agent
   * uses. `discoverable` is always true here because the admin connectors
   * listing IS the discovery for connectors; there is no second source that
   * could know about one.
   */
  const connectorRows = useMemo(() => {
    const rulesByKey = new Map(
      (rulesQuery.data?.rules ?? []).map((r) => [r.canonicalKey, r]),
    );
    return (connectorsQuery.data?.connectors ?? [])
      .map((entry: AdminStoredConnector) => ({
        row: {
          canonicalKey: entry.canonicalKey,
          source: CLIENT_MCP_CONNECTOR_SOURCE,
          agentName: entry.connector.id,
          displayName: entry.connector.name,
          discoverable: true,
          stored: rulesByKey.get(entry.canonicalKey) ?? null,
          promptAgent: null,
        } satisfies MergedAgentRow,
        entry,
      }))
      .sort((a, b) => a.row.displayName.localeCompare(b.row.displayName));
  }, [connectorsQuery.data, rulesQuery.data]);

  /**
   * Guide rows reuse MergedAgentRow for the same reason connectors do: the
   * RuleEditor works unchanged over the `guide::<id>` canonical key.
   * `discoverable` is always true — the admin guides listing IS the
   * discovery for guides.
   */
  const guideRows = useMemo(() => {
    const rulesByKey = new Map(
      (rulesQuery.data?.rules ?? []).map((r) => [r.canonicalKey, r]),
    );
    return (guidesQuery.data?.guides ?? [])
      .map((entry: AdminStoredGuide) => ({
        row: {
          canonicalKey: entry.canonicalKey,
          source: CLIENT_GUIDE_SOURCE,
          agentName: entry.guide.id,
          displayName: entry.guide.name,
          discoverable: true,
          stored: rulesByKey.get(entry.canonicalKey) ?? null,
          promptAgent: null,
        } satisfies MergedAgentRow,
        entry,
      }))
      .sort((a, b) => a.row.displayName.localeCompare(b.row.displayName));
  }, [guidesQuery.data, rulesQuery.data]);

  /**
   * A guide mutation touches the admin listing, the rules that scope it, the
   * user-facing guide list, and — because a local admin's create
   * auto-delegates — the config map and the admin's own /me status.
   */
  const invalidateGuideData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['agent-access-guides'] }),
      queryClient.invalidateQueries({ queryKey: ['agent-access-rules'] }),
      queryClient.invalidateQueries({ queryKey: ['available-guides'] }),
      queryClient.invalidateQueries({ queryKey: ['agent-access-config'] }),
      queryClient.invalidateQueries({ queryKey: ['agent-access-me'] }),
    ]);
  };

  const handleGuideSaved = async () => {
    setIsCreatingGuide(false);
    setEditingGuideId(null);
    await invalidateGuideData();
  };

  const handleGuideConflictReload = async () => {
    setIsCreatingGuide(false);
    setEditingGuideId(null);
    await queryClient.invalidateQueries({ queryKey: ['agent-access-guides'] });
  };

  const handleDeleteGuide = async (entry: AdminStoredGuide) => {
    setIsDeletingGuide(true);
    try {
      const params = new URLSearchParams({ id: entry.guide.id });
      const response = await fetch(
        `/api/agent-access/guides?${params.toString()}`,
        { method: 'DELETE', headers: { 'If-Match': entry.etag } },
      );
      // 404 = another admin already deleted it; the desired end state holds.
      if (!response.ok && response.status !== 404) {
        toast.error(t('saveError'));
        return;
      }
      toast.success(t('guideDeleteSuccess'));
      setConfirmDeleteGuideId(null);
      await invalidateGuideData();
    } catch {
      toast.error(t('saveError'));
    } finally {
      setIsDeletingGuide(false);
    }
  };

  /**
   * A connector mutation touches the admin listing, the rules that scope it,
   * the user-facing connector list, and — because a local admin's create
   * auto-delegates — the config map and the admin's own /me status.
   */
  const invalidateConnectorData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['agent-access-connectors'] }),
      queryClient.invalidateQueries({ queryKey: ['agent-access-rules'] }),
      queryClient.invalidateQueries({ queryKey: ['mcp-available-connectors'] }),
      queryClient.invalidateQueries({ queryKey: ['agent-access-config'] }),
      queryClient.invalidateQueries({ queryKey: ['agent-access-me'] }),
    ]);
  };

  const handleConnectorSaved = async () => {
    setIsCreatingConnector(false);
    setEditingConnectorId(null);
    await invalidateConnectorData();
  };

  const handleConnectorConflictReload = async () => {
    setIsCreatingConnector(false);
    setEditingConnectorId(null);
    await queryClient.invalidateQueries({
      queryKey: ['agent-access-connectors'],
    });
  };

  const handleDeleteConnector = async (entry: AdminStoredConnector) => {
    setIsDeletingConnector(true);
    try {
      const params = new URLSearchParams({ id: entry.connector.id });
      const response = await fetch(
        `/api/agent-access/connectors?${params.toString()}`,
        { method: 'DELETE', headers: { 'If-Match': entry.etag } },
      );
      // 404 = another admin already deleted it; the desired end state holds.
      if (!response.ok && response.status !== 404) {
        toast.error(t('saveError'));
        return;
      }
      toast.success(t('connectorDeleteSuccess'));
      setConfirmDeleteConnectorId(null);
      await invalidateConnectorData();
    } catch {
      toast.error(t('saveError'));
    } finally {
      setIsDeletingConnector(false);
    }
  };

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

        {/* Tabs. Agents and connectors are open to every admin; the
            delegation map stays global-admin only. */}
        <div className="mb-6 flex gap-1 border-b border-gray-200 dark:border-gray-700">
          {(['agents', 'connectors', 'guides', 'localAdmins'] as const)
            .filter((tab) => tab !== 'localAdmins' || isGlobalAdmin)
            .map((tab) => (
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
                {tab === 'agents'
                  ? t('agentsTab')
                  : tab === 'connectors'
                    ? t('connectorsTab')
                    : tab === 'guides'
                      ? t('guidesTab')
                      : t('localAdminsTab')}
              </button>
            ))}
        </div>

        {activeTab === 'localAdmins' && isGlobalAdmin ? (
          <LocalAdminsSection rows={rows} />
        ) : activeTab === 'connectors' ? (
          connectorsQuery.isLoading ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t('loading')}
            </p>
          ) : connectorsQuery.error ||
            connectorsQuery.data?.connectorsUnavailable === true ? (
            <div className="text-sm text-red-600 dark:text-red-400">
              {/* An outage returns an empty list; rendering it as "no
                  connectors exist" would invite an admin to recreate one. */}
              <p>
                {connectorsQuery.data?.connectorsUnavailable
                  ? t('connectorsUnavailableWarning')
                  : t('loadError')}
              </p>
              <button
                type="button"
                className="mt-2 rounded-md border border-gray-300 dark:border-gray-600 px-3 py-1 text-sm text-black dark:text-white hover:bg-gray-100 dark:hover:bg-gray-800"
                onClick={() => void connectorsQuery.refetch()}
              >
                {t('retry')}
              </button>
            </div>
          ) : (
            <>
              <button
                type="button"
                aria-expanded={isCreatingConnector}
                className="mb-4 flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-black dark:text-white hover:bg-gray-100 dark:hover:bg-gray-800"
                onClick={() => setIsCreatingConnector((creating) => !creating)}
              >
                <IconPlus size={16} />
                {t('addConnector')}
              </button>

              {isCreatingConnector && (
                <div className="mb-4">
                  <ConnectorEditor
                    existing={null}
                    secretSealingAvailable={
                      connectorsQuery.data?.secretSealingAvailable !== false
                    }
                    onSaved={handleConnectorSaved}
                    onCancel={() => setIsCreatingConnector(false)}
                    onConflictReload={handleConnectorConflictReload}
                  />
                </div>
              )}

              {connectorRows.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {t('noConnectors')}
                </p>
              ) : (
                <ul className="space-y-2">
                  {connectorRows.map(({ row, entry }) => {
                    const isRestricted =
                      row.stored?.rule.access.type === 'restricted';
                    return (
                      <li
                        key={row.canonicalKey}
                        className="rounded-lg border border-gray-200 dark:border-gray-700 p-3"
                      >
                        <div className="flex items-center gap-3">
                          <div className="min-w-0 flex-1">
                            <span className="truncate text-sm font-medium text-black dark:text-white">
                              {row.displayName}
                            </span>
                            <p
                              className="truncate text-xs text-gray-500 dark:text-gray-400"
                              title={entry.connector.url}
                            >
                              {entry.connector.url}
                            </p>
                          </div>
                          <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                            {entry.connector.authStyle}
                          </span>
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
                              setEditingConnectorRuleKey(
                                editingConnectorRuleKey === row.canonicalKey
                                  ? null
                                  : row.canonicalKey,
                              )
                            }
                          >
                            {editingConnectorRuleKey === row.canonicalKey
                              ? t('cancel')
                              : t('editAccess')}
                          </button>
                          <button
                            type="button"
                            className="shrink-0 rounded-md border border-gray-200 dark:border-gray-700 px-3 py-1 text-sm text-black dark:text-white hover:bg-gray-100 dark:hover:bg-gray-800"
                            onClick={() =>
                              setEditingConnectorId(
                                editingConnectorId === entry.connector.id
                                  ? null
                                  : entry.connector.id,
                              )
                            }
                          >
                            {editingConnectorId === entry.connector.id
                              ? t('cancel')
                              : t('edit')}
                          </button>
                          <button
                            type="button"
                            className="shrink-0 rounded-md border border-red-200 dark:border-red-900 px-3 py-1 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                            onClick={() =>
                              setConfirmDeleteConnectorId(
                                confirmDeleteConnectorId === entry.connector.id
                                  ? null
                                  : entry.connector.id,
                              )
                            }
                          >
                            {t('deleteConnector')}
                          </button>
                        </div>

                        <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                          {t('updatedByLine', {
                            user: entry.connector.updatedBy,
                            date: entry.connector.updatedAt,
                          })}
                        </p>

                        {editingConnectorRuleKey === row.canonicalKey && (
                          <RuleEditor
                            key={`${row.canonicalKey}:${row.stored?.etag ?? 'none'}`}
                            row={row}
                            onSaved={async () => {
                              setEditingConnectorRuleKey(null);
                              await invalidateConnectorData();
                            }}
                            onCancel={() => setEditingConnectorRuleKey(null)}
                            onConflictReload={async () => {
                              setEditingConnectorRuleKey(null);
                              await refetchRules();
                            }}
                          />
                        )}

                        {editingConnectorId === entry.connector.id && (
                          <ConnectorEditor
                            key={`${entry.connector.id}:${entry.etag}`}
                            existing={entry}
                            secretSealingAvailable={
                              connectorsQuery.data?.secretSealingAvailable !==
                              false
                            }
                            onSaved={handleConnectorSaved}
                            onCancel={() => setEditingConnectorId(null)}
                            onConflictReload={handleConnectorConflictReload}
                          />
                        )}

                        {confirmDeleteConnectorId === entry.connector.id && (
                          <div className="mt-2 rounded-md border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-800 dark:text-red-300">
                            <p>{t('deleteConnectorConfirm')}</p>
                            <div className="mt-2 flex gap-2">
                              <button
                                type="button"
                                className="rounded-md bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                                onClick={() => handleDeleteConnector(entry)}
                                disabled={isDeletingConnector}
                              >
                                {t('confirmDeleteConnector')}
                              </button>
                              <button
                                type="button"
                                className="rounded-md px-3 py-1 text-sm text-gray-700 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700"
                                onClick={() =>
                                  setConfirmDeleteConnectorId(null)
                                }
                                disabled={isDeletingConnector}
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
            </>
          )
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
