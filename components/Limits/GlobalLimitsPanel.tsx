'use client';

import { IconAlertTriangle, IconPlus } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FC, useMemo, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';
import {
  PolicyPutBody,
  toPolicyPutDelegation,
} from '@/client/hooks/settings/useLimitsAdmin';

import {
  LimitDelegation,
  LimitEntry,
  LimitOverride,
  LimitsFailMode,
  LimitsMode,
} from '@/lib/services/limits/types';

import { AdminTabs } from '@/components/Admin/AdminTabs';
import {
  ADMIN_BANNER_ERROR,
  ADMIN_BANNER_WARN,
  ADMIN_BTN_PRIMARY,
  ADMIN_BTN_RETRY,
  ADMIN_BTN_SECONDARY,
  ADMIN_CARD,
  ADMIN_CHECKBOX,
  ADMIN_CHIP_NEUTRAL,
  ADMIN_FIELD,
} from '@/components/Admin/adminClasses';
import { CostCalculatorLazy } from '@/components/Limits/CostCalculatorLazy';
import { DelegationsTab } from '@/components/Limits/DelegationsTab';
import { EffectiveLimitsPreview } from '@/components/Limits/EffectiveLimitsPreview';
import { GlobalDefaultsSection } from '@/components/Limits/GlobalDefaultsSection';
import { useLimitsCost } from '@/components/Limits/LimitsCostContext';
import { OverrideEditor } from '@/components/Limits/OverrideEditor';
import { RelevantRulesPopover } from '@/components/Limits/RelevantRulesPopover';
import {
  relevantRulesFor,
  verdictsForTargets,
} from '@/components/Limits/jurisdiction';
import { LIMITS_CHIP_WARN } from '@/components/Limits/limitsClasses';
import { appliesToLine } from '@/components/Limits/summaries';
import {
  PolicyResponse,
  emptyDelegation,
  emptyOverride,
} from '@/components/Limits/types';

/** `cost` exists only while `useLimitsCost().calculator` is on. */
type PanelTab = 'defaults' | 'overrides' | 'delegations' | 'cost';

interface Draft {
  defaults: LimitEntry[];
  overrides: LimitOverride[];
  /**
   * ⚠ Must be present on every PUT. The server refuses a body lacking the
   * key once any delegation is stored (design §9 stale-client guard), and
   * before that guard existed a body without it would erase every
   * delegation and orphan every scoped override.
   */
  delegations: LimitDelegation[];
  mode: LimitsMode;
  failMode: LimitsFailMode;
  timezone: string;
  countByomUsage: boolean;
  countAuxiliaryUsage: boolean;
}

const EMPTY_DRAFT: Draft = {
  defaults: [],
  overrides: [],
  delegations: [],
  mode: 'observe',
  failMode: 'open',
  timezone: 'UTC',
  countByomUsage: false,
  countAuxiliaryUsage: false,
};

function draftFrom(data: PolicyResponse): Draft {
  return data.policy
    ? {
        defaults: data.policy.defaults,
        overrides: data.policy.overrides,
        delegations: data.policy.delegations ?? [],
        mode: data.policy.mode,
        failMode: data.policy.failMode,
        timezone: data.policy.timezone,
        countByomUsage: data.policy.countByomUsage,
        countAuxiliaryUsage: data.policy.countAuxiliaryUsage,
      }
    : EMPTY_DRAFT;
}

/**
 * GLOBAL admin panel for org-wide usage limits.
 *
 * The whole policy is ONE document, so this saves it as one CAS'd PUT with
 * If-Match. On 409 the draft is KEPT and a banner offers Reload / Keep
 * editing (ADMIN_LIMITS_REVIEW #20): with scoped admins writing
 * per-override, a global admin's If-Match goes stale far more often, and
 * discarding a long edit for that is not acceptable.
 *
 * "Keep editing" is an INFORMED last-writer-wins: it refetches the policy in
 * the background and adopts the FRESH etag while leaving the draft alone, so
 * the next Save can actually succeed — and overwrites whatever the other
 * admin changed since this draft was loaded. The banner says so. Merely
 * hiding the banner (the old behaviour) left the stale etag in place, and
 * since the server compares If-Match before any other check (design §5),
 * every subsequent Save re-409'd: a dead end dressed up as an exit.
 *
 * The draft is seeded from each NEW server response during render (the
 * "storing information from previous renders" pattern) and only while not
 * dirty; Reload re-seeds explicitly. No setState in effects.
 */
