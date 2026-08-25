'use client';

import {
  IconChevronDown,
  IconChevronRight,
  IconPlus,
  IconSearch,
  IconTrash,
} from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FC, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';
import { useM365PeopleSuggest } from '@/client/hooks/useM365PeopleSuggest';

import type { LocalAdminEntry } from '@/lib/services/agentAccess/types';

import { EmailAutocompleteInput } from '@/components/UI/EmailAutocompleteInput';

import {
  AdminConfigResponse,
  AdminConnectorsResponse,
  AdminGuidesResponse,
  AdminM365AgentsResponse,
  AdminMapDatasetsResponse,
  AdminOrgAgentsResponse,
  CLIENT_PROMPT_AGENT_SOURCE,
  MergedAgentRow,
} from './types';

interface LocalAdminsSectionProps {
  /** Merged agent rows from the admin's own discovery + stored rules. */
  rows: MergedAgentRow[];
}

/** One delegatable thing: a canonical key with a human name. */
interface DelegationOption {
  canonicalKey: string;
  displayName: string;
  /** Secondary line (agent id, source path, "built-in", …). */
  detail?: string;
}

type GroupId =
  | 'agents'
  | 'promptAgents'
  | 'm365Agents'
  | 'orgAgents'
  | 'guides'
  | 'connectors'
  | 'datasets';

interface DelegationGroup {
  id: GroupId;
  options: DelegationOption[];
  /** The listing behind this group failed to load. */
  unavailable: boolean;
}

const GROUP_ORDER: GroupId[] = [
  'agents',
  'promptAgents',
  'm365Agents',
  'orgAgents',
  'guides',
  'connectors',
  'datasets',
];

function byName(a: DelegationOption, b: DelegationOption): number {
  return a.displayName.localeCompare(b.displayName);
}

