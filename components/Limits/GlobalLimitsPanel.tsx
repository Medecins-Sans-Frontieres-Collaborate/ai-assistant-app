'use client';

import { IconAlertTriangle, IconArrowLeft } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { notifyLimitsChanged } from '@/client/hooks/settings/limitsUxEvents';
import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';
import {
  PolicyPutBody,
  toPolicyPutDelegation,
  useLimitsInsights,
} from '@/client/hooks/settings/useLimitsAdmin';
import {
  collectClientGroupIds,
  seedGroupNames,
  useGroupNames,
} from '@/client/hooks/useGroupNames';

import {
  PolicyChange,
  diffPolicies,
  summarizeChanges,
} from '@/lib/services/limits/policyChanges';
import { LimitsFailMode, LimitsMode } from '@/lib/services/limits/types';

import { AdminTabs } from '@/components/Admin/AdminTabs';
import {
  ADMIN_BANNER_ERROR,
  ADMIN_BANNER_WARN,
  ADMIN_BTN_PRIMARY,
  ADMIN_BTN_RETRY,
  ADMIN_BTN_SECONDARY,
} from '@/components/Admin/adminClasses';
import { AccessLens } from '@/components/Limits/AccessLens';
import { ChangeReview } from '@/components/Limits/ChangeReview';
import { CostCalculatorLazy } from '@/components/Limits/CostCalculatorLazy';
import { DelegationsTab } from '@/components/Limits/DelegationsTab';
import { useLimitsCost } from '@/components/Limits/LimitsCostContext';
import { LimitsOverview } from '@/components/Limits/LimitsOverview';
import { LimitsSettingsStrip } from '@/components/Limits/LimitsSettingsStrip';
import {
  ModelAccessLeaveGuard,
  ModelAccessTab,
} from '@/components/Limits/ModelAccessTab';
import { RuleEditor } from '@/components/Limits/RuleEditor';
import {
  EMPTY_DRAFT,
  LimitsDraft,
  draftFrom,
  draftPolicy,
  revertChange,
  withOverride,
} from '@/components/Limits/limitsDraft';
import {
  PolicyResponse,
  emptyDelegation,
  emptyOverride,
  groupMembershipWarning,
} from '@/components/Limits/types';
import { DirectionMark, SymbolLegend } from '@/components/Limits/visualSyntax';

import { getLimitDefinition } from '@/config/limits';

/** `cost` exists only while `useLimitsCost().calculator` is on. */
type PanelTab = 'overview' | 'person' | 'models' | 'delegations' | 'cost';

/**
 * GLOBAL admin panel for org-wide usage limits.
 *
 * The whole policy is ONE document, so this saves it as one CAS'd PUT with
 * If-Match. On 409 the draft is KEPT and a banner offers Reload / Keep
 * editing: with scoped admins writing per-override, a global admin's
 * If-Match goes stale far more often, and discarding a long edit for that
 * is not acceptable.
 *
 * "Keep editing" is an INFORMED last-writer-wins: it refetches the policy in
 * the background and adopts the FRESH etag while leaving the draft alone, so
 * the next Save can actually succeed — and overwrites whatever the other
 * admin changed since this draft was loaded. The banner says so. The etag
 * must be adopted, not just the banner hidden: the server compares If-Match
 * before any other check (design §5), so a stale one 409s every later Save.
 *
 * The draft is seeded from each NEW server response during render (the
 * "storing information from previous renders" pattern) and only while not
 * dirty; Reload re-seeds explicitly. No setState in effects.
 */
