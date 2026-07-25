'use client';

import { IconAlertTriangle, IconPlus } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { FC, useEffect, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';

import {
  LimitEntry,
  LimitOverride,
  LimitsFailMode,
  LimitsMode,
} from '@/lib/services/limits/types';

import { AdminTabs } from '@/components/Admin/AdminTabs';
import {
  ADMIN_BANNER_ERROR,
  ADMIN_BTN_PRIMARY,
  ADMIN_BTN_RETRY,
  ADMIN_BTN_SECONDARY,
  ADMIN_CARD,
  ADMIN_CHECKBOX,
  ADMIN_FIELD,
  ADMIN_MUTED,
} from '@/components/Admin/adminClasses';
import { GlobalDefaultsSection } from '@/components/Limits/GlobalDefaultsSection';
import { OverrideEditor } from '@/components/Limits/OverrideEditor';
import { PolicyResponse, emptyOverride } from '@/components/Limits/types';

type PanelTab = 'defaults' | 'overrides';

interface Draft {
  defaults: LimitEntry[];
  overrides: LimitOverride[];
  mode: LimitsMode;
  failMode: LimitsFailMode;
  timezone: string;
  countByomUsage: boolean;
  countAuxiliaryUsage: boolean;
}

const EMPTY_DRAFT: Draft = {
  defaults: [],
  overrides: [],
  mode: 'observe',
  failMode: 'open',
  timezone: 'UTC',
  countByomUsage: false,
  countAuxiliaryUsage: false,
};

/**
 * Admin panel for org-wide usage limits.
 *
 * The whole policy is ONE document, so this saves it as one CAS'd PUT with
 * If-Match. On 409 the admin is told another admin won the race and the
 * policy is reloaded — the same discipline the agent-access editors use.
 *
 * The server component gates access; this client is presentation only.
 */
export const LimitsPanel: FC = () => {
  const t = useTranslations('limits');
  const [tab, setTab] = useState<PanelTab>('defaults');
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [etag, setEtag] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const policyQuery = useQuery<PolicyResponse>({
    queryKey: ['limits-policy'],
    queryFn: async () => {
      const response = await fetch('/api/limits/policy');
      if (!response.ok) {
        throw new Error(`Failed to fetch limits policy: ${response.status}`);
      }
      return unwrapApiData<PolicyResponse>(await response.json());
    },
    retry: 1,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    const data = policyQuery.data;
    if (!data || data.policyUnavailable) return;
    setEtag(data.etag);
    setDraft(
      data.policy
        ? {
            defaults: data.policy.defaults,
            overrides: data.policy.overrides,
            mode: data.policy.mode,
            failMode: data.policy.failMode,
            timezone: data.policy.timezone,
            countByomUsage: data.policy.countByomUsage,
            countAuxiliaryUsage: data.policy.countAuxiliaryUsage,
          }
        : EMPTY_DRAFT,
    );
    setDirty(false);
  }, [policyQuery.data]);

  const patch = (next: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...next }));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const response = await fetch('/api/limits/policy', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(etag ? { 'If-Match': etag } : {}),
        },
        body: JSON.stringify(draft),
      });
      if (response.status === 409) {
        toast.error(t('conflict'));
        await policyQuery.refetch();
        return;
      }
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        toast.error(body?.details || body?.error || t('saveFailed'));
        return;
      }
      toast.success(t('saved'));
      await policyQuery.refetch();
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  // ⚠ A storage read failure must NEVER render as an empty form: that would
  // tell an admin nothing is configured (i.e. everything is unlimited) while
  // enforcement is doing something else entirely.
  const unavailable =
    policyQuery.isError || policyQuery.data?.policyUnavailable === true;

  return (
    // Body only. AdminShell owns the page plane (the background that
    // globals.css's unconditional `html, body { background: #171717 }` makes
    // mandatory), the back link and the area switcher.
    <>
      <div>
        <h1 className="mb-2 text-xl font-bold text-black dark:text-white">
          {t('title')}
        </h1>
        <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
          {t('description')}
        </p>

        {unavailable ? (
          <div role="alert" className={ADMIN_BANNER_ERROR}>
            <p className="flex items-center gap-2">
              <IconAlertTriangle size={18} />
              {t('policyUnavailable')}
            </p>
            <button
              type="button"
              className={`mt-3 ${ADMIN_BTN_RETRY}`}
              onClick={() => policyQuery.refetch()}
            >
              {t('retry')}
            </button>
          </div>
        ) : policyQuery.isLoading ? (
          <p className="text-sm text-gray-500 dark:text-gray-400" role="status">
            {t('loading')}
          </p>
        ) : (
          <>
            <section className={`mb-6 ${ADMIN_CARD}`}>
              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 text-sm text-black dark:text-white">
                  {t('modeLabel')}
                  <select
                    className={ADMIN_FIELD}
                    value={draft.mode}
                    onChange={(e) =>
                      patch({ mode: e.target.value as LimitsMode })
                    }
                  >
                    <option value="observe">{t('modeObserve')}</option>
                    <option value="enforce">{t('modeEnforce')}</option>
                  </select>
                </label>
                <label className="flex items-center gap-2 text-sm text-black dark:text-white">
                  {t('failModeLabel')}
                  <select
                    className={ADMIN_FIELD}
                    value={draft.failMode}
                    onChange={(e) =>
                      patch({ failMode: e.target.value as LimitsFailMode })
                    }
                  >
                    <option value="open">{t('failOpen')}</option>
                    <option value="closed">{t('failClosed')}</option>
                  </select>
                </label>
                <label className="flex items-center gap-2 text-sm text-black dark:text-white">
                  {t('timezoneLabel')}
                  <input
                    type="text"
                    className="w-44 rounded-lg border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800"
                    value={draft.timezone}
                    onChange={(e) => patch({ timezone: e.target.value })}
                  />
                </label>
              </div>
              <div className="mt-3 flex flex-wrap gap-4">
                <label className="flex items-center gap-1.5 text-sm text-black dark:text-white">
                  <input
                    type="checkbox"
                    checked={draft.countByomUsage}
                    onChange={(e) =>
                      patch({ countByomUsage: e.target.checked })
                    }
                  />
                  {t('countByom')}
                </label>
                <label className="flex items-center gap-1.5 text-sm text-black dark:text-white">
                  <input
                    type="checkbox"
                    checked={draft.countAuxiliaryUsage}
                    onChange={(e) =>
                      patch({ countAuxiliaryUsage: e.target.checked })
                    }
                  />
                  {t('countAuxiliary')}
                </label>
              </div>
              {draft.mode === 'observe' && (
                <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">
                  {t('observeNotice')}
                </p>
              )}
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                {t('propagationNotice')}
              </p>
            </section>

            <AdminTabs
              tabs={[
                { id: 'defaults', label: t('tab.defaults') },
                { id: 'overrides', label: t('tab.overrides') },
              ]}
              activeTab={tab}
              onChange={(id) => setTab(id as PanelTab)}
              idPrefix="limits"
              ariaLabel={t('tabsLabel')}
            />

            <div
              role="tabpanel"
              id={`limits-panel-${tab}`}
              aria-labelledby={`limits-tab-${tab}`}
            >
              {tab === 'defaults' ? (
                <GlobalDefaultsSection
                  entries={draft.defaults}
                  onChange={(defaults) => patch({ defaults })}
                  disabled={saving}
                />
              ) : (
                <div className="space-y-4">
                  {draft.overrides.length === 0 && (
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {t('noOverrides')}
                    </p>
                  )}
                  {draft.overrides.map((override, index) => (
                    <OverrideEditor
                      key={override.id}
                      override={override}
                      onChange={(next) =>
                        patch({
                          overrides: draft.overrides.map((o, i) =>
                            i === index ? next : o,
                          ),
                        })
                      }
                      onRemove={() =>
                        patch({
                          overrides: draft.overrides.filter(
                            (_, i) => i !== index,
                          ),
                        })
                      }
                      disabled={saving}
                    />
                  ))}
                  <button
                    type="button"
                    className={ADMIN_BTN_SECONDARY}
                    onClick={() =>
                      patch({
                        overrides: [...draft.overrides, emptyOverride('user')],
                      })
                    }
                    disabled={saving}
                  >
                    <IconPlus size={16} />
                    {t('addOverride')}
                  </button>
                </div>
              )}
            </div>

            {/* Sticky: 17 catalog rows put Save well below the fold, and an
                unsaved policy is the one thing an admin must never lose track
                of. surface-dark-base matches the page plane so the bar does
                not read as a second surface floating over the content. */}
            <div className="sticky bottom-0 -mx-6 mt-6 flex items-center gap-3 border-t border-gray-200 bg-white px-6 py-4 dark:border-gray-700 dark:bg-surface-dark-base">
              <button
                type="button"
                className={ADMIN_BTN_PRIMARY}
                onClick={save}
                disabled={saving || !dirty}
              >
                {saving ? t('saving') : t('save')}
              </button>
              {dirty && (
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {t('unsavedChanges')}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
};
