'use client';

import {
  IconCopy,
  IconPencil,
  IconPlus,
  IconSend,
  IconTrash,
  IconUsers,
} from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  unwrapApiData,
  useAgentAccessAdmin,
} from '@/client/hooks/settings/useAgentAccessAdmin';
import { useAvailableGuides } from '@/client/hooks/settings/useAvailableGuides';

import {
  forkChannelSetData,
  publishRuleName,
} from '@/lib/utils/shared/drafter/channels/channelSets';

import { ChannelSetData } from '@/types/drafter';

import { RuleEditor } from '../RuleEditor';
import {
  AdminChannelSetsResponse,
  AdminRulesResponse,
  CLIENT_CHANNEL_SET_SOURCE,
  CLIENT_DEFAULT_CHANNEL_SET_ID,
  MergedAgentRow,
  clientCanonicalAgentKey,
} from '../types';
import { ChannelSetEditor, buttonClass } from './ChannelSetEditor';

/** Mirrors PUBLISH_SOURCE / PUBLISH_ALL_CHANNELS in agentAccess/types.ts. */
const CLIENT_PUBLISH_SOURCE = 'publish';
const PUBLISH_ALL_CHANNELS = '*';

/** A set as the admin sees it: stored, or the built-in until it is. */
interface SetRow {
  id: string;
  data: ChannelSetData;
  /** Null for the built-in default while no record exists. */
  etag: string | null;
  canEdit: boolean;
  updatedBy?: string;
  updatedAt?: string;
  /** Who may USE the set (`channel-set::<id>`); no rule = everyone. */
  audienceRow: MergedAgentRow;
}

const EMPTY_SET: ChannelSetData = {
  name: '',
  language: '',
  description: '',
  channels: {},
  defaults: { channelIds: [], articleLink: true, guideIds: [] },
  isDefault: false,
};

const badgeClass =
  'shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300';
const iconButtonClass = `${buttonClass} inline-flex items-center gap-1`;

/**
 * Admin list of channel RULE SETS (docs/CHANNEL_DRAFTER_DESIGN.md §4.1):
 * one team's house rules over the global platforms. A comms lead sees the
 * sets they may edit (their own, delegated `channel-set::<id>`), forks one
 * with Duplicate, decides who may use it (the audience rule) and who may
 * send each channel's posts (`publish::<set>/<channel>`, default deny).
 * The built-in default is listed until an admin stores it.
 */
