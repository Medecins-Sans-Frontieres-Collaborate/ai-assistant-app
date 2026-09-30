'use client';

import { IconPlus } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';

import {
  AdminChannelProfileData,
  AdminChannelProfilesResponse,
} from '../types';

/** A channel as the admin sees it: a built-in, an edited built-in, or theirs. */
interface ChannelRow {
  id: string;
  origin: 'built-in' | 'edited' | 'own';
  enabled: boolean;
  profile: AdminChannelProfileData;
  /** Present when a record exists (an edit, or the organisation's own). */
  etag: string | null;
  updatedBy?: string;
  updatedAt?: string;
}

/** Starting values for a channel of the organisation's own. */
const NEW_CHANNEL: AdminChannelProfileData = {
  name: '',
  family: 'web',
  maxSegments: 1,
  segmentLimit: 1000,
  counting: 'graphemes',
  slots: [],
  hashtags: { max: 0, placement: 'none' },
  links: { allowed: true, position: 'last' },
  threadNumbering: 'none',
  guidance: '',
};

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-black focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-white';
const buttonClass =
  'shrink-0 rounded-md border border-gray-200 px-3 py-1 text-sm text-black hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:text-white dark:hover:bg-gray-800';

/**
 * Admin list of the channel drafter's PLATFORMS
 * (docs/CHANNEL_DRAFTER_DESIGN.md §4.1): what a channel IS. Platform limits
 * drift, so every built-in is listed with its current values and can be
 * corrected, switched off or restored; the organisation can add platforms
 * of its own. Who may use or send is decided per rule set
 * (ChannelSets/ChannelSetsSection), not here.
 */