export const GlobalLimitsPanel: FC = () => {
  const t = useTranslations('limits');
  const queryClient = useQueryClient();
  const { calculator } = useLimitsCost();
  const [selectedTab, setSelectedTab] = useState<PanelTab>('defaults');
  // The cost tab is flag-gated (design §4c). If the flag flips off while it
  // is selected, fall back to Defaults during render — no effect, no
  // setState — so the strip and the panel never disagree.
  const tab: PanelTab =
    selectedTab === 'cost' && !calculator ? 'defaults' : selectedTab;
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [etag, setEtag] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  /** Keep editing is adopting the fresh etag — Save waits for it. */
  const [adoptingEtag, setAdoptingEtag] = useState(false);
  // Records created this session render expanded (a new card must never be
  // a mystery); new delegations are also PUT WITHOUT an id so the server
  // generates one (design §2).
  const [newOverrideIds, setNewOverrideIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [newDelegationIds, setNewDelegationIds] = useState<Set<string>>(
    () => new Set(),
  );

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

  const applyServer = (data: PolicyResponse) => {
    setEtag(data.etag);
    setDraft(draftFrom(data));
    setDirty(false);
    setConflict(false);
    setNewDelegationIds(new Set());
  };

  const [seededFrom, setSeededFrom] = useState<PolicyResponse | null>(null);
  if (
    policyQuery.data &&
    policyQuery.data !== seededFrom &&
    !policyQuery.data.policyUnavailable
  ) {
    setSeededFrom(policyQuery.data);
    if (!dirty) applyServer(policyQuery.data);
  }

  const patch = (next: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...next }));
    setDirty(true);
  };

  const reload = async () => {
    const result = await policyQuery.refetch();
    if (result.data && !result.data.policyUnavailable) {
      applyServer(result.data);
    }
  };

  /**
   * Keep editing after a 409: refetch WITHOUT re-seeding (the draft is dirty,
   * so the render-time seed leaves it alone) and adopt the server's current
   * etag, so the next Save is accepted and overwrites the other admin's
   * changes. If the refetch fails the stale etag stays — the next Save 409s
   * and the banner returns, which is the honest outcome.
   */
  const keepEditing = async () => {
    setConflict(false);
    setAdoptingEtag(true);
    try {
      const result = await policyQuery.refetch();
      if (result.data && !result.data.policyUnavailable) {
        setEtag(result.data.etag);
      }
    } finally {
      setAdoptingEtag(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const body: PolicyPutBody = {
        ...draft,
        delegations: draft.delegations.map((delegation) =>
          toPolicyPutDelegation(
            delegation,
            newDelegationIds.has(delegation.id),
          ),
        ),
      };
      const response = await fetch('/api/limits/policy', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(etag ? { 'If-Match': etag } : {}),
        },
        body: JSON.stringify(body),
      });
      if (response.status === 409) {
        // Keep the draft; the banner offers Reload / Keep editing. Nothing is
        // reloaded here, so the toast must not say it was (the shared
        // `conflict` sentence does).
        setConflict(true);
        toast.error(t('conflictDraftKept'));
        return;
      }
      if (!response.ok) {
        const parsed = await response.json().catch(() => null);
        toast.error(parsed?.details || parsed?.error || t('saveFailed'));
        return;
      }
      toast.success(t('saved'));
      setDirty(false);
      // The effective-limits preview and the scoped view both resolve
      // against the SAVED policy; stale results must not outlive the save.
      await queryClient.invalidateQueries({ queryKey: ['limits-preview'] });
      await queryClient.invalidateQueries({ queryKey: ['limits-scoped'] });
      await reload();
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

  /** Saved delegations only — a new one has no server id to reference yet. */
  const delegationOptions = useMemo(
    () =>
      draft.delegations
        .filter((d) => !newDelegationIds.has(d.id))
        .map((d) => ({ id: d.id, label: d.label || t('untitledDelegation') })),
    [draft.delegations, newDelegationIds, t],
  );
  const delegationById = (id: string) =>
    draft.delegations.find((d) => d.id === id);

  if (unavailable) {
    return (
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
    );
  }

  if (policyQuery.isLoading) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400" role="status">
        {t('loading')}
      </p>
    );
  }

  return (
    <>
      <section className={`mb-6 ${ADMIN_CARD}`}>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-black dark:text-white">
            {t('modeLabel')}
            <select
              className={ADMIN_FIELD}
              value={draft.mode}
              onChange={(e) => patch({ mode: e.target.value as LimitsMode })}
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
              className={`w-44 ${ADMIN_FIELD}`}
              value={draft.timezone}
              onChange={(e) => patch({ timezone: e.target.value })}
            />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-4">
          <label className="flex items-center gap-1.5 text-sm text-black dark:text-white">
            <input
              type="checkbox"
              className={ADMIN_CHECKBOX}
              checked={draft.countByomUsage}
              onChange={(e) => patch({ countByomUsage: e.target.checked })}
            />
            {t('countByom')}
          </label>
          <label className="flex items-center gap-1.5 text-sm text-black dark:text-white">
            <input
              type="checkbox"
              className={ADMIN_CHECKBOX}
              checked={draft.countAuxiliaryUsage}
              onChange={(e) => patch({ countAuxiliaryUsage: e.target.checked })}
            />
            {t('countAuxiliary')}
          </label>
        </div>
        {draft.mode === 'observe' && (
          <p className={`mt-3 ${ADMIN_BANNER_WARN}`}>{t('observeNotice')}</p>
        )}
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {t('propagationNotice')}
        </p>
      </section>

      <AdminTabs
        tabs={[
          { id: 'defaults', label: t('tab.defaults') },
          { id: 'overrides', label: t('tab.overrides') },
          { id: 'delegations', label: t('tab.delegations') },
          ...(calculator
            ? [{ id: 'cost', label: t('cost.calculator.tab') }]
            : []),
        ]}
        activeTab={tab}
        onChange={(id) => setSelectedTab(id as PanelTab)}
        idPrefix="limits"
        ariaLabel={t('tabsLabel')}
      />

      <div
        role="tabpanel"
        id={`limits-panel-${tab}`}
        aria-labelledby={`limits-tab-${tab}`}
      >
        {tab === 'defaults' && (
          <GlobalDefaultsSection
            entries={draft.defaults}
            onChange={(defaults) => patch({ defaults })}
            disabled={saving}
          />
        )}
        {tab === 'overrides' && (
          <div className="space-y-4">
            <EffectiveLimitsPreview overrides={draft.overrides} dirty={dirty} />
            {draft.overrides.length === 0 && (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t('noOverrides')}
              </p>
            )}
            {draft.overrides.map((override, index) => {
              const delegation = override.delegationId
                ? delegationById(override.delegationId)
                : undefined;
              const orphaned = !!override.delegationId && !delegation;
              return (
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
                      overrides: draft.overrides.filter((_, i) => i !== index),
                    })
                  }
                  disabled={saving}
                  globalDefaults={draft.defaults}
                  defaultExpanded={newOverrideIds.has(override.id)}
                  variant={override.delegationId ? 'scoped' : 'global'}
                  appliesTo={appliesToLine(t, override.scope, override.targets)}
                  delegationOptions={delegationOptions}
                  verdicts={
                    delegation
                      ? verdictsForTargets(
                          override.scope,
                          override.targets,
                          delegation.jurisdiction,
                        )
                      : undefined
                  }
                  chips={
                    <>
                      {delegation && (
                        <span className={ADMIN_CHIP_NEUTRAL}>
                          {t('tierScoped')} ·{' '}
                          {delegation.label || t('untitledDelegation')}
                        </span>
                      )}
                      {orphaned && (
                        <span
                          className={LIMITS_CHIP_WARN}
                          title={t('orphanedDelegationNote')}
                        >
                          {t('orphanedDelegationChip')}
                        </span>
                      )}
                    </>
                  }
                  headerActions={
                    <RelevantRulesPopover
                      rules={relevantRulesFor(
                        override.scope,
                        override.targets,
                        {
                          overrides: draft.overrides,
                          delegations: draft.delegations,
                        },
                        override.id,
                      )}
                      delegationLabel={(id) => delegationById(id)?.label}
                    />
                  }
                />
              );
            })}
            <button
              type="button"
              className={ADMIN_BTN_SECONDARY}
              onClick={() => {
                const created = emptyOverride('user');
                setNewOverrideIds((ids) => new Set([...ids, created.id]));
                patch({ overrides: [...draft.overrides, created] });
              }}
              disabled={saving}
            >
              <IconPlus size={16} />
              {t('addOverride')}
            </button>
          </div>
        )}
        {tab === 'delegations' && (
          <DelegationsTab
            delegations={draft.delegations}
            overrides={draft.overrides}
            defaults={draft.defaults}
            newIds={newDelegationIds}
            onChange={(next) => patch(next)}
            onAdd={() => {
              const created = emptyDelegation();
              setNewDelegationIds((ids) => new Set([...ids, created.id]));
              patch({ delegations: [...draft.delegations, created] });
            }}
            disabled={saving}
          />
        )}
        {tab === 'cost' && calculator && (
          <CostCalculatorLazy caps={draft.defaults} mode="global" />
        )}
      </div>

      {conflict && (
        <div role="alert" className={`mt-6 ${ADMIN_BANNER_WARN}`}>
          <p className="flex items-center gap-2">
            <IconAlertTriangle size={16} aria-hidden="true" />
            {t('conflictKeepDraftOverwrite')}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className={ADMIN_BTN_SECONDARY}
              onClick={reload}
              disabled={saving}
            >
              {t('conflictReload')}
            </button>
            <button
              type="button"
              className={ADMIN_BTN_SECONDARY}
              onClick={keepEditing}
              disabled={saving}
            >
              {t('conflictKeepEditing')}
            </button>
          </div>
        </div>
      )}

      {/* Sticky: 17 catalog rows put Save well below the fold, and an
          unsaved policy is the one thing an admin must never lose track
          of. surface-dark-base matches the page plane so the bar does
          not read as a second surface floating over the content. */}
      <div className="sticky bottom-0 -mx-6 mt-6 flex items-center gap-3 border-t border-gray-200 bg-white px-6 py-4 dark:border-gray-700 dark:bg-surface-dark-base">
        <button
          type="button"
          className={ADMIN_BTN_PRIMARY}
          onClick={save}
          disabled={saving || adoptingEtag || !dirty}
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
  );
};
