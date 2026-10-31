'use client';

import { IconChecklist, IconX } from '@tabler/icons-react';
import { FC, useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { useConversations } from '@/client/hooks/conversation/useConversations';
import { useM365Enabled } from '@/client/hooks/useM365Enabled';

import { buildDigestMessages } from '@/client/services/m365/digest/digestMessage';
import {
  type M365ChannelEntry,
  fetchM365Status,
  listJoinedTeams,
  listTeamChannels,
  startDigestJob,
} from '@/client/services/m365/m365Client';
import {
  DIGEST_MAX_WINDOW_DAYS,
  DIGEST_MAX_WINDOW_MS,
  DIGEST_PRESETS,
  type DigestPeriodPreset,
  resolveDigestWindow,
} from '@/lib/services/m365/digest/digestWindow';

import type { M365FeatureKey, M365Status, M365TeamEntry } from '@/types/m365';
import {
  DIGEST_SOURCE_KINDS,
  type DigestChannelRef,
  type DigestSourceKind,
} from '@/types/m365Digest';

import Modal from '@/components/UI/Modal';

import { useChatStore } from '@/client/stores/chatStore';
import { useDigestLauncherStore } from '@/client/stores/digestLauncherStore';
import { useSettingsStore } from '@/client/stores/settingsStore';

export const DIGEST_MAX_CHANNELS = 10;
/** Above this many channels the launcher warns that the run takes longer. */
export const DIGEST_SLOW_CHANNELS_FROM = 4;

const SOURCE_FEATURE: Record<DigestSourceKind, M365FeatureKey> = {
  mail: 'mail',
  chat: 'teamsChats',
  channel: 'teamsChannels',
  calendar: 'calendar',
};

/** Local calendar date for <input type="date"> (toISOString would give the UTC date). */
const toDateInput = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** The instants a custom range is sent as: local start of day → local end of day. */
const customWindowInstants = (
  start: string,
  end: string,
): { startIso: string; endIso: string; spanMs: number } | null => {
  if (!start || !end) return null;
  const startMs = new Date(`${start}T00:00:00`).getTime();
  const endMs = new Date(`${end}T23:59:59`).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return {
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
    spanMs: endMs - startMs,
  };
};

/**
 * The Daily digest launcher (docs/M365_DAILY_DIGEST.md §6): period, sources
 * and channels are confirmed here before anything is read. Starting a run
 * appends a user line + a pending assistant card to the current
 * conversation; the card polls the job from there. Choices persist as the
 * next run's defaults.
 */
export const M365DigestLauncherModal: FC = () => {
  const t = useTranslations('m365.digest');
  const { isOpen, preset: requestedPreset, close } = useDigestLauncherStore();
  const { digestEnabled } = useM365Enabled();
  const { selectedConversation, updateConversation } = useConversations();
  const isStreaming = useChatStore((s) => s.isStreaming);

  const savedPreset = useSettingsStore((s) => s.m365DigestPreset);
  const savedSources = useSettingsStore((s) => s.m365DigestSources);
  const savedChannels = useSettingsStore((s) => s.m365DigestChannels);
  const setSavedPreset = useSettingsStore((s) => s.setM365DigestPreset);
  const setSavedSources = useSettingsStore((s) => s.setM365DigestSources);
  const setSavedChannels = useSettingsStore((s) => s.setM365DigestChannels);

  const [preset, setPreset] = useState<DigestPeriodPreset>(savedPreset);
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [sources, setSources] = useState<DigestSourceKind[]>(savedSources);
  const [channels, setChannels] = useState<DigestChannelRef[]>(savedChannels);
  const [status, setStatus] = useState<M365Status | null>(null);
  const [teams, setTeams] = useState<M365TeamEntry[] | null>(null);
  const [teamId, setTeamId] = useState('');
  const [teamChannels, setTeamChannels] = useState<M365ChannelEntry[] | null>(
    null,
  );
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [starting, setStarting] = useState(false);

  // Reset to the saved defaults (or the requested preset) on every open.
  useEffect(() => {
    if (!isOpen) return;
    setPreset(requestedPreset ?? savedPreset);
    setSources(savedSources);
    setChannels(savedChannels);
    const now = new Date();
    setCustomEnd(toDateInput(now));
    setCustomStart(toDateInput(new Date(now.getTime() - 7 * 86_400_000)));
    setStatus(null);
    setTeamId('');
    setTeamChannels(null);
    let cancelled = false;
    fetchM365Status()
      .then((result) => {
        if (!cancelled) setStatus(result);
      })
      .catch(() => {
        /* without a status every source stays selectable; the server reports */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- snapshot on open only
  }, [isOpen, requestedPreset]);

  // Opened while the flag is off (a stale card button): close, don't linger.
  useEffect(() => {
    if (isOpen && !digestEnabled) close();
  }, [isOpen, digestEnabled, close]);

  const wantsChannels = sources.includes('channel');
  useEffect(() => {
    if (!isOpen || !wantsChannels || teams !== null) return;
    listJoinedTeams()
      .then(setTeams)
      .catch(() => setTeams([]));
  }, [isOpen, wantsChannels, teams]);

  useEffect(() => {
    if (!teamId) {
      setTeamChannels(null);
      return;
    }
    let cancelled = false;
    setLoadingChannels(true);
    listTeamChannels(teamId)
      .then((result) => {
        if (!cancelled) setTeamChannels(result);
      })
      .catch(() => {
        if (!cancelled) setTeamChannels([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingChannels(false);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  const sourceAvailability = useCallback(
    (kind: DigestSourceKind) =>
      status?.features[SOURCE_FEATURE[kind]] ?? 'granted',
    [status],
  );

  const toggleSource = (kind: DigestSourceKind) =>
    setSources((previous) =>
      previous.includes(kind)
        ? previous.filter((entry) => entry !== kind)
        : [...previous, kind],
    );

  const selectedChannelKeys = useMemo(
    () => new Set(channels.map((c) => `${c.teamId}/${c.channelId}`)),
    [channels],
  );
  const currentTeam = teams?.find((team) => team.groupId === teamId);
  const toggleChannel = (entry: M365ChannelEntry) => {
    const key = `${teamId}/${entry.channelId}`;
    if (selectedChannelKeys.has(key)) {
      setChannels((previous) =>
        previous.filter((c) => `${c.teamId}/${c.channelId}` !== key),
      );
      return;
    }
    if (channels.length >= DIGEST_MAX_CHANNELS) return;
    setChannels((previous) => [
      ...previous,
      {
        teamId,
        channelId: entry.channelId,
        name: `${currentTeam?.name ?? 'Team'} › ${entry.name}`,
      },
    ]);
  };

  // Validate the exact instants that run() sends, so the server agrees.
  const customWindow = customWindowInstants(customStart, customEnd);
  const customInvalid =
    preset === 'custom' &&
    (!customWindow ||
      customWindow.spanMs <= 0 ||
      customWindow.spanMs > DIGEST_MAX_WINDOW_MS);
  const effectiveSources = sources.filter(
    (kind) => sourceAvailability(kind) !== 'consent_missing',
  );
  // While a reply streams, finalizing it rewrites the message list from a
  // pre-stream snapshot and would drop the digest entries.
  const canRun =
    !starting &&
    !isStreaming &&
    !customInvalid &&
    effectiveSources.length > 0 &&
    !(
      wantsChannels &&
      effectiveSources.length === 1 &&
      channels.length === 0
    ) &&
    !!selectedConversation;

  const run = async () => {
    if (!selectedConversation || !canRun) return;
    setStarting(true);
    try {
      const window = resolveDigestWindow(
        preset,
        new Date(),
        preset === 'custom' && customWindow
          ? { startIso: customWindow.startIso, endIso: customWindow.endIso }
          : undefined,
      );
      const request = {
        window: { startIso: window.startIso, endIso: window.endIso, preset },
        sources: effectiveSources,
        channels: wantsChannels ? channels : [],
      };
      const job = await startDigestJob(request);
      setSavedPreset(preset);
      setSavedSources(sources);
      setSavedChannels(channels);
      const periodText =
        preset === 'lastWorkday'
          ? t('period.lastWorkday')
          : preset === 'custom'
            ? `${customStart} – ${customEnd}`
            : t('period.lastDays', { count: Number.parseInt(preset, 10) });
      const [userMessage, assistantMessage] = buildDigestMessages(
        t('userMessage', {
          period: periodText,
          sources: effectiveSources
            .map((kind) => t(`source.${kind}`))
            .join(', '),
        }),
        t('working'),
        job.jobId,
        request,
      );
      updateConversation(selectedConversation.id, {
        messages: [
          ...selectedConversation.messages,
          userMessage,
          assistantMessage,
        ],
      });
      close();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('startFailed'));
    } finally {
      setStarting(false);
    }
  };

  if (!digestEnabled) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={close}
      size="md"
      title={t('title')}
      icon={<IconChecklist size={20} aria-hidden="true" />}
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={close}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-800 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            {t('cancel')}
          </button>
          {isStreaming && (
            <p
              className="text-xs text-amber-700 dark:text-amber-300"
              role="status"
            >
              {t('waitForReply')}
            </p>
          )}
          <button
            type="button"
            disabled={!canRun}
            onClick={() => void run()}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {starting ? t('starting') : t('run')}
          </button>
        </div>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-gray-600 dark:text-gray-400">{t('intro')}</p>

        <fieldset>
          <legend className="mb-1 font-medium text-gray-900 dark:text-gray-100">
            {t('periodLabel')}
          </legend>
          <div className="flex flex-wrap gap-2">
            {DIGEST_PRESETS.map((entry) => (
              <label
                key={entry}
                className={`cursor-pointer rounded-full border px-2.5 py-1 text-xs ${
                  preset === entry
                    ? 'border-blue-500 bg-blue-50 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200'
                    : 'border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800'
                }`}
              >
                <input
                  type="radio"
                  name="digest-preset"
                  value={entry}
                  className="sr-only"
                  checked={preset === entry}
                  onChange={() => setPreset(entry)}
                />
                {t(`preset.${entry}`)}
              </label>
            ))}
          </div>
          {preset === 'lastWorkday' && (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t('lastWorkdayHint')}
            </p>
          )}
          {preset === 'custom' && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <label className="flex items-center gap-1">
                {t('from')}
                <input
                  type="date"
                  value={customStart}
                  max={customEnd}
                  onChange={(event) => setCustomStart(event.target.value)}
                  className="rounded border border-gray-300 px-1.5 py-0.5 dark:border-gray-600 dark:bg-gray-800"
                />
              </label>
              <label className="flex items-center gap-1">
                {t('to')}
                <input
                  type="date"
                  value={customEnd}
                  min={customStart}
                  max={toDateInput(new Date())}
                  onChange={(event) => setCustomEnd(event.target.value)}
                  className="rounded border border-gray-300 px-1.5 py-0.5 dark:border-gray-600 dark:bg-gray-800"
                />
              </label>
              {customInvalid && (
                <span className="text-red-700 dark:text-red-300">
                  {t('customInvalid', { days: DIGEST_MAX_WINDOW_DAYS })}
                </span>
              )}
            </div>
          )}
        </fieldset>

        <fieldset>
          <legend className="mb-1 font-medium text-gray-900 dark:text-gray-100">
            {t('sourcesLabel')}
          </legend>
          <div className="grid grid-cols-2 gap-1">
            {DIGEST_SOURCE_KINDS.map((kind) => {
              const availability = sourceAvailability(kind);
              const blocked = availability === 'consent_missing';
              return (
                <label
                  key={kind}
                  className={`flex items-start gap-2 rounded px-1 py-0.5 ${blocked ? 'opacity-60' : ''}`}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4"
                    checked={sources.includes(kind) && !blocked}
                    disabled={blocked}
                    onChange={() => toggleSource(kind)}
                  />
                  <span>
                    <span className="text-gray-900 dark:text-gray-100">
                      {t(`source.${kind}`)}
                    </span>
                    <span className="block text-xs text-gray-500 dark:text-gray-400">
                      {blocked ? t('sourceNoConsent') : t(`sourceHint.${kind}`)}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {wantsChannels &&
          sourceAvailability('channel') !== 'consent_missing' && (
            <fieldset>
              <legend className="mb-1 font-medium text-gray-900 dark:text-gray-100">
                {t('channelsLabel', {
                  count: channels.length,
                  max: DIGEST_MAX_CHANNELS,
                })}
              </legend>
              {channels.length > 0 && (
                <ul className="mb-2 flex flex-wrap gap-1">
                  {channels.map((channel) => (
                    <li
                      key={`${channel.teamId}/${channel.channelId}`}
                      className="inline-flex items-center gap-1 rounded-full border border-gray-300 pl-2 pr-1 py-0.5 text-xs dark:border-gray-600"
                    >
                      {channel.name}
                      <button
                        type="button"
                        aria-label={t('removeChannel', { name: channel.name })}
                        onClick={() =>
                          setChannels((previous) =>
                            previous.filter(
                              (c) =>
                                c.teamId !== channel.teamId ||
                                c.channelId !== channel.channelId,
                            ),
                          )
                        }
                        className="rounded-full p-0.5 text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700"
                      >
                        <IconX size={11} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {channels.length >= DIGEST_SLOW_CHANNELS_FROM && (
                <p
                  className="mb-2 text-xs text-amber-800 dark:text-amber-300"
                  role="note"
                >
                  {channels.length >= DIGEST_MAX_CHANNELS
                    ? t('channelsMax', { max: DIGEST_MAX_CHANNELS })
                    : t('channelsSlow')}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label={t('teamLabel')}
                  value={teamId}
                  onChange={(event) => setTeamId(event.target.value)}
                  className="rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800"
                >
                  <option value="">
                    {teams === null ? t('loadingTeams') : t('pickTeam')}
                  </option>
                  {(teams ?? []).map((team) => (
                    <option key={team.groupId} value={team.groupId}>
                      {team.name}
                    </option>
                  ))}
                </select>
                {loadingChannels && (
                  <span className="text-xs text-gray-500">
                    {t('loadingChannels')}
                  </span>
                )}
              </div>
              {teamChannels && teamChannels.length > 0 && (
                <ul className="mt-2 max-h-40 space-y-0.5 overflow-y-auto rounded border border-gray-200 p-1 dark:border-gray-700">
                  {teamChannels.map((entry) => {
                    const key = `${teamId}/${entry.channelId}`;
                    const checked = selectedChannelKeys.has(key);
                    const full =
                      !checked && channels.length >= DIGEST_MAX_CHANNELS;
                    return (
                      <li key={entry.channelId}>
                        <label
                          className={`flex items-center gap-2 px-1 text-xs ${full ? 'opacity-50' : ''}`}
                        >
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5"
                            checked={checked}
                            disabled={full}
                            onChange={() => toggleChannel(entry)}
                          />
                          {entry.name}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
              {teamChannels && teamChannels.length === 0 && (
                <p className="mt-1 text-xs text-gray-500">{t('noChannels')}</p>
              )}
              {wantsChannels &&
                effectiveSources.length === 1 &&
                channels.length === 0 && (
                  <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
                    {t('channelsNeeded')}
                  </p>
                )}
            </fieldset>
          )}

        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t('privacyNote')}
        </p>
      </div>
    </Modal>
  );
};