export function ChannelProfilesSection() {
  const t = useTranslations('agentAccess');
  const tc = useTranslations('adminChannelProfiles');
  const queryClient = useQueryClient();

  const profilesQuery = useQuery<AdminChannelProfilesResponse>({
    queryKey: ['agent-access-channel-profiles'],
    queryFn: async () => {
      const response = await fetch('/api/agent-access/channel-profiles');
      if (!response.ok) {
        throw new Error(`Failed to fetch channel profiles: ${response.status}`);
      }
      return unwrapApiData<AdminChannelProfilesResponse>(await response.json());
    },
    retry: 1,
    refetchOnWindowFocus: false,
  });
  /** `''` = the "add a channel" form; an id = that channel's editor. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AdminChannelProfileData>(NEW_CHANNEL);
  const [draftEnabled, setDraftEnabled] = useState(true);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo<ChannelRow[]>(() => {
    const data = profilesQuery.data;
    if (!data) return [];
    const records = new Map(data.records.map((r) => [r.record.id, r]));
    const toRow = (
      id: string,
      origin: ChannelRow['origin'],
      profile: AdminChannelProfileData,
      stored?: AdminChannelProfilesResponse['records'][number],
    ): ChannelRow => ({
      id,
      origin,
      enabled: stored?.record.enabled ?? true,
      profile,
      etag: stored?.etag ?? null,
      updatedBy: stored?.record.updatedBy,
      updatedAt: stored?.record.updatedAt,
    });
    const builtInIds = new Set(data.builtIns.map((b) => b.id));
    return [
      ...data.builtIns.map((builtIn) => {
        const stored = records.get(builtIn.id);
        return toRow(
          builtIn.id,
          stored ? 'edited' : 'built-in',
          stored?.record.profile ?? builtIn.profile,
          stored,
        );
      }),
      ...data.records
        .filter((stored) => !builtInIds.has(stored.record.id))
        .map((stored) =>
          toRow(stored.record.id, 'own', stored.record.profile, stored),
        )
        .sort((a, b) => a.profile.name.localeCompare(b.profile.name)),
    ];
  }, [profilesQuery.data]);

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ['agent-access-channel-profiles'],
      }),
      queryClient.invalidateQueries({ queryKey: ['channel-profiles'] }),
      // Sets merge the platforms, so a limit change reaches them too.
      queryClient.invalidateQueries({
        queryKey: ['agent-access-channel-sets'],
      }),
      queryClient.invalidateQueries({ queryKey: ['channel-sets'] }),
    ]);
  };

  const openEditor = (target: ChannelRow | null) => {
    setError(null);
    setConfirmId(null);
    setEditingId(target ? target.id : '');
    setDraft(target ? target.profile : NEW_CHANNEL);
    setDraftEnabled(target ? target.enabled : true);
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

  const handleSave = async () => {
    const target = rows.find((entry) => entry.id === editingId);
    setBusy(true);
    setError(null);
    try {
      // A channel with a record is updated under If-Match; without one it
      // is created: as an override (its built-in id) or as a new channel.
      const hasRecord = !!target?.etag;
      const response = await fetch('/api/agent-access/channel-profiles', {
        method: hasRecord ? 'PUT' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(hasRecord && target?.etag ? { 'If-Match': target.etag } : {}),
        },
        body: JSON.stringify({
          ...(target ? { id: target.id } : {}),
          enabled: draftEnabled,
          profile: draft,
        }),
      });
      if (!response.ok) {
        throw new Error(
          response.status === 409
            ? tc('conflict')
            : (await readError(response)) || t('saveError'),
        );
      }
      setEditingId(null);
      await invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveError'));
    } finally {
      setBusy(false);
    }
  };

  /** Deletes the record: a built-in goes back to its shipped values. */
  const handleRemoveRecord = async (target: ChannelRow) => {
    if (!target.etag) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/agent-access/channel-profiles?id=${encodeURIComponent(target.id)}`,
        { method: 'DELETE', headers: { 'If-Match': target.etag } },
      );
      if (!response.ok) {
        throw new Error(
          response.status === 409
            ? tc('conflict')
            : (await readError(response)) || t('saveError'),
        );
      }
      setConfirmId(null);
      await invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveError'));
    } finally {
      setBusy(false);
    }
  };

  const number = (value: string, fallback: number): number => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const editor = (
    <div className="mt-3 space-y-3 rounded-md bg-gray-50 p-3 dark:bg-gray-800/50">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-gray-700 dark:text-gray-300">
          {tc('name')}
          <input
            className={`${inputClass} mt-1`}
            value={draft.name}
            maxLength={60}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <label className="block text-xs text-gray-700 dark:text-gray-300">
          {tc('family')}
          <select
            className={`${inputClass} mt-1`}
            value={draft.family}
            onChange={(e) =>
              setDraft({
                ...draft,
                family: e.target.value as AdminChannelProfileData['family'],
              })
            }
          >
            {(['social', 'email', 'messaging', 'web'] as const).map((f) => (
              <option key={f} value={f}>
                {tc(`families.${f}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-gray-700 dark:text-gray-300">
          {tc('segmentLimit')}
          <input
            type="number"
            min={60}
            className={`${inputClass} mt-1`}
            value={draft.segmentLimit}
            onChange={(e) =>
              setDraft({
                ...draft,
                segmentLimit: number(e.target.value, draft.segmentLimit),
              })
            }
          />
        </label>
        <label className="block text-xs text-gray-700 dark:text-gray-300">
          {tc('counting')}
          <select
            className={`${inputClass} mt-1`}
            value={draft.counting}
            onChange={(e) =>
              setDraft({
                ...draft,
                counting: e.target.value as AdminChannelProfileData['counting'],
              })
            }
          >
            <option value="graphemes">{tc('countingGraphemes')}</option>
            <option value="utf16">{tc('countingUtf16')}</option>
            <option value="url-23">{tc('countingUrl23')}</option>
            <option value="x-weighted">{tc('countingX')}</option>
            <option value="gsm7">{tc('countingGsm7')}</option>
          </select>
        </label>
        <label className="block text-xs text-gray-700 dark:text-gray-300">
          {tc('maxSegments')}
          <input
            type="number"
            min={1}
            max={50}
            className={`${inputClass} mt-1`}
            value={draft.maxSegments}
            onChange={(e) =>
              setDraft({
                ...draft,
                maxSegments: number(e.target.value, draft.maxSegments),
              })
            }
          />
          <span className="mt-1 block text-gray-500 dark:text-gray-400">
            {tc('maxSegmentsHint')}
          </span>
        </label>
        <label className="block text-xs text-gray-700 dark:text-gray-300">
          {tc('threadNumbering')}
          <select
            className={`${inputClass} mt-1`}
            value={draft.threadNumbering}
            disabled={draft.maxSegments <= 1}
            onChange={(e) =>
              setDraft({
                ...draft,
                threadNumbering: e.target
                  .value as AdminChannelProfileData['threadNumbering'],
              })
            }
          >
            <option value="none">{tc('numberingNone')}</option>
            <option value="n/N">{tc('numberingNofN')}</option>
          </select>
        </label>
        <label className="block text-xs text-gray-700 dark:text-gray-300">
          {tc('openingLine')}
          <input
            type="number"
            min={0}
            className={`${inputClass} mt-1`}
            value={draft.slots[0]?.maxChars ?? 0}
            onChange={(e) => {
              const maxChars = number(e.target.value, 0);
              setDraft({
                ...draft,
                slots:
                  maxChars > 0
                    ? [
                        {
                          id: 'opening-line',
                          labelKey: 'openingLine',
                          maxChars,
                          appliesTo: 'first-segment-first-line',
                          foldLabelKey: 'seeMore',
                        },
                      ]
                    : [],
              });
            }}
          />
          <span className="mt-1 block text-gray-500 dark:text-gray-400">
            {tc('openingLineHint')}
          </span>
        </label>
        <label className="block text-xs text-gray-700 dark:text-gray-300">
          {tc('hashtagsMax')}
          <input
            type="number"
            min={0}
            max={30}
            className={`${inputClass} mt-1`}
            value={draft.hashtags.max}
            onChange={(e) => {
              const max = number(e.target.value, draft.hashtags.max);
              setDraft({
                ...draft,
                hashtags: {
                  max,
                  placement:
                    max === 0
                      ? 'none'
                      : draft.hashtags.placement === 'none'
                        ? 'end'
                        : draft.hashtags.placement,
                },
              });
            }}
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-black dark:text-white">
          <input
            type="checkbox"
            checked={draft.links.allowed}
            onChange={(e) =>
              setDraft({
                ...draft,
                links: { ...draft.links, allowed: e.target.checked },
              })
            }
          />
          {tc('linksAllowed')}
        </label>
        <label className="block text-xs text-gray-700 dark:text-gray-300">
          {tc('linksPosition')}
          <select
            className={`${inputClass} mt-1`}
            value={draft.links.position}
            disabled={!draft.links.allowed}
            onChange={(e) =>
              setDraft({
                ...draft,
                links: {
                  ...draft.links,
                  position: e.target.value as 'first' | 'last',
                },
              })
            }
          >
            <option value="last">{tc('linksLast')}</option>
            <option value="first">{tc('linksFirst')}</option>
          </select>
        </label>
      </div>
      <label className="block text-xs text-gray-700 dark:text-gray-300">
        {tc('guidance')}
        <textarea
          className={`${inputClass} mt-1`}
          rows={4}
          maxLength={2000}
          value={draft.guidance}
          onChange={(e) => setDraft({ ...draft, guidance: e.target.value })}
        />
        <span className="mt-1 block text-gray-500 dark:text-gray-400">
          {tc('guidanceHint')}
        </span>
      </label>
      <label className="block text-xs text-gray-700 dark:text-gray-300">
        {tc('publishTarget')}
        <input
          className={`${inputClass} mt-1`}
          maxLength={200}
          value={draft.publishTarget ?? ''}
          onChange={(e) =>
            setDraft({
              ...draft,
              publishTarget: e.target.value.trim() ? e.target.value : undefined,
            })
          }
        />
        <span className="mt-1 block text-gray-500 dark:text-gray-400">
          {tc('publishTargetHint')}
        </span>
      </label>
      <label className="flex items-center gap-2 text-sm text-black dark:text-white">
        <input
          type="checkbox"
          checked={draftEnabled}
          onChange={(e) => setDraftEnabled(e.target.checked)}
        />
        {tc('enabled')}
      </label>
      {!draftEnabled && (
        <p className="text-xs text-amber-800 dark:text-amber-300">
          {tc('disabledHint')}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          className="rounded-md bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          disabled={busy || !draft.name.trim()}
          onClick={() => void handleSave()}
        >
          {t('save')}
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={busy}
          onClick={() => setEditingId(null)}
        >
          {t('cancel')}
        </button>
      </div>
    </div>
  );

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-black dark:text-white">
            {t('channelProfilesTab')}
          </h2>
          <p className="max-w-prose text-sm text-gray-600 dark:text-gray-400">
            {tc('intro')}
          </p>
        </div>
        <button
          type="button"
          className={`${buttonClass} inline-flex items-center gap-1`}
          disabled={busy}
          onClick={() => openEditor(null)}
        >
          <IconPlus size={16} aria-hidden />
          {tc('add')}
        </button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      {profilesQuery.isError && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {tc('loadFailed')}
        </p>
      )}
      {editingId === '' && editor}

      <ul className="space-y-2">
        {rows.map((entry) => {
          return (
            <li
              key={entry.id}
              className="rounded-lg border border-gray-200 p-3 dark:border-gray-700"
            >
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium text-black dark:text-white">
                    {entry.profile.name}
                  </span>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {tc('summary', {
                      limit: entry.profile.segmentLimit,
                      posts: entry.profile.maxSegments,
                    })}
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                  {tc(`origin.${entry.origin}`)}
                </span>
                {!entry.enabled && (
                  <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-900/30 dark:text-amber-300">
                    {tc('off')}
                  </span>
                )}
                <button
                  type="button"
                  className={buttonClass}
                  onClick={() =>
                    editingId === entry.id
                      ? setEditingId(null)
                      : openEditor(entry)
                  }
                >
                  {editingId === entry.id ? t('cancel') : tc('edit')}
                </button>
                {entry.etag && (
                  <button
                    type="button"
                    className="shrink-0 rounded-md border border-red-200 px-3 py-1 text-sm text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-900/20"
                    onClick={() =>
                      setConfirmId(confirmId === entry.id ? null : entry.id)
                    }
                  >
                    {entry.origin === 'edited' ? tc('restore') : tc('delete')}
                  </button>
                )}
              </div>
              {entry.updatedBy && entry.updatedAt && (
                <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                  {t('updatedByLine', {
                    user: entry.updatedBy,
                    date: entry.updatedAt,
                  })}
                </p>
              )}
              {editingId === entry.id && editor}
              {confirmId === entry.id && (
                <div className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-900/20 dark:text-red-300">
                  <p>
                    {entry.origin === 'edited'
                      ? tc('restoreConfirm', { name: entry.profile.name })
                      : tc('deleteConfirm', { name: entry.profile.name })}
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      className="rounded-md bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                      onClick={() => void handleRemoveRecord(entry)}
                      disabled={busy}
                    >
                      {entry.origin === 'edited' ? tc('restore') : tc('delete')}
                    </button>
                    <button
                      type="button"
                      className="rounded-md px-3 py-1 text-sm text-gray-700 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700"
                      onClick={() => setConfirmId(null)}
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
    </div>
  );
}
