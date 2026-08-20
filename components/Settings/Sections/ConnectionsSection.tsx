'use client';

import {
  IconBrandOffice,
  IconCheck,
  IconClock,
  IconExclamationCircle,
} from '@tabler/icons-react';
import { FC, useCallback, useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useM365Enabled } from '@/client/hooks/useM365Enabled';
import { useM365PeopleSuggest } from '@/client/hooks/useM365PeopleSuggest';

import { fetchM365Status } from '@/client/services/m365/m365Client';

import type {
  M365FeatureKey,
  M365FeatureStatus,
  M365Status,
} from '@/types/m365';

import { EmailAutocompleteInput } from '@/components/UI/EmailAutocompleteInput';

import { useSettingsStore } from '@/client/stores/settingsStore';

/**
 * Settings → Connections: the per-user Microsoft 365 connection, ON by
 * default since settingsStore v57 (users disconnect here rather than
 * opt in; an explicit choice is remembered across future default changes
 * via m365ConnectedUserSet).
 *
 * Connect/Disconnect flips a local preference only — the tenant-wide admin
 * consent already covers the OAuth side, so there is no extra consent
 * screen. The panel shows, per feature area, whether the tenant grant has
 * actually landed (from /api/m365/status), so "connected but pending admin
 * consent" is visible instead of features just silently missing.
 */

const FEATURE_LABEL_KEYS: Record<M365FeatureKey, string> = {
  files: 'features.files',
  sharepoint: 'features.sharepoint',
  sharepointWrite: 'features.sharepointWrite',
  mail: 'features.mail',
  mailDrafts: 'features.mailDrafts',
  calendar: 'features.calendar',
  people: 'features.people',
  orgDirectory: 'features.orgDirectory',
  tasks: 'features.tasks',
  meetings: 'features.meetings',
  teamsChats: 'features.teamsChats',
  teamsChannels: 'features.teamsChannels',
  groups: 'features.groups',
};

const StatusBadge: FC<{ status: M365FeatureStatus }> = ({ status }) => {
  const t = useTranslations('m365.connections');
  if (status === 'granted') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 dark:text-green-400">
        <IconCheck size={14} /> {t('statusGranted')}
      </span>
    );
  }
  if (status === 'consent_missing') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400">
        <IconClock size={14} /> {t('statusPending')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700 dark:text-red-400">
      <IconExclamationCircle size={14} /> {t('statusError')}
    </span>
  );
};