async function fetchAdminList<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${path}: ${response.status}`);
  }
  return unwrapApiData<T>(await response.json());
}

/**
 * Global-admin-only editor for config.json's delegation map: which local
 * admins may manage which canonical keys. Every admin-managed entity is
 * delegatable here — Foundry and prompt agents, Microsoft 365 agents,
 * knowledge (org) agents, guides, connectors, map datasets — grouped and
 * searchable. Saved as a whole document with the CAS ETag.
 */
export const LocalAdminsSection: FC<LocalAdminsSectionProps> = ({ rows }) => {
  const t = useTranslations('agentAccess');
  const tPeople = useTranslations('peopleSuggest');
  const peopleSuggest = useM365PeopleSuggest();
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery<AdminConfigResponse>({
    queryKey: ['agent-access-config'],
    queryFn: () =>
      fetchAdminList<AdminConfigResponse>('/api/agent-access/config'),
    retry: 1,
    refetchOnWindowFocus: false,
  });

  // The other delegatable entities. Same query keys as the panel's own
  // queries, so the cache is shared when both are mounted; each group
  // degrades alone when its listing fails.
  const listQuery = { retry: 1, refetchOnWindowFocus: false } as const;
  const m365Query = useQuery<AdminM365AgentsResponse>({
    queryKey: ['agent-access-m365-agents'],
    queryFn: () => fetchAdminList('/api/agent-access/m365-agents'),
    ...listQuery,
  });
  const orgQuery = useQuery<AdminOrgAgentsResponse>({
    queryKey: ['agent-access-org-agents'],
    queryFn: () => fetchAdminList('/api/agent-access/org-agents'),
    ...listQuery,
  });
  const guidesQuery = useQuery<AdminGuidesResponse>({
    queryKey: ['agent-access-guides'],
    queryFn: () => fetchAdminList('/api/agent-access/guides'),
    ...listQuery,
  });
  const connectorsQuery = useQuery<AdminConnectorsResponse>({
    queryKey: ['agent-access-connectors'],
    queryFn: () => fetchAdminList('/api/agent-access/connectors'),
    ...listQuery,
  });
  const datasetsQuery = useQuery<AdminMapDatasetsResponse>({
    queryKey: ['agent-access-map-datasets'],
    queryFn: () => fetchAdminList('/api/agent-access/map-datasets'),
    ...listQuery,
  });

  const groups = useMemo<DelegationGroup[]>(() => {
    const agents: DelegationOption[] = [];
    const promptAgents: DelegationOption[] = [];
    for (const row of rows) {
      const option = {
        canonicalKey: row.canonicalKey,
        displayName: row.displayName,
        detail: row.agentName,
      };
      if (row.source === CLIENT_PROMPT_AGENT_SOURCE) promptAgents.push(option);
      else agents.push(option);
    }
    const m365Agents = (m365Query.data?.m365Agents ?? []).map((entry) => ({
      canonicalKey: entry.canonicalKey,
      displayName: entry.agent.name,
      detail: entry.agent.description || entry.agent.id,
    }));
    const orgAgents = [
      ...(orgQuery.data?.orgAgents ?? []).map((entry) => ({
        canonicalKey: entry.canonicalKey,
        displayName: entry.agent.name,
        detail: entry.agent.id,
      })),
      ...(orgQuery.data?.staticAgents ?? []).map((entry) => ({
        canonicalKey: entry.canonicalKey,
        displayName: entry.agent.name,
        detail: t('localAdminBuiltIn'),
      })),
    ];
    const guides = (guidesQuery.data?.guides ?? []).map((entry) => ({
      canonicalKey: entry.canonicalKey,
      displayName: entry.guide.name,
      detail: entry.guide.id,
    }));
    const connectors = (connectorsQuery.data?.connectors ?? []).map(
      (entry) => ({
        canonicalKey: entry.canonicalKey,
        displayName: entry.connector.name,
        detail: entry.connector.url,
      }),
    );
    const datasets = (datasetsQuery.data?.datasets ?? []).map((entry) => ({
      canonicalKey: entry.canonicalKey,
      displayName: entry.meta.name,
      detail: entry.meta.id,
    }));
    const lists: Record<
      GroupId,
      { options: DelegationOption[]; unavailable: boolean }
    > = {
      agents: { options: agents, unavailable: false },
      promptAgents: { options: promptAgents, unavailable: false },
      m365Agents: {
        options: m365Agents,
        unavailable:
          m365Query.isError || m365Query.data?.m365AgentsUnavailable === true,
      },
      orgAgents: {
        options: orgAgents,
        unavailable:
          orgQuery.isError || orgQuery.data?.orgAgentsUnavailable === true,
      },
      guides: { options: guides, unavailable: guidesQuery.isError },
      connectors: { options: connectors, unavailable: connectorsQuery.isError },
      datasets: { options: datasets, unavailable: datasetsQuery.isError },
    };
    return GROUP_ORDER.map((id) => ({
      id,
      options: [...lists[id].options].sort(byName),
      unavailable: lists[id].unavailable,
    }));
  }, [
    rows,
    m365Query.data,
    m365Query.isError,
    orgQuery.data,
    orgQuery.isError,
    guidesQuery.data,
    guidesQuery.isError,
    connectorsQuery.data,
    connectorsQuery.isError,
    datasetsQuery.data,
    datasetsQuery.isError,
    t,
  ]);

  const knownKeys = useMemo(
    () => new Set(groups.flatMap((g) => g.options.map((o) => o.canonicalKey))),
    [groups],
  );
  const nameByKey = useMemo(
    () =>
      new Map(
        groups.flatMap((g) =>
          g.options.map((o) => [o.canonicalKey, o.displayName] as const),
        ),
      ),
    [groups],
  );

  const [localAdmins, setLocalAdmins] = useState<LocalAdminEntry[]>([]);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isConflict, setIsConflict] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState<Record<number, string>>({});

  // Seed the editable list from the fetched config; do not clobber unsaved
  // edits when a background refetch lands.
  useEffect(() => {
    if (data && !isDirty) {
      setLocalAdmins(data.config?.localAdmins ?? []);
    }
  }, [data, isDirty]);

  const updateAdmins = (next: LocalAdminEntry[]) => {
    setLocalAdmins(next);
    setIsDirty(true);
    setSaveError(false);
  };

  const updateAdmin = (
    index: number,
    patch: (admin: LocalAdminEntry) => LocalAdminEntry,
  ) => updateAdmins(localAdmins.map((a, i) => (i === index ? patch(a) : a)));

  const setKeys = (index: number, keys: string[]) =>
    updateAdmin(index, (a) => ({ ...a, agentKeys: [...new Set(keys)] }));

  const handleDiscard = () => {
    setLocalAdmins(data?.config?.localAdmins ?? []);
    setIsDirty(false);
    setSaveError(false);
  };

  const handleReload = async () => {
    setIsConflict(false);
    setIsDirty(false);
    await queryClient.invalidateQueries({ queryKey: ['agent-access-config'] });
    await refetch();
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveError(false);
    try {
      const response = await fetch('/api/agent-access/config', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(data?.etag
            ? { 'If-Match': data.etag }
            : { 'If-None-Match': '*' }),
        },
        body: JSON.stringify({
          localAdmins: localAdmins.filter((a) => a.email.trim().length > 0),
        }),
      });
      if (response.status === 409) {
        setIsConflict(true);
        return;
      }
      if (!response.ok) {
        setSaveError(true);
        return;
      }
      toast.success(t('configSaveSuccess'));
      setIsDirty(false);
      await queryClient.invalidateQueries({
        queryKey: ['agent-access-config'],
      });
      // Delegations changed — admin status of affected users may too.
      await queryClient.invalidateQueries({ queryKey: ['agent-access-me'] });
    } catch {
      setSaveError(true);
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">{t('loading')}</p>
    );
  }

  if (error) {
    return (
      <div className="text-sm text-red-600 dark:text-red-400">
        <p>{t('loadError')}</p>
        <button
          type="button"
          className="mt-2 rounded-md border border-gray-300 dark:border-gray-600 px-3 py-1 text-sm text-black dark:text-white hover:bg-gray-100 dark:hover:bg-gray-800"
          onClick={() => refetch()}
        >
          {t('retry')}
        </button>
      </div>
    );
  }

  const totalOptions = groups.reduce((n, g) => n + g.options.length, 0);
  const duplicateEmails = new Set(
    localAdmins
      .map((a) => a.email.trim().toLowerCase())
      .filter((email, i, all) => email && all.indexOf(email) !== i),
  );

  return (
    <div>
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        {t('localAdminsDescription')}
      </p>

      {localAdmins.length === 0 && (
        <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
          {t('noLocalAdmins')}
        </p>
      )}

      <div className="space-y-3">
        {localAdmins.map((admin, index) => {
          const isCollapsed = collapsed.has(index);
          const selected = new Set(admin.agentKeys);
          const query = (search[index] ?? '').trim().toLowerCase();
          const unknownKeys = admin.agentKeys.filter((k) => !knownKeys.has(k));
          const email = admin.email.trim().toLowerCase();
          const isDuplicate = email !== '' && duplicateEmails.has(email);
          const summaryNames = admin.agentKeys
            .map((k) => nameByKey.get(k) ?? k)
            .slice(0, 3);

          return (
            <div
              key={index}
              className="rounded-lg border border-gray-200 dark:border-gray-700"
            >
              {/* Header: email, summary, actions */}
              <div className="flex items-start gap-2 p-3">
                <button
                  type="button"
                  aria-expanded={!isCollapsed}
                  aria-label={t(
                    isCollapsed ? 'localAdminExpand' : 'localAdminCollapse',
                  )}
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (next.has(index)) next.delete(index);
                      else next.add(index);
                      return next;
                    })
                  }
                  className="mt-7 shrink-0 rounded p-0.5 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
                >
                  {isCollapsed ? (
                    <IconChevronRight size={16} />
                  ) : (
                    <IconChevronDown size={16} />
                  )}
                </button>
                <div className="min-w-0 flex-1">
                  <label className="mb-1 block text-sm font-medium text-black dark:text-white">
                    {t('emailLabel')}
                  </label>
                  <EmailAutocompleteInput
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm text-black dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500"
                    value={admin.email}
                    placeholder={t('emailPlaceholder')}
                    suggest={peopleSuggest}
                    suggestionsLabel={tPeople('listLabel')}
                    onChange={(value) =>
                      updateAdmin(index, (a) => ({ ...a, email: value }))
                    }
                  />
                  {isDuplicate && (
                    <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                      {t('localAdminDuplicateEmail')}
                    </p>
                  )}
                  <p className="mt-1 truncate text-xs text-gray-500 dark:text-gray-400">
                    {admin.agentKeys.length === 0
                      ? t('localAdminNoDelegations')
                      : t('localAdminSummary', {
                          count: admin.agentKeys.length,
                          names:
                            admin.agentKeys.length > summaryNames.length
                              ? t('localAdminSummaryMore', {
                                  names: summaryNames.join(', '),
                                  more:
                                    admin.agentKeys.length -
                                    summaryNames.length,
                                })
                              : summaryNames.join(', '),
                        })}
                  </p>
                </div>
                <button
                  type="button"
                  className="mt-6 shrink-0 rounded-md p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-600 dark:text-gray-400 dark:hover:bg-red-900/20 dark:hover:text-red-400"
                  onClick={() =>
                    updateAdmins(localAdmins.filter((_, i) => i !== index))
                  }
                  aria-label={t('removeAdmin')}
                  title={t('removeAdmin')}
                >
                  <IconTrash size={16} />
                </button>
              </div>

              {!isCollapsed && (
                <div className="border-t border-gray-200 px-3 pb-3 pt-2 dark:border-gray-700">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-black dark:text-white">
                      {t('delegatedAgentsLabel')}
                    </span>
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {t('localAdminSelectedCount', {
                        selected: admin.agentKeys.length,
                        total: totalOptions,
                      })}
                    </span>
                    <span className="flex-1" />
                    {localAdmins.length > 1 && (
                      <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400">
                        {t('localAdminCopyFrom')}
                        <select
                          value=""
                          onChange={(e) => {
                            const from = Number(e.target.value);
                            if (!Number.isFinite(from) || from === index)
                              return;
                            setKeys(index, [
                              ...admin.agentKeys,
                              ...localAdmins[from].agentKeys,
                            ]);
                          }}
                          className="rounded border border-gray-300 bg-white px-1 py-0.5 text-xs dark:border-gray-600 dark:bg-gray-800"
                        >
                          <option value="">…</option>
                          {localAdmins.map((other, i) =>
                            i === index || !other.email.trim() ? null : (
                              <option key={i} value={i}>
                                {other.email}
                              </option>
                            ),
                          )}
                        </select>
                      </label>
                    )}
                    {admin.agentKeys.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setKeys(index, [])}
                        className="text-xs text-gray-600 underline hover:text-black dark:text-gray-400 dark:hover:text-white"
                      >
                        {t('localAdminClearAll')}
                      </button>
                    )}
                  </div>

                  {totalOptions > 8 && (
                    <div className="relative mb-2">
                      <IconSearch
                        size={14}
                        className="pointer-events-none absolute left-2 top-2 text-gray-400"
                      />
                      <input
                        type="search"
                        value={search[index] ?? ''}
                        onChange={(e) =>
                          setSearch((prev) => ({
                            ...prev,
                            [index]: e.target.value,
                          }))
                        }
                        placeholder={t('localAdminSearchPlaceholder')}
                        aria-label={t('localAdminSearchPlaceholder')}
                        className="w-full rounded-md border border-gray-300 bg-white py-1 pl-7 pr-2 text-sm dark:border-gray-600 dark:bg-gray-800"
                      />
                    </div>
                  )}

                  {totalOptions === 0 && unknownKeys.length === 0 ? (
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {t('noDelegatedAgents')}
                    </p>
                  ) : (
                    <div className="max-h-96 space-y-3 overflow-y-auto rounded-md border border-gray-200 p-2 dark:border-gray-700">
                      {groups.map((group) => {
                        const visible = query
                          ? group.options.filter(
                              (o) =>
                                o.displayName.toLowerCase().includes(query) ||
                                o.canonicalKey.toLowerCase().includes(query) ||
                                (o.detail ?? '').toLowerCase().includes(query),
                            )
                          : group.options;
                        if (
                          visible.length === 0 &&
                          !group.unavailable &&
                          (query || group.options.length === 0)
                        ) {
                          return null;
                        }
                        const selectedInGroup = group.options.filter((o) =>
                          selected.has(o.canonicalKey),
                        ).length;
                        const allVisibleSelected =
                          visible.length > 0 &&
                          visible.every((o) => selected.has(o.canonicalKey));
                        return (
                          <div key={group.id}>
                            <div className="mb-1 flex items-center gap-2">
                              <span className="text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">
                                {t(`localAdminGroup.${group.id}`)}
                              </span>
                              <span className="text-xs text-gray-400">
                                {selectedInGroup}/{group.options.length}
                              </span>
                              {visible.length > 0 && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setKeys(
                                      index,
                                      allVisibleSelected
                                        ? admin.agentKeys.filter(
                                            (k) =>
                                              !visible.some(
                                                (o) => o.canonicalKey === k,
                                              ),
                                          )
                                        : [
                                            ...admin.agentKeys,
                                            ...visible.map(
                                              (o) => o.canonicalKey,
                                            ),
                                          ],
                                    )
                                  }
                                  className="text-xs text-blue-700 hover:underline dark:text-blue-400"
                                >
                                  {t(
                                    allVisibleSelected
                                      ? 'localAdminClearGroup'
                                      : 'localAdminSelectGroup',
                                  )}
                                </button>
                              )}
                            </div>
                            {group.unavailable ? (
                              <p className="text-xs text-amber-700 dark:text-amber-400">
                                {t('localAdminGroupUnavailable')}
                              </p>
                            ) : (
                              <ul className="space-y-0.5">
                                {visible.map((option) => (
                                  <li key={option.canonicalKey}>
                                    <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-gray-50 dark:hover:bg-gray-800">
                                      <input
                                        type="checkbox"
                                        className="h-4 w-4 accent-gray-600 dark:accent-gray-400"
                                        checked={selected.has(
                                          option.canonicalKey,
                                        )}
                                        onChange={(e) =>
                                          setKeys(
                                            index,
                                            e.target.checked
                                              ? [
                                                  ...admin.agentKeys,
                                                  option.canonicalKey,
                                                ]
                                              : admin.agentKeys.filter(
                                                  (k) =>
                                                    k !== option.canonicalKey,
                                                ),
                                          )
                                        }
                                      />
                                      <span className="truncate text-sm text-black dark:text-gray-200">
                                        {option.displayName}
                                      </span>
                                      {option.detail && (
                                        <span
                                          className="truncate text-xs text-gray-500 dark:text-gray-400"
                                          title={option.canonicalKey}
                                        >
                                          {option.detail}
                                        </span>
                                      )}
                                    </label>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        );
                      })}

                      {/* Delegated keys not present in any listing (entity
                          deleted, renamed, or outside this admin's view). */}
                      {unknownKeys.length > 0 && (
                        <div>
                          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">
                            {t('localAdminGroup.unknown')}
                          </div>
                          <ul className="space-y-0.5">
                            {unknownKeys.map((key) => (
                              <li key={key}>
                                <label className="flex cursor-pointer items-center gap-2 px-1 py-0.5">
                                  <input
                                    type="checkbox"
                                    className="h-4 w-4 accent-gray-600 dark:accent-gray-400"
                                    checked
                                    onChange={() =>
                                      setKeys(
                                        index,
                                        admin.agentKeys.filter(
                                          (k) => k !== key,
                                        ),
                                      )
                                    }
                                  />
                                  <span
                                    className="truncate text-sm italic text-gray-500 dark:text-gray-400"
                                    title={key}
                                  >
                                    {t('unknownAgentKey')}: {key}
                                  </span>
                                </label>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        className="mt-4 flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-black dark:text-white hover:bg-gray-100 dark:hover:bg-gray-800"
        onClick={() => {
          updateAdmins([...localAdmins, { email: '', agentKeys: [] }]);
          setCollapsed((prev) => {
            const next = new Set(prev);
            next.delete(localAdmins.length);
            return next;
          });
        }}
      >
        <IconPlus size={16} />
        {t('addLocalAdmin')}
      </button>

      {isConflict && (
        <div className="mt-4 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-800 dark:text-amber-300">
          <p>{t('configConflictError')}</p>
          <button
            type="button"
            className="mt-2 rounded-md bg-amber-600 px-3 py-1 text-sm font-medium text-white hover:bg-amber-700"
            onClick={handleReload}
          >
            {t('reload')}
          </button>
        </div>
      )}

      {saveError && !isConflict && (
        <p className="mt-4 text-sm text-red-600 dark:text-red-400">
          {t('saveError')}
        </p>
      )}

      <div className="mt-6 flex items-center justify-end gap-2">
        {isDirty && (
          <button
            type="button"
            className="rounded-md border border-gray-200 px-3 py-2 text-sm text-black hover:bg-gray-100 dark:border-gray-700 dark:text-white dark:hover:bg-gray-800"
            onClick={handleDiscard}
            disabled={isSaving}
          >
            {t('localAdminDiscard')}
          </button>
        )}
        <button
          type="button"
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          onClick={handleSave}
          disabled={
            isSaving || isConflict || !isDirty || duplicateEmails.size > 0
          }
        >
          {isSaving ? t('saving') : t('save')}
        </button>
      </div>
    </div>
  );
};