export const GlobalLimitsPanel: FC = () => {
  const t = useTranslations('limits');
  const queryClient = useQueryClient();
  const { calculator } = useLimitsCost();
  const [selectedTab, setSelectedTab] = useState<PanelTab>('overview');
  // The cost tab is flag-gated (design §4c). If the flag flips off while it
  // is selected, fall back to the Overview during render — no effect, no
  // setState — so the strip and the panel never disagree.
  const tab: PanelTab =
    selectedTab === 'cost' && !calculator ? 'overview' : selectedTab;
  const [draft, setDraft] = useState<LimitsDraft>(EMPTY_DRAFT);
  /** The rule open in the editor, under the Overview tab. */
  const [editingRule, setEditingRule] = useState<string | null>(null);
  /** Set by the Models tab while it is shown; see {@link leavingModels}. */
  const modelsLeaveGuard = useRef<ModelAccessLeaveGuard | null>(null);
  /**
   * Review is a STEP, not a tab: the tabs are places to edit, Review is the
   * one screen between editing and saving. It replaces the editing surface,
   * exists only while there is something to review, and leads back.
   */
  const registerModelsGuard = useCallback(
    (guard: ModelAccessLeaveGuard | null) => {
      modelsLeaveGuard.current = guard;
    },
    [],
  );
  const [reviewRequested, setReviewRequested] = useState(false);
  const reviewRef = useRef<HTMLElement>(null);
  const reviewButtonRef = useRef<HTMLButtonElement>(null);
  /** The person the Person tab should open on (set from Review). */
  const [lensMail, setLensMail] = useState<string | undefined>(undefined);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const insightsQuery = useLimitsInsights();
  const [etag, setEtag] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  /** Keep editing is adopting the fresh etag — Save waits for it. */
  const [adoptingEtag, setAdoptingEtag] = useState(false);
  // New delegations are PUT WITHOUT an id so the server generates one
  // (design §2).
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
    // Stored group names into the shared client cache before the cards
    // render, so group overrides and grants show names with no lookup.
    seedGroupNames(data.policy?.groupLabels);
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

  const patch = (next: Partial<LimitsDraft>) => {
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
      // Adopt the SAVED document from the PUT response itself — its etag and
      // the server-minted delegation ids — rather than relying on a follow-up
      // GET. If that GET failed, the old code kept the stale etag (every
      // later Save 409'd) and kept the session-created delegations marked
      // new, so the next Save re-sent them WITHOUT ids and the server minted
      // a second id for each while dropping the first. A response without a
      // policy (not what the route sends) falls back to the refetch.
      const saved = unwrapApiData<Partial<PolicyResponse>>(
        await response.json(),
      );
      if (saved.policy && saved.etag) {
        const fresh: PolicyResponse = {
          policy: saved.policy,
          etag: saved.etag,
          policyUnavailable: false,
        };
        queryClient.setQueryData<PolicyResponse>(['limits-policy'], fresh);
        applyServer(fresh);
      } else {
        setDirty(false);
      }
      // The effective-limits preview and the scoped view both resolve
      // against the SAVED policy; stale results must not outlive the save.
      await queryClient.invalidateQueries({ queryKey: ['limits-preview'] });
      await queryClient.invalidateQueries({ queryKey: ['limits-scoped'] });
      // Every SIGNED-IN USER's picker and own-limits view are stale too —
      // this is the §1b scenario the whole feature was built to fix: an
      // admin blocks a model, saves, and a user's already-open tab must stop
      // offering it without waiting out the 30-60s staleTime
      // (docs/LIMITS_USER_FACING_UX.md §7.3/§8.2). Scoped upserts/deletes
      // already do this via useLimitsAdmin.ts; the global PUT lives in this
      // file instead and was the one save path that never fired it.
      notifyLimitsChanged();
      if (!saved.policy || !saved.etag) await reload();
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
  // Period keys embed the zone, so a zone change starts every day/month
  // counter from zero org-wide and, for the cache TTL, lets replicas debit
  // different documents. Worth saying before Save, not after.
  const savedTimezone = policyQuery.data?.policy?.timezone ?? 'UTC';
  const membershipWarning = groupMembershipWarning(
    policyQuery.data?.groupMembership,
  );
  const groupNames = useGroupNames(
    collectClientGroupIds({
      overrides: draft.overrides,
      jurisdictions: draft.delegations.map((d) => d.jurisdiction),
    }),
  );
  const timezoneChanged =
    policyQuery.data?.policy !== undefined &&
    policyQuery.data?.policy !== null &&
    draft.timezone.trim() !== savedTimezone;

  const savedPolicy = policyQuery.data?.policy ?? null;
  const policy = useMemo(
    () => draftPolicy(draft, savedPolicy),
    [draft, savedPolicy],
  );
  const changes: PolicyChange[] = useMemo(
    () => (dirty ? diffPolicies(savedPolicy, policy) : []),
    [dirty, savedPolicy, policy],
  );
  const summary = summarizeChanges(changes);
  /** Review exists only while there is something to review. */
  const reviewing = reviewRequested && changes.length > 0;
  // The last change was undone, discarded or saved: the request is spent,
  // so a later edit does not jump back into Review by itself.
  if (reviewRequested && !reviewing) setReviewRequested(false);
  // Moving between the two screens moves the keyboard with it: to the
  // review on entering, back to the button that opened it on leaving.
  const wasReviewing = useRef(false);
  useEffect(() => {
    if (reviewing) reviewRef.current?.focus();
    else if (wasReviewing.current) reviewButtonRef.current?.focus();
    wasReviewing.current = reviewing;
  }, [reviewing]);
  const editing = editingRule
    ? draft.overrides.find((override) => override.id === editingRule)
    : undefined;

  /**
   * Runs `proceed` unless the Models tab is holding entries nobody has
   * added yet; then its editor asks first and runs `proceed` on the answer.
   */
  const leavingModels = (proceed: () => void) => {
    if (tab === 'models' && modelsLeaveGuard.current?.(proceed)) return;
    proceed();
  };

  const openRule = (overrideId: string) => {
    setEditingRule(overrideId);
    setSelectedTab('overview');
    setReviewRequested(false);
  };

  const addRule = (limitKey: string) => {
    const def = getLimitDefinition(limitKey);
    const created = emptyOverride('group');
    created.entries = def
      ? [
          {
            limitKey,
            // Start from a real cap, never `null` (unlimited) or Off.
            value:
              def.unit === 'boolean'
                ? true
                : Math.min(100, def.hardCeiling ?? 100),
            ceiling: false,
          },
        ]
      : [];
    patch({ overrides: [...draft.overrides, created] });
    openRule(created.id);
  };

  const discard = () => {
    setConfirmDiscard(false);
    setEditingRule(null);
    if (policyQuery.data) applyServer(policyQuery.data);
  };

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

  const tabs = [
    { id: 'overview', label: t('console.tab.overview') },
    { id: 'person', label: t('console.tab.check') },
    { id: 'models', label: t('tab.models') },
    { id: 'delegations', label: t('tab.delegations') },
    ...(calculator ? [{ id: 'cost', label: t('cost.calculator.tab') }] : []),
  ];

  return (
    <>
      {reviewing && (
        <section
          ref={reviewRef}
          tabIndex={-1}
          aria-label={t('console.reviewRegion')}
          className="space-y-4 focus:outline-none"
        >
          <button
            type="button"
            className={ADMIN_BTN_SECONDARY}
            onClick={() => setReviewRequested(false)}
          >
            <IconArrowLeft size={16} aria-hidden="true" />
            {t('console.backToEditing')}
          </button>
          <ChangeReview
            changes={changes}
            saved={savedPolicy}
            draft={policy}
            insights={insightsQuery.data}
            groupNames={groupNames}
            onUndo={(change) => {
              const next = revertChange(draft, savedPolicy, change);
              setDraft(next);
              setDirty(
                diffPolicies(savedPolicy, draftPolicy(next, savedPolicy))
                  .length > 0,
              );
            }}
            onEditRule={openRule}
            onCheckPerson={(mail) => {
              setLensMail(mail);
              setSelectedTab('person');
              setReviewRequested(false);
            }}
          />
        </section>
      )}
      {!reviewing && (
        <>
          <LimitsSettingsStrip
            draft={draft}
            onChange={patch}
            insights={insightsQuery.data}
            disabled={saving}
            onOpenDelegations={() =>
              leavingModels(() => setSelectedTab('delegations'))
            }
          />
          {membershipWarning && policyQuery.data?.groupMembership && (
            <p className={`mb-4 ${ADMIN_BANNER_WARN}`} role="alert">
              {t(
                membershipWarning === 'structural'
                  ? 'groupMembershipDegradedStructural'
                  : 'groupMembershipDegradedRetryable',
                {
                  reason:
                    policyQuery.data.groupMembership.lastFailure?.reason ?? '',
                },
              )}
              {policyQuery.data.groupMembership.degradedUsers > 0 && (
                <>
                  {' '}
                  {t('groupMembershipDegradedUsers', {
                    count: policyQuery.data.groupMembership.degradedUsers,
                  })}
                </>
              )}
            </p>
          )}
          {timezoneChanged && (
            <p className={`mb-4 ${ADMIN_BANNER_WARN}`} role="note">
              {t('timezoneChangeWarning', {
                from: savedTimezone,
                to: draft.timezone,
              })}
            </p>
          )}

          <AdminTabs
            tabs={tabs}
            activeTab={tab}
            onChange={(id) =>
              leavingModels(() => {
                setSelectedTab(id as PanelTab);
                if (id !== 'overview') setEditingRule(null);
              })
            }
            idPrefix="limits"
            ariaLabel={t('tabsLabel')}
          />

          <div
            role="tabpanel"
            id={`limits-panel-${tab}`}
            aria-labelledby={`limits-tab-${tab}`}
            className="space-y-4"
          >
            {tab === 'overview' && editing && (
              <RuleEditor
                override={editing}
                policy={policy}
                onChange={(next) =>
                  patch({ overrides: withOverride(draft.overrides, next) })
                }
                onRemove={() => {
                  patch({
                    overrides: draft.overrides.filter(
                      (o) => o.id !== editing.id,
                    ),
                  });
                  setEditingRule(null);
                }}
                onBack={() => setEditingRule(null)}
                delegationOptions={delegationOptions}
                groupNames={groupNames}
                insights={insightsQuery.data}
                disabled={saving}
              />
            )}
            {tab === 'overview' && !editing && (
              <>
                <SymbolLegend />
                <LimitsOverview
                  draft={draft}
                  policy={policy}
                  insights={insightsQuery.data}
                  groupNames={groupNames}
                  onDefaultsChange={(defaults) => patch({ defaults })}
                  onEditRule={openRule}
                  onAddRule={addRule}
                  disabled={saving}
                />
              </>
            )}
            {tab === 'person' && (
              <AccessLens
                key={lensMail ?? ''}
                saved={savedPolicy}
                draft={policy}
                dirty={dirty}
                groupNames={groupNames}
                onEditRule={openRule}
                onOverridesChange={(overrides) => patch({ overrides })}
                initialSubject={
                  lensMail ? { kind: 'user', target: lensMail } : undefined
                }
                disabled={saving}
              />
            )}
            {tab === 'models' && (
              <ModelAccessTab
                rules={draft.modelAccess}
                defaults={draft.defaults}
                onChange={(modelAccess) => patch({ modelAccess })}
                mode={draft.mode}
                disabled={saving}
                onLeaveGuard={registerModelsGuard}
              />
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
                managedElsewhere
              />
            )}
            {tab === 'cost' && calculator && (
              <CostCalculatorLazy
                caps={draft.defaults}
                modelAccess={draft.modelAccess}
                mode="global"
              />
            )}
          </div>
        </>
      )}

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

      {/* Sticky: an unsaved policy is the one thing an admin must never lose
          track of. It says what the draft does (looser / stricter / removes
          a cap) and leads to Review before Save. */}
      <div className="sticky bottom-0 -mx-6 mt-6 flex flex-wrap items-center gap-3 border-t border-gray-200 bg-white px-6 py-4 dark:border-gray-700 dark:bg-surface-dark-base">
        {dirty ? (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-900 dark:text-white">
            <strong>
              {t('console.unsavedCount', { count: summary.total })}
            </strong>
            {summary.looser > 0 && (
              <span>
                <DirectionMark direction="looser" />{' '}
                {t('console.countLooser', { count: summary.looser })}
              </span>
            )}
            {summary.stricter > 0 && (
              <span>
                <DirectionMark direction="stricter" />{' '}
                {t('console.countStricter', { count: summary.stricter })}
              </span>
            )}
            {summary.removesCap > 0 && (
              <span>
                <DirectionMark direction="removes-cap" />{' '}
                {t('console.countRemovesCap', { count: summary.removesCap })}
              </span>
            )}
          </span>
        ) : (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {t('propagationNotice')}
          </span>
        )}
        <span className="flex-1" />
        {dirty &&
          (confirmDiscard ? (
            <>
              <span className="text-sm text-gray-900 dark:text-white">
                {t('console.discardConfirm')}
              </span>
              <button
                type="button"
                className={ADMIN_BTN_SECONDARY}
                onClick={discard}
              >
                {t('console.discardYes')}
              </button>
              <button
                type="button"
                className={ADMIN_BTN_SECONDARY}
                onClick={() => setConfirmDiscard(false)}
              >
                {t('cancel')}
              </button>
            </>
          ) : (
            <button
              type="button"
              className={ADMIN_BTN_SECONDARY}
              onClick={() => setConfirmDiscard(true)}
              disabled={saving}
            >
              {t('discard')}
            </button>
          ))}
        {changes.length > 0 &&
          (reviewing ? (
            <button
              type="button"
              className={ADMIN_BTN_SECONDARY}
              onClick={() => setReviewRequested(false)}
            >
              {t('console.backToEditing')}
            </button>
          ) : (
            <button
              type="button"
              ref={reviewButtonRef}
              className={ADMIN_BTN_SECONDARY}
              onClick={() =>
                leavingModels(() => {
                  setEditingRule(null);
                  setReviewRequested(true);
                })
              }
            >
              {t('console.reviewChanges')}
            </button>
          ))}
        <button
          type="button"
          className={ADMIN_BTN_PRIMARY}
          // Entries waiting in the Models add field are not in the draft:
          // the editor asks about them first, and Save is pressed again
          // afterwards (saving straight on would use the draft as it was
          // before the answer).
          onClick={() => {
            if (tab === 'models' && modelsLeaveGuard.current?.(() => {})) {
              return;
            }
            void save();
          }}
          disabled={saving || adoptingEtag || !dirty}
        >
          {saving ? t('saving') : t('save')}
        </button>
      </div>
    </>
  );
};