export const ConnectionsSection: FC = () => {
  const t = useTranslations('m365.connections');
  const tPlaybooks = useTranslations('m365.playbooks');
  const tPeople = useTranslations('peopleSuggest');
  const peopleSuggest = useM365PeopleSuggest();
  const m365Connected = useSettingsStore((s) => s.m365Connected);
  const setM365Connected = useSettingsStore((s) => s.setM365Connected);
  const {
    filesEnabled,
    mailEnabled,
    toolsEnabled,
    playbooksEnabled,
    meetingsEnabled,
  } = useM365Enabled();
  const playbookChipsEnabled = useSettingsStore(
    (s) => s.m365PlaybookChipsEnabled,
  );
  const setPlaybookChipsEnabled = useSettingsStore(
    (s) => s.setM365PlaybookChipsEnabled,
  );
  const sharedMailboxes = useSettingsStore((s) => s.m365SharedMailboxes);
  const setSharedMailboxes = useSettingsStore((s) => s.setM365SharedMailboxes);
  const [mailboxDraft, setMailboxDraft] = useState('');

  const [status, setStatus] = useState<M365Status | null>(null);
  const [loading, setLoading] = useState(false);
  // Failed is tracked separately from "no status yet": a transient toast
  // alone left the rows on "…" forever, indistinguishable from loading.
  // The inline error persists until a re-check succeeds.
  const [loadFailed, setLoadFailed] = useState(false);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      setStatus(await fetchM365Status());
    } catch {
      setStatus(null);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (m365Connected) {
      void loadStatus();
    }
  }, [m365Connected, loadStatus]);

  // Only feature areas whose capability is on are worth showing —
  // a granted scope behind an off flag still does nothing in the UI.
  const visibleFeatures: M365FeatureKey[] = [
    ...(filesEnabled
      ? (['files', 'sharepoint', 'sharepointWrite'] as M365FeatureKey[])
      : []),
    ...(mailEnabled ? (['mail'] as M365FeatureKey[]) : []),
    // The toolset spans mail drafts + calendar/people/tasks/Teams; meetings
    // ride their own flag; groups power access rules regardless of flags.
    ...(toolsEnabled
      ? ([
          'mailDrafts',
          'calendar',
          'people',
          'orgDirectory',
          'tasks',
          'teamsChats',
          'teamsChannels',
        ] as M365FeatureKey[])
      : []),
    ...(meetingsEnabled ? (['meetings'] as M365FeatureKey[]) : []),
    'groups',
  ];

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('title')}
        </h3>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {t('description')}
        </p>
      </div>

      <div className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-800">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <IconBrandOffice
              size={28}
              className="mt-0.5 flex-shrink-0 text-blue-600 dark:text-blue-400"
            />
            <div>
              <div className="font-medium text-gray-900 dark:text-gray-100">
                {t('microsoft365')}
              </div>
              <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
                {t('microsoft365Description')}
              </p>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-500">
                {t('delegatedNote')}
              </p>
              {/* Third-pass open question 1: the grant carries write-level
                  calendar scope though meeting listing only reads. */}
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-500">
                {t('calendarScopeNote')}
              </p>
            </div>
          </div>
          {m365Connected ? (
            <button
              type="button"
              onClick={() => setM365Connected(false)}
              className="min-h-[36px] flex-shrink-0 rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:border-neutral-600 dark:text-gray-200 dark:hover:bg-neutral-700"
            >
              {t('disconnect')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setM365Connected(true)}
              className="min-h-[36px] flex-shrink-0 rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
            >
              {t('connect')}
            </button>
          )}
        </div>

        {m365Connected && (
          <div className="mt-4 border-t border-neutral-200 pt-3 dark:border-neutral-700">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                {t('featureStatus')}
              </span>
              <button
                type="button"
                onClick={() => void loadStatus()}
                disabled={loading}
                className="text-xs text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
              >
                {loading ? t('checking') : t('recheck')}
              </button>
            </div>
            {loadFailed ? (
              <div
                role="alert"
                className="flex items-center gap-1.5 rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-400"
              >
                <IconExclamationCircle size={14} className="flex-shrink-0" />
                <span>{t('statusLoadFailed')}</span>
              </div>
            ) : (
              <ul className="space-y-1.5">
                {visibleFeatures.map((feature) => (
                  <li
                    key={feature}
                    className="flex items-center justify-between text-sm text-gray-800 dark:text-gray-200"
                  >
                    <span>{t(FEATURE_LABEL_KEYS[feature])}</span>
                    {status ? (
                      <StatusBadge status={status.features[feature]} />
                    ) : (
                      <span className="text-xs text-gray-400">…</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {status &&
              visibleFeatures.some(
                (f) => status.features[f] === 'consent_missing',
              ) && (
                <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                  {t('consentPendingHint')}
                </p>
              )}
          </div>
        )}

        {/* Shared mailboxes (fifth pass tier 3): Graph cannot enumerate
            them, so the user maintains the list; mail tools only ever
            target addresses on it. */}
        {toolsEnabled && m365Connected && (
          <div className="mt-4 border-t border-neutral-200 pt-4 dark:border-neutral-700">
            <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {t('sharedMailboxes')}
            </div>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              {t('sharedMailboxesHint')}
            </p>
            <form
              className="mt-2 flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const address = mailboxDraft.trim().toLowerCase();
                if (!address.includes('@')) return;
                setSharedMailboxes([...sharedMailboxes, address]);
                setMailboxDraft('');
              }}
            >
              <EmailAutocompleteInput
                value={mailboxDraft}
                onChange={setMailboxDraft}
                suggest={peopleSuggest}
                suggestionsLabel={tPeople('listLabel')}
                onSelectSuggestion={(email) => {
                  // Picking a suggestion adds it directly — no second
                  // "Add" click for the common case.
                  const address = email.trim().toLowerCase();
                  if (address.includes('@')) {
                    setSharedMailboxes([...sharedMailboxes, address]);
                  }
                  setMailboxDraft('');
                }}
                placeholder={t('sharedMailboxPlaceholder')}
                className="rounded-lg border border-gray-300 bg-gray-50 px-2 py-1.5 text-sm text-gray-900 placeholder-gray-500 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100 dark:placeholder-gray-400"
              />
              <button
                type="submit"
                disabled={!mailboxDraft.trim().includes('@')}
                className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-40 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-700"
              >
                {t('addSharedMailbox')}
              </button>
            </form>
            {sharedMailboxes.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {sharedMailboxes.map((address) => (
                  <li
                    key={address}
                    className="flex items-center gap-1 rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-gray-700 dark:border-neutral-600 dark:text-gray-300"
                  >
                    {address}
                    <button
                      type="button"
                      aria-label={t('removeSharedMailbox', { address })}
                      onClick={() =>
                        setSharedMailboxes(
                          sharedMailboxes.filter((a) => a !== address),
                        )
                      }
                      className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Playbook chips (sixth pass): proactive suggestions can read as
            pushy, so they get a per-user off switch. Menu entries stay. */}
        {playbooksEnabled && m365Connected && (
          <div className="mt-4 border-t border-neutral-200 pt-4 dark:border-neutral-700">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={playbookChipsEnabled}
                onChange={(e) => setPlaybookChipsEnabled(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800"
              />
              <span>
                <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
                  {tPlaybooks('chipsSettingLabel')}
                </span>
                <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                  {tPlaybooks('chipsSettingHint')}
                </span>
              </span>
            </label>
          </div>
        )}
      </div>
    </div>
  );
};
