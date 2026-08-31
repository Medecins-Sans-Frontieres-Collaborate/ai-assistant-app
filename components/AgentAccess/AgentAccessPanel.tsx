'use client';

import { IconPlus } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FC, useMemo, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { useAdminDiscoveredAgents } from '@/client/hooks/settings/useAdminDiscoveredAgents';
import {
  unwrapApiData,
  useAgentAccessAdmin,
} from '@/client/hooks/settings/useAgentAccessAdmin';
import { useHiddenAdminAgents } from '@/client/hooks/useHiddenAdminAgents';

import { CanonicalKeyChip } from './CanonicalKeyChip';
import { CatalogOauthSection } from './CatalogOauthSection';
import { ConnectorEditor } from './ConnectorEditor';
import { GuideEditor } from './GuideEditor';
import {
  HiddenBadge,
  HideAgentButton,
  ShowHiddenToggle,
} from './HiddenAgentsControls';
import { LocalAdminsSection } from './LocalAdminsSection';
import { M365AgentsSection } from './M365AgentsSection';
import { OrgAgentsSection } from './OrgAgentsSection';
import { PromptAgentEditor } from './PromptAgentEditor';
import { RuleEditor } from './RuleEditor';
import {
  AdminConnectorsResponse,
  AdminGuidesResponse,
  AdminMapDatasetsResponse,
  AdminPromptAgentsResponse,
  AdminRulesResponse,
  AdminStoredConnector,
  AdminStoredDatasetMeta,
  AdminStoredGuide,
  CLIENT_GUIDE_SOURCE,
  CLIENT_MAP_DATASET_SOURCE,
  CLIENT_MCP_CONNECTOR_SOURCE,
  CLIENT_PROMPT_AGENT_SOURCE,
  MergedAgentRow,
  clientCanonicalAgentKey,
} from './types';

import { Link } from '@/lib/navigation';

type PanelTab = 'agents' | 'connectors' | 'guides' | 'datasets' | 'localAdmins';

/**
 * Per-area headings. Reuses the tab labels, which are already translated into
 * all 53 locales — renaming them breaks both these headings and the area rail.
 */
const SECTION_HEADING_KEY: Record<PanelTab, string> = {
  agents: 'agentsTab',
  connectors: 'connectorsTab',
  guides: 'guidesTab',
  datasets: 'datasetsTab',
  localAdmins: 'localAdminsTab',
};

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
interface AgentAccessPanelProps {
  /**
   * Which section to render. Formerly internal tab state; now supplied by the
   * route, so each section is deep-linkable and carries its own server gate.
   * The component is otherwise unchanged — its queries, row memos and cache
   * invalidations all stay in one place.
   */
  section: PanelTab;
}