export function ChannelSetsSection() {
  const t = useTranslations('adminChannelSets');
  const ta = useTranslations('agentAccess');
  const tp = useTranslations('adminChannelProfiles');
  const queryClient = useQueryClient();
  const { me } = useAgentAccessAdmin();
  const { guides } = useAvailableGuides();

  const setsQuery = useQuery<AdminChannelSetsResponse>({
    queryKey: ['agent-access-channel-sets'],
    queryFn: async () => {
      const response = await fetch('/api/agent-access/channel-sets');
      if (!response.ok) {
        throw new Error(`Failed to fetch channel sets: ${response.status}`);
      }
      return unwrapApiData<AdminChannelSetsResponse>(await response.json());
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

  /** `''` = creating; an id = that set's editor. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ChannelSetData>(EMPTY_SET);
  const [editingRuleKey, setEditingRuleKey] = useState<string | null>(null);
  /** The set whose per-channel sending rules are shown. */
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rulesByKey = new Map(
    (rulesQuery.data?.rules ?? []).map((rule) => [rule.canonicalKey, rule]),
  );
  const platforms = setsQuery.data?.platforms ?? [];

  /**
   * Whether this admin may write a rule under `key`: the exact key, or the
   * set that owns it for a sending rule. Unknown (not loaded) = no.
   */
  const canEditRule = (key: string): boolean => {
    const keys = me?.editableAgentKeys;
    if (keys === '*') return true;
    // Holding a set covers its sending rules (server: owningKeyOf).
    const owning = /^publish::([^/]+)\/.+$/u.exec(key)?.[1];
    return (
      Array.isArray(keys) &&
      keys.some((entry) => {
        const held = entry.trim().toLowerCase();
        return held === key || (!!owning && held === `channel-set::${owning}`);
      })
    );
  };

  const ruleRow = (
    source: string,
    agentName: string,
    displayName: string,
  ): MergedAgentRow => {
    const canonicalKey = clientCanonicalAgentKey(source, agentName);
    return {
      canonicalKey,
      source,
      agentName,
      displayName,
      discoverable: true,
      stored: rulesByKey.get(canonicalKey) ?? null,
      promptAgent: null,
    };
  };

  const rows: SetRow[] = (() => {
    const data = setsQuery.data;
    if (!data) return [];
    const toRow = (
      id: string,
      setData: ChannelSetData,
      canEdit: boolean,
      stored?: AdminChannelSetsResponse['sets'][number],
    ): SetRow => ({
      id,
      data: setData,
      etag: stored?.etag ?? null,
      canEdit,
      updatedBy: stored?.record.updatedBy,
      updatedAt: stored?.record.updatedAt,
      audienceRow: ruleRow(CLIENT_CHANNEL_SET_SOURCE, id, setData.name),
    });
    const stored = [...data.sets].sort(
      (a, b) =>
        // The default first, then by name: the list reads as "the default,
        // then the teams".
        Number(b.record.id === CLIENT_DEFAULT_CHANNEL_SET_ID) -
          Number(a.record.id === CLIENT_DEFAULT_CHANNEL_SET_ID) ||
        a.record.name.localeCompare(b.record.name),
    );
    return [
      ...(data.virtualDefault
        ? [
            toRow(
              data.virtualDefault.id,
              data.virtualDefault.data,
              data.virtualDefault.canEdit,
            ),
          ]
        : []),
      ...stored.map((entry) =>
        toRow(entry.record.id, entry.record, entry.canEdit, entry),
      ),
    ];
  })();

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ['agent-access-channel-sets'],
      }),
      queryClient.invalidateQueries({ queryKey: ['agent-access-rules'] }),
      queryClient.invalidateQueries({ queryKey: ['channel-sets'] }),
      queryClient.invalidateQueries({ queryKey: ['channel-profiles'] }),
      queryClient.invalidateQueries({
        queryKey: ['channel-drafter-publish-access'],
      }),
    ]);
  };

  const closePanels = () => {
    setError(null);
    setConfirmId(null);
    setEditingRuleKey(null);
    setSendingId(null);
  };

  /** Opens the editor: on a set, on a fork of one, or on a blank set. */
  const openEditor = (id: string | null, initial: ChannelSetData) => {
    closePanels();
    setEditingId(id ?? '');
    setDraft(initial);
  };

  const readError = async (response: Response): Promise<string> => {
    try {
      const json = (await response.json()) as {
        error?: string;
        details?: string;
      };
      return [json.error, json.details].filter(Boolean).join(': ');
    } catch {
      return '';
    }
  };

  const failureMessage = async (
    response: Response,
    /** True when the request could only have raced another admin's write. */
    staleWithoutEtag = false,
  ): Promise<string> => {
    if (response.status === 409 || staleWithoutEtag) {
      // Another admin wrote first: the etag on screen is stale (or, for the
      // built-in default, there was none to send and a record now exists),
      // so reload before the next attempt.
      await setsQuery.refetch();
      return t('conflict');
    }
    return (await readError(response)) || ta('saveError');
  };

  const handleSave = async () => {
    if (editingId === null) return;
    const target = rows.find((entry) => entry.id === editingId);
    const isNew = editingId === '';
    // The built-in default while no record exists: a PUT with no If-Match.
    const storingBuiltIn = !isNew && !!target && target.etag === null;
    setBusy(true);
    setError(null);
    try {
      // A stored set is updated under If-Match; the built-in default's
      // first edit and a new set have no etag to match.
      const response = await fetch('/api/agent-access/channel-sets', {
        method: isNew ? 'POST' : 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(target?.etag ? { 'If-Match': target.etag } : {}),
        },
        body: JSON.stringify(
          isNew ? { data: draft } : { id: editingId, data: draft },
        ),
      });
      if (!response.ok) {
        throw new Error(await failureMessage(response, storingBuiltIn));
      }
      setEditingId(null);
      await invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : ta('saveError'));
    } finally {
      setBusy(false);
    }
  };

  /** Deletes the record; the default's record gone = the built-in again. */
  const handleDelete = async (target: SetRow) => {
    if (!target.etag) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/agent-access/channel-sets?id=${encodeURIComponent(target.id)}`,
        { method: 'DELETE', headers: { 'If-Match': target.etag } },
      );
      if (!response.ok) throw new Error(await failureMessage(response));
      setConfirmId(null);
      await invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : ta('saveError'));
    } finally {
      setBusy(false);
    }
  };

  const ruleEditorFor = (row: MergedAgentRow) => (
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
  );

  const toggleRuleEditor = (key: string) => {
    setEditingId(null);
    setConfirmId(null);
    setEditingRuleKey(editingRuleKey === key ? null : key);
  };

  const editor = (
    <ChannelSetEditor
      setId={editingId || null}
      value={draft}
      onChange={setDraft}
      platforms={platforms}
      guides={guides}
      busy={busy}
      error={error}
      onSave={() => void handleSave()}
      onCancel={() => {
        setEditingId(null);
        setError(null);
      }}
    />
  );

  /** One set's sending rules: a row per enabled channel, default deny. */
  const sendingPanel = (set: SetRow) => (
    <div className="mt-3 space-y-2 rounded-md bg-gray-50 p-3 dark:bg-gray-800/50">
      <p className="text-xs text-gray-600 dark:text-gray-400">
        {tp('sendRuleHint')}
      </p>
      <ul className="space-y-1">
        {platforms
          .filter((platform) => set.data.channels[platform.id]?.enabled)
          .map((platform) => {
            const row = ruleRow(
              CLIENT_PUBLISH_SOURCE,
              publishRuleName(set.id, platform.id),
              `${set.data.name} · ${platform.name}`,
            );
            const open = editingRuleKey === row.canonicalKey;
            const editable = canEditRule(row.canonicalKey);
            return (
              <li key={platform.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 text-sm text-black dark:text-white">
                    {platform.name}
                  </span>
                  <span className={badgeClass}>
                    {row.stored ? tp('sendRuleSet') : tp('sendNobody')}
                  </span>
                  {editable ? (
                    <button
                      type="button"
                      className={iconButtonClass}
                      title={tp('whoMaySend')}
                      onClick={() => toggleRuleEditor(row.canonicalKey)}
                    >
                      <IconSend size={14} aria-hidden />
                      {open ? ta('cancel') : tp('whoMaySend')}
                    </button>
                  ) : (
                    me && (
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {t('sendNeedsDelegation', { key: row.canonicalKey })}
                      </span>
                    )
                  )}
                </div>
                {open && ruleEditorFor(row)}
              </li>
            );
          })}
      </ul>
    </div>
  );

  const allRow = ruleRow(
    CLIENT_PUBLISH_SOURCE,
    PUBLISH_ALL_CHANNELS,
    tp('sendAllChannels'),
  );
  const allOpen = editingRuleKey === allRow.canonicalKey;

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-black dark:text-white">
            {ta('channelSetsTab')}
          </h2>
          <p className="max-w-prose text-sm text-gray-600 dark:text-gray-400">
            {t('intro')}
          </p>
        </div>
        {setsQuery.data?.canCreate !== false && (
          <button
            type="button"
            className={iconButtonClass}
            disabled={busy || !setsQuery.data}
            onClick={() =>
              openEditor(null, {
                ...EMPTY_SET,
                // A blank set offers every platform; the admin prunes.
                channels: Object.fromEntries(
                  platforms.map((platform) => [platform.id, { enabled: true }]),
                ),
              })
            }
          >
            <IconPlus size={16} aria-hidden />
            {t('add')}
          </button>
        )}
      </div>

      {error && editingId === null && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      {setsQuery.isError && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {t('loadFailed')}
        </p>
      )}
      {editingId === '' && editor}

      {canEditRule(allRow.canonicalKey) && (
        <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1">
              <span className="text-sm font-medium text-black dark:text-white">
                {tp('sendTitle')}
              </span>
              <p className="max-w-prose text-xs text-gray-500 dark:text-gray-400">
                {tp('sendIntro')}
              </p>
            </div>
            <span className={badgeClass}>
              {allRow.stored ? tp('sendRuleSet') : tp('sendNobody')}
            </span>
            <button
              type="button"
              className={iconButtonClass}
              onClick={() => toggleRuleEditor(allRow.canonicalKey)}
            >
              <IconSend size={14} aria-hidden />
              {allOpen ? ta('cancel') : tp('sendAllChannels')}
            </button>
          </div>
          {allOpen && ruleEditorFor(allRow)}
        </div>
      )}

      {setsQuery.data && rows.length === 0 && (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('noSets')}
        </p>
      )}

      <ul className="space-y-2">
        {rows.map((entry) => {
          const isBuiltIn = entry.etag === null;
          const isDefaultRecord = entry.id === CLIENT_DEFAULT_CHANNEL_SET_ID;
          const isRestricted =
            entry.audienceRow.stored?.rule.access.type === 'restricted';
          const channelCount = platforms.filter(
            (platform) => entry.data.channels[platform.id]?.enabled,
          ).length;
          const audienceOpen =
            editingRuleKey === entry.audienceRow.canonicalKey;
          return (
            <li
              key={entry.id}
              className="rounded-lg border border-gray-200 p-3 dark:border-gray-700"
            >
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium text-black dark:text-white">
                    {isBuiltIn
                      ? t('builtInName', { name: entry.data.name })
                      : entry.data.name}
                  </span>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {[
                      entry.data.language || t('languageUnset'),
                      t('channelsCount', { count: channelCount }),
                      entry.data.description,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                {entry.data.isDefault && (
                  <span className={badgeClass} title={t('isDefaultHint')}>
                    {t('defaultBadge')}
                  </span>
                )}
                {!isBuiltIn && (
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                      isRestricted
                        ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
                        : 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                    }`}
                    title={t('whoMayUse')}
                  >
                    {isRestricted
                      ? ta('accessRestricted')
                      : ta('accessEveryone')}
                  </span>
                )}
                {isBuiltIn && isRestricted && (
                  <span
                    className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-800 dark:bg-red-900/30 dark:text-red-300"
                    title={t('whoMayUse')}
                  >
                    {ta('accessRestricted')}
                  </span>
                )}
                {!entry.canEdit && (
                  <span className={badgeClass}>{t('readOnly')}</span>
                )}
                {setsQuery.data?.canCreate !== false && (
                  <button
                    type="button"
                    className={iconButtonClass}
                    title={t('duplicateHint')}
                    disabled={busy}
                    onClick={() =>
                      openEditor(
                        null,
                        forkChannelSetData(
                          entry.data,
                          t('copyName', { name: entry.data.name }),
                        ),
                      )
                    }
                  >
                    <IconCopy size={14} aria-hidden />
                    {t('duplicate')}
                  </button>
                )}
                {entry.canEdit && (
                  <>
                    <button
                      type="button"
                      className={iconButtonClass}
                      onClick={() =>
                        editingId === entry.id
                          ? setEditingId(null)
                          : openEditor(entry.id, entry.data)
                      }
                    >
                      <IconPencil size={14} aria-hidden />
                      {editingId === entry.id ? ta('cancel') : t('edit')}
                    </button>
                    <button
                      type="button"
                      className={iconButtonClass}
                      title={t('whoMayUseHint')}
                      onClick={() =>
                        toggleRuleEditor(entry.audienceRow.canonicalKey)
                      }
                    >
                      <IconUsers size={14} aria-hidden />
                      {audienceOpen ? ta('cancel') : t('whoMayUse')}
                    </button>
                    <button
                      type="button"
                      className={iconButtonClass}
                      title={tp('sendTitle')}
                      onClick={() => {
                        setEditingId(null);
                        setConfirmId(null);
                        setEditingRuleKey(null);
                        setSendingId(sendingId === entry.id ? null : entry.id);
                      }}
                    >
                      <IconSend size={14} aria-hidden />
                      {sendingId === entry.id ? ta('cancel') : t('sending')}
                    </button>
                    {entry.etag && (
                      <button
                        type="button"
                        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-red-200 px-3 py-1 text-sm text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-900/20"
                        onClick={() => {
                          setEditingId(null);
                          setConfirmId(
                            confirmId === entry.id ? null : entry.id,
                          );
                        }}
                      >
                        <IconTrash size={14} aria-hidden />
                        {isDefaultRecord ? t('restore') : t('delete')}
                      </button>
                    )}
                  </>
                )}
              </div>
              {entry.updatedBy && entry.updatedAt && (
                <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                  {ta('updatedByLine', {
                    user: entry.updatedBy,
                    date: entry.updatedAt,
                  })}
                </p>
              )}
              {editingId === entry.id && editor}
              {audienceOpen && (
                <div>
                  <p className="mt-3 text-xs text-gray-600 dark:text-gray-400">
                    {t('whoMayUseHint')}
                  </p>
                  {ruleEditorFor(entry.audienceRow)}
                  {/* The editor's own "Everyone" line is written for agents;
                      what it means for a set is said here. */}
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {t('audienceEveryoneHint')}
                  </p>
                </div>
              )}
              {sendingId === entry.id && sendingPanel(entry)}
              {confirmId === entry.id && (
                <div className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-900/20 dark:text-red-300">
                  <p>
                    {isDefaultRecord
                      ? t('restoreConfirm')
                      : t('deleteConfirm', { name: entry.data.name })}
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      className="rounded-md bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                      onClick={() => void handleDelete(entry)}
                      disabled={busy}
                    >
                      {isDefaultRecord ? t('restore') : t('delete')}
                    </button>
                    <button
                      type="button"
                      className="rounded-md px-3 py-1 text-sm text-gray-700 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700"
                      onClick={() => setConfirmId(null)}
                      disabled={busy}
                    >
                      {ta('cancel')}
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