export const AgentAccessPanel: FC<AgentAccessPanelProps> = ({ section }) => {
  const t = useTranslations('agentAccess');
  const queryClient = useQueryClient();
  const {
    me,
    isGlobalAdmin,
    isLoading: isMeLoading,
    error: meError,
    refetch: refetchMe,
  } = useAgentAccessAdmin();

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

  // Both discovery halves (Foundry incl. the admin's custom sources, plus
  // app-defined agents), WITHOUT per-source selection filtering:
  // hidden-from-picker agents are still manageable here.
  const agentsQuery = useAdminDiscoveredAgents();

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

  const datasetsQuery = useQuery<AdminMapDatasetsResponse>({
    queryKey: ['agent-access-map-datasets'],
    queryFn: async () => {
      const response = await fetch('/api/agent-access/map-datasets');
      if (!response.ok) {
        throw new Error(`Failed to fetch datasets: ${response.status}`);
      }
      return unwrapApiData<AdminMapDatasetsResponse>(await response.json());
    },
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const activeTab = section;
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
  const [isCreatingDataset, setIsCreatingDataset] = useState(false);
  const [newDatasetName, setNewDatasetName] = useState('');
  const [newDatasetDescription, setNewDatasetDescription] = useState('');
  const [isSavingDataset, setIsSavingDataset] = useState(false);
  const [editingDatasetRuleKey, setEditingDatasetRuleKey] = useState<
    string | null
  >(null);
  const [confirmDeleteDatasetId, setConfirmDeleteDatasetId] = useState<
    string | null
  >(null);
  const [isDeletingDataset, setIsDeletingDataset] = useState(false);
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
  // Per-admin hidden agents (presentational only — see the hook).
  const hiddenAgents = useHiddenAdminAgents();
  const { visible: visibleRows, hiddenCount: hiddenRowCount } =
    hiddenAgents.partition(rows, (row) => row.canonicalKey);

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
   * Dataset rows reuse MergedAgentRow for the same reason the other entities
   * do: the RuleEditor works unchanged over the `map-dataset::<id>` key.
   */
  const datasetRows = useMemo(() => {
    const rulesByKey = new Map(
      (rulesQuery.data?.rules ?? []).map((r) => [r.canonicalKey, r]),
    );
    return (datasetsQuery.data?.datasets ?? [])
      .map((entry: AdminStoredDatasetMeta) => ({
        row: {
          canonicalKey: entry.canonicalKey,
          source: CLIENT_MAP_DATASET_SOURCE,
          agentName: entry.meta.id,
          displayName: entry.meta.name,
          discoverable: true,
          stored: rulesByKey.get(entry.canonicalKey) ?? null,
          promptAgent: null,
        } satisfies MergedAgentRow,
        entry,
      }))
      .sort((a, b) => a.row.displayName.localeCompare(b.row.displayName));
  }, [datasetsQuery.data, rulesQuery.data]);

  const invalidateDatasetData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ['agent-access-map-datasets'],
      }),
      queryClient.invalidateQueries({ queryKey: ['agent-access-rules'] }),
      queryClient.invalidateQueries({ queryKey: ['available-map-datasets'] }),
      queryClient.invalidateQueries({ queryKey: ['agent-access-config'] }),
      queryClient.invalidateQueries({ queryKey: ['agent-access-me'] }),
    ]);
  };

  const handleCreateDataset = async () => {
    if (!newDatasetName.trim()) return;
    setIsSavingDataset(true);
    try {
      const response = await fetch('/api/agent-access/map-datasets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newDatasetName.trim(),
          description: newDatasetDescription.trim(),
        }),
      });
      const parsed = (await response.json().catch(() => ({}))) as {
        error?: unknown;
        data?: { dataset?: { id: string } };
      };
      if (!response.ok || !parsed.data?.dataset?.id) {
        toast.error(
          typeof parsed.error === 'string' ? parsed.error : t('saveError'),
        );
        return;
      }
      setIsCreatingDataset(false);
      setNewDatasetName('');
      setNewDatasetDescription('');
      await invalidateDatasetData();
      toast.success(t('datasetCreateSuccess'));
    } catch {
      toast.error(t('saveError'));
    } finally {
      setIsSavingDataset(false);
    }
  };

  const handleDeleteDataset = async (entry: AdminStoredDatasetMeta) => {
    setIsDeletingDataset(true);
    try {
      // The listing carries no ETags (CAS anchors the data blob), so fetch
      // a fresh one right before the conditional delete.
      const current = await fetch(
        `/api/agent-access/map-datasets/${entry.meta.id}`,
      );
      if (current.status === 404) {
        // Already gone — the desired end state holds.
        setConfirmDeleteDatasetId(null);
        await invalidateDatasetData();
        return;
      }
      const parsed = (await current.json().catch(() => ({}))) as {
        data?: { etag?: string };
      };
      const etag = parsed.data?.etag;
      if (!current.ok || !etag) {
        toast.error(t('saveError'));
        return;
      }
      const response = await fetch(
        `/api/agent-access/map-datasets/${entry.meta.id}`,
        { method: 'DELETE', headers: { 'If-Match': etag } },
      );
      if (!response.ok && response.status !== 404) {
        toast.error(t('saveError'));
        return;
      }
      toast.success(t('datasetDeleteSuccess'));
      setConfirmDeleteDatasetId(null);
      await invalidateDatasetData();
    } catch {
      toast.error(t('saveError'));
    } finally {
      setIsDeletingDataset(false);
    }
  };

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
    // Body only: AdminShell owns the page plane, the back link, the product
    // title and the area switcher. A wrapper here would nest two scroll
    // containers and duplicate the header on every area.
    <>
      <div>
        <h1 className="mb-2 text-xl font-bold text-black dark:text-white">
          {t(SECTION_HEADING_KEY[section] as never)}
        </h1>
        <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
          {t('description')}
        </p>

        {activeTab === 'localAdmins' && isGlobalAdmin ? (
          <LocalAdminsSection rows={rows} />
        ) : activeTab === 'datasets' ? (
          datasetsQuery.isLoading ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t('loading')}
            </p>
          ) : datasetsQuery.error ||
            datasetsQuery.data?.datasetsUnavailable === true ? (
            <div className="text-sm text-red-600 dark:text-red-400">
              <p>
                {datasetsQuery.data?.datasetsUnavailable
                  ? t('datasetsUnavailableWarning')
                  : t('loadError')}
              </p>
              <button
                type="button"
                className="mt-2 rounded-md border border-gray-300 dark:border-gray-600 px-3 py-1 text-sm text-black dark:text-white hover:bg-gray-100 dark:hover:bg-gray-800"
                onClick={() => void datasetsQuery.refetch()}
              >
                {t('retry')}
              </button>
            </div>
          ) : (
            <>
              <button
                type="button"
                aria-expanded={isCreatingDataset}
                className="mb-4 flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-black dark:text-white hover:bg-gray-100 dark:hover:bg-gray-800"
                onClick={() => setIsCreatingDataset((creating) => !creating)}
              >
                <IconPlus size={16} />
                {t('addDataset')}
              </button>

              {isCreatingDataset && (
                <div className="mb-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-4">
                  <div className="space-y-3">
                    <input
                      className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm text-black dark:text-white"
                      value={newDatasetName}
                      onChange={(e) => setNewDatasetName(e.target.value)}
                      placeholder={t('datasetNamePlaceholder')}
                      aria-label={t('datasetNameLabel')}
                    />
                    <input
                      className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm text-black dark:text-white"
                      value={newDatasetDescription}
                      onChange={(e) => setNewDatasetDescription(e.target.value)}
                      placeholder={t('datasetDescriptionLabel')}
                      aria-label={t('datasetDescriptionLabel')}
                    />
                  </div>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      className="rounded-md bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                      onClick={() => void handleCreateDataset()}
                      disabled={!newDatasetName.trim() || isSavingDataset}
                    >
                      {t('createDataset')}
                    </button>
                    <button
                      type="button"
                      className="rounded-md px-3 py-1 text-sm text-gray-700 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700"
                      onClick={() => setIsCreatingDataset(false)}
                      disabled={isSavingDataset}
                    >
                      {t('cancel')}
                    </button>
                  </div>
                  <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                    {t('datasetCreateHint')}
                  </p>
                </div>
              )}

              {datasetRows.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {t('noDatasets')}
                </p>
              ) : (
                <ul className="space-y-2">
                  {datasetRows.map(({ row, entry }) => {
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
                            {entry.meta.description && (
                              <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                                {entry.meta.description}
                              </p>
                            )}
                          </div>
                          <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                            {t('datasetFeatureCount', {
                              count: String(entry.meta.featureCount),
                            })}
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
                              setEditingDatasetRuleKey(
                                editingDatasetRuleKey === row.canonicalKey
                                  ? null
                                  : row.canonicalKey,
                              )
                            }
                          >
                            {editingDatasetRuleKey === row.canonicalKey
                              ? t('cancel')
                              : t('editAccess')}
                          </button>
                          <Link
                            href={`/admin/map-datasets/${entry.meta.id}`}
                            className="shrink-0 rounded-md border border-gray-200 dark:border-gray-700 px-3 py-1 text-sm text-black dark:text-white hover:bg-gray-100 dark:hover:bg-gray-800"
                          >
                            {t('openDatasetEditor')}
                          </Link>
                          <button
                            type="button"
                            className="shrink-0 rounded-md border border-red-200 dark:border-red-900 px-3 py-1 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                            onClick={() =>
                              setConfirmDeleteDatasetId(
                                confirmDeleteDatasetId === entry.meta.id
                                  ? null
                                  : entry.meta.id,
                              )
                            }
                          >
                            {t('deleteDataset')}
                          </button>
                        </div>

                        <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                          {t('updatedByLine', {
                            user: entry.meta.updatedBy,
                            date: entry.meta.updatedAt,
                          })}
                        </p>

                        {editingDatasetRuleKey === row.canonicalKey && (
                          <RuleEditor
                            key={`${row.canonicalKey}:${row.stored?.etag ?? 'none'}`}
                            row={row}
                            onSaved={async () => {
                              setEditingDatasetRuleKey(null);
                              await invalidateDatasetData();
                            }}
                            onCancel={() => setEditingDatasetRuleKey(null)}
                            onConflictReload={async () => {
                              setEditingDatasetRuleKey(null);
                              await refetchRules();
                            }}
                          />
                        )}

                        {confirmDeleteDatasetId === entry.meta.id && (
                          <div className="mt-2 rounded-md border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-800 dark:text-red-300">
                            <p>{t('deleteDatasetConfirm')}</p>
                            <div className="mt-2 flex gap-2">
                              <button
                                type="button"
                                className="rounded-md bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                                onClick={() => void handleDeleteDataset(entry)}
                                disabled={isDeletingDataset}
                              >
                                {t('confirmDeleteDataset')}
                              </button>
                              <button
                                type="button"
                                className="rounded-md px-3 py-1 text-sm text-gray-700 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700"
                                onClick={() => setConfirmDeleteDatasetId(null)}
                                disabled={isDeletingDataset}
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
        ) : activeTab === 'guides' ? (
          guidesQuery.isLoading ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t('loading')}
            </p>
          ) : guidesQuery.error ||
            guidesQuery.data?.guidesUnavailable === true ? (
            <div className="text-sm text-red-600 dark:text-red-400">
              {/* An outage returns an empty list; rendering it as "no guides
                  exist" would invite an admin to recreate one. */}
              <p>
                {guidesQuery.data?.guidesUnavailable
                  ? t('guidesUnavailableWarning')
                  : t('loadError')}
              </p>
              <button
                type="button"
                className="mt-2 rounded-md border border-gray-300 dark:border-gray-600 px-3 py-1 text-sm text-black dark:text-white hover:bg-gray-100 dark:hover:bg-gray-800"
                onClick={() => void guidesQuery.refetch()}
              >
                {t('retry')}
              </button>
            </div>
          ) : (
            <>
              <button
                type="button"
                aria-expanded={isCreatingGuide}
                className="mb-4 flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-black dark:text-white hover:bg-gray-100 dark:hover:bg-gray-800"
                onClick={() => setIsCreatingGuide((creating) => !creating)}
              >
                <IconPlus size={16} />
                {t('addGuide')}
              </button>

              {isCreatingGuide && (
                <div className="mb-4">
                  <GuideEditor
                    existing={null}
                    onSaved={handleGuideSaved}
                    onCancel={() => setIsCreatingGuide(false)}
                    onConflictReload={handleGuideConflictReload}
                  />
                </div>
              )}

              {guideRows.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {t('noGuides')}
                </p>
              ) : (
                <ul className="space-y-2">
                  {guideRows.map(({ row, entry }) => {
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
                            {entry.guide.description && (
                              <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                                {entry.guide.description}
                              </p>
                            )}
                          </div>
                          <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                            {t(`guideKind_${entry.guide.kind}`)}
                          </span>
                          {/* Payload summary — differentiates the structured
                              kinds at a glance. */}
                          {entry.guide.sections !== undefined && (
                            <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">
                              {t('guideSectionCount', {
                                count: String(entry.guide.sections.length),
                              })}
                            </span>
                          )}
                          {entry.guide.entries !== undefined && (
                            <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">
                              {t('guideEntryCount', {
                                count: String(entry.guide.entries.length),
                              })}
                            </span>
                          )}
                          <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                            {entry.guide.workflows
                              .map((w) =>
                                w === 'document'
                                  ? t('guideWorkflowDocument')
                                  : t('guideWorkflowTranslation'),
                              )
                              .join(' · ')}
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
                              setEditingGuideRuleKey(
                                editingGuideRuleKey === row.canonicalKey
                                  ? null
                                  : row.canonicalKey,
                              )
                            }
                          >
                            {editingGuideRuleKey === row.canonicalKey
                              ? t('cancel')
                              : t('editAccess')}
                          </button>
                          <button
                            type="button"
                            className="shrink-0 rounded-md border border-gray-200 dark:border-gray-700 px-3 py-1 text-sm text-black dark:text-white hover:bg-gray-100 dark:hover:bg-gray-800"
                            onClick={() =>
                              setEditingGuideId(
                                editingGuideId === entry.guide.id
                                  ? null
                                  : entry.guide.id,
                              )
                            }
                          >
                            {editingGuideId === entry.guide.id
                              ? t('cancel')
                              : t('edit')}
                          </button>
                          <button
                            type="button"
                            className="shrink-0 rounded-md border border-red-200 dark:border-red-900 px-3 py-1 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                            onClick={() =>
                              setConfirmDeleteGuideId(
                                confirmDeleteGuideId === entry.guide.id
                                  ? null
                                  : entry.guide.id,
                              )
                            }
                          >
                            {t('deleteGuide')}
                          </button>
                        </div>

                        <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                          {t('updatedByLine', {
                            user: entry.guide.updatedBy,
                            date: entry.guide.updatedAt,
                          })}
                        </p>

                        {editingGuideRuleKey === row.canonicalKey && (
                          <RuleEditor
                            key={`${row.canonicalKey}:${row.stored?.etag ?? 'none'}`}
                            row={row}
                            onSaved={async () => {
                              setEditingGuideRuleKey(null);
                              await invalidateGuideData();
                            }}
                            onCancel={() => setEditingGuideRuleKey(null)}
                            onConflictReload={async () => {
                              setEditingGuideRuleKey(null);
                              await refetchRules();
                            }}
                          />
                        )}

                        {editingGuideId === entry.guide.id && (
                          <GuideEditor
                            key={`${entry.guide.id}:${entry.etag}`}
                            existing={entry}
                            onSaved={handleGuideSaved}
                            onCancel={() => setEditingGuideId(null)}
                            onConflictReload={handleGuideConflictReload}
                          />
                        )}

                        {confirmDeleteGuideId === entry.guide.id && (
                          <div className="mt-2 rounded-md border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-800 dark:text-red-300">
                            <p>{t('deleteGuideConfirm')}</p>
                            <div className="mt-2 flex gap-2">
                              <button
                                type="button"
                                className="rounded-md bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                                onClick={() => handleDeleteGuide(entry)}
                                disabled={isDeletingGuide}
                              >
                                {t('confirmDeleteGuide')}
                              </button>
                              <button
                                type="button"
                                className="rounded-md px-3 py-1 text-sm text-gray-700 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700"
                                onClick={() => setConfirmDeleteGuideId(null)}
                                disabled={isDeletingGuide}
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
        ) : activeTab === 'connectors' ? (
          <>
            {/* Deployment OAuth apps for the curated catalog — the Admin →
                Connectors replacement for the MCP_OAUTH_* env vars. Global
                admins only: these credentials are deployment-wide config,
                not per-agent records. */}
            {isGlobalAdmin && <CatalogOauthSection />}
            {connectorsQuery.isLoading ? (
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
                  onClick={() =>
                    setIsCreatingConnector((creating) => !creating)
                  }
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
                                  confirmDeleteConnectorId ===
                                    entry.connector.id
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
            )}
          </>
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

            <ShowHiddenToggle
              hiddenCount={hiddenRowCount}
              showHidden={hiddenAgents.showHidden}
              onToggle={hiddenAgents.setShowHidden}
            />
            {visibleRows.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {rows.length === 0 ? t('noAgents') : t('allAgentsHidden')}
              </p>
            ) : (
              <ul className="space-y-2">
                {visibleRows.map((row) => {
                  const isRestricted =
                    row.stored?.rule.access.type === 'restricted';
                  const isPromptAgent =
                    row.source === CLIENT_PROMPT_AGENT_SOURCE;
                  const isHiddenRow = hiddenAgents.isHidden(row.canonicalKey);
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
                          <CanonicalKeyChip canonicalKey={row.canonicalKey} />
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
                        {isHiddenRow && <HiddenBadge />}
                        <HideAgentButton
                          hidden={isHiddenRow}
                          onHide={() => hiddenAgents.hide(row.canonicalKey)}
                          onUnhide={() => hiddenAgents.unhide(row.canonicalKey)}
                        />
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

            {/* M365 file-backed agents — self-contained block (own query,
                editor, index action); rules are shared so the access pill
                and RuleEditor stay CAS-consistent with the rest of the
                panel. Renders nothing when the m365Agents flag is off. */}
            <M365AgentsSection
              rules={rulesQuery.data?.rules ?? []}
              onDataChanged={() => {
                void invalidatePromptAgentData();
              }}
            />

            {/* Organization RAG agents — blob-store counterpart of
                config/organization-agents.json (create/override/disable
                without a deploy; every save validated against the live
                search index). Same shared-rules wiring as the M365 block. */}
            <OrgAgentsSection
              rules={rulesQuery.data?.rules ?? []}
              onDataChanged={() => {
                void invalidatePromptAgentData();
              }}
            />
          </>
        )}
      </div>
    </>
  );
};
