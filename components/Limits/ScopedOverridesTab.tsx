'use client';

import { IconAlertTriangle, IconPlus } from '@tabler/icons-react';
import { FC, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  ScopedDelegationView,
  ScopedLimitsView,
} from '@/client/hooks/settings/useLimitsAdmin';

import { LimitOverride } from '@/lib/services/limits/types';

import {
  ADMIN_BANNER_WARN,
  ADMIN_BTN_SECONDARY,
  ADMIN_HEADING,
  ADMIN_MUTED,
} from '@/components/Admin/adminClasses';
import { EffectiveLimitsPreview } from '@/components/Limits/EffectiveLimitsPreview';
import { ScopeSummary } from '@/components/Limits/ScopeSummary';
import { ScopedOverrideCard } from '@/components/Limits/ScopedOverrideCard';
import {
  hasOpaquePredicate,
  isMailAnchored,
  relevantRulesFor,
} from '@/components/Limits/jurisdiction';
import { emptyOverride } from '@/components/Limits/types';

interface ScopedOverridesTabProps {
  view: ScopedLimitsView;
  /** Re-read the scoped view (after a save, delete, or conflict). */
  onRefetch: () => void;
}

/**
 * SCOPED mode body (design §6b): no Defaults tab, no header controls, no
 * whole-policy save bar. The caller's jurisdiction is always visible at the
 * top; overrides are grouped by delegation when there is more than one;
 * each card saves itself through the scoped endpoint.
 *
 * Two banners come from the SERVER's view, never re-derived here: the
 * post-narrowing flag (an override whose stored targets are now provably
 * outside its jurisdiction) and the disabled-delegation notice (read-only:
 * the inert records stay visible to the person who authored them).
 */
export const ScopedOverridesTab: FC<ScopedOverridesTabProps> = ({
  view,
  onRefetch,
}) => {
  const t = useTranslations('limits');
  const [pendingNew, setPendingNew] = useState<LimitOverride[]>([]);
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(() => new Set());

  const onDirtyChange = (id: string, dirty: boolean) =>
    setDirtyIds((current) => {
      if (current.has(id) === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(id);
      else next.delete(id);
      return next;
    });

  const narrowedCount = view.overrides.filter((o) =>
    o.flags.includes('out-of-scope-targets'),
  ).length;
  const disabledDelegations = view.delegations.filter((d) => !d.enabled);
  // The preview gate (design §6c) runs over ENABLED delegations only — the
  // scoped GET also returns disabled ones (inert, still visible to their
  // author), and counting those would promise a mail preview the server
  // refuses, or hide the group-only note when it is the honest one.
  const enabledDelegations = view.delegations.filter((d) => d.enabled);
  const anyAnchored = enabledDelegations.some((d) =>
    isMailAnchored(d.jurisdiction),
  );
  const anyOpaque = enabledDelegations.some((d) =>
    hasOpaquePredicate(d.jurisdiction),
  );
  /**
   * Why a mail preview cannot work, when it cannot: groups/attributes are
   * opaque to a mail lookup; a jurisdiction with no targets at all (or no
   * enabled delegation) matches nobody — NOT "defined by groups".
   */
  const scopeNote = anyAnchored
    ? undefined
    : anyOpaque
      ? t('previewGroupOnlyScope')
      : t('previewScopeMatchesNobody');

  const pool = useMemo(
    () => ({ overrides: view.overrides, delegations: [] }),
    [view.overrides],
  );

  const renderDelegation = (
    delegation: ScopedDelegationView,
    grouped: boolean,
  ) => {
    const stored = view.overrides.filter(
      (o) => o.delegationId === delegation.id,
    );
    const fresh = pendingNew.filter((o) => o.delegationId === delegation.id);
    const count = stored.length + fresh.length;
    const budgetReached = count >= delegation.maxOverrides;

    return (
      <section
        key={delegation.id}
        aria-labelledby={grouped ? `scoped-${delegation.id}` : undefined}
        className="space-y-3"
      >
        {grouped && (
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={`scoped-${delegation.id}`} className={ADMIN_HEADING}>
              {delegation.label || t('untitledDelegation')}
            </h2>
            <span className={ADMIN_MUTED}>
              {t('delegationOverrideCount', {
                count: stored.length,
                max: delegation.maxOverrides,
              })}
            </span>
          </div>
        )}
        {!grouped && (
          <p className={ADMIN_MUTED}>
            {t('delegationOverrideCount', {
              count: stored.length,
              max: delegation.maxOverrides,
            })}
          </p>
        )}
        {stored.length === 0 && fresh.length === 0 && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('scopedNoOverrides')}
          </p>
        )}
        {stored.map((override) => (
          <ScopedOverrideCard
            key={override.id}
            override={override}
            delegation={delegation}
            serverVerdicts={override.verdicts}
            flags={override.flags}
            relevantRules={relevantRulesFor(
              override.scope,
              override.targets,
              pool,
              override.id,
            )}
            showDelegation={grouped}
            onDiscardNew={() => undefined}
            onSettled={onRefetch}
            onDirtyChange={onDirtyChange}
          />
        ))}
        {fresh.map((override) => (
          <ScopedOverrideCard
            key={override.id}
            override={override}
            delegation={delegation}
            relevantRules={[]}
            showDelegation={grouped}
            isNew
            onDiscardNew={() =>
              setPendingNew((list) => list.filter((o) => o.id !== override.id))
            }
            onSettled={() => {
              // The saved record now comes back from the server list (the
              // mutation awaited the refetch), so the pending copy retires.
              setPendingNew((list) => list.filter((o) => o.id !== override.id));
              onRefetch();
            }}
            onDirtyChange={onDirtyChange}
          />
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={ADMIN_BTN_SECONDARY}
            onClick={() =>
              setPendingNew((list) => [
                ...list,
                emptyOverride('user', delegation.id),
              ])
            }
            disabled={!delegation.enabled || budgetReached}
          >
            <IconPlus size={16} />
            {t('addOverride')}
          </button>
          {budgetReached && delegation.enabled && (
            <span className={ADMIN_MUTED}>
              {t('budgetReached', { max: delegation.maxOverrides })}
            </span>
          )}
        </div>
      </section>
    );
  };

  return (
    <div className="space-y-4">
      {view.mode === 'observe' && (
        <p className={ADMIN_BANNER_WARN}>{t('observeNotice')}</p>
      )}

      <ScopeSummary delegations={view.delegations} sticky />

      {disabledDelegations.map((delegation) => (
        <p key={delegation.id} role="status" className={ADMIN_BANNER_WARN}>
          {t('scopedDelegationDisabledBanner', {
            label: delegation.label || t('untitledDelegation'),
          })}
        </p>
      ))}

      {narrowedCount > 0 && (
        <p
          role="alert"
          className={`flex items-center gap-2 ${ADMIN_BANNER_WARN}`}
        >
          <IconAlertTriangle size={16} aria-hidden="true" />
          {t('narrowingBanner', { count: narrowedCount })}
        </p>
      )}

      {view.delegations.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('scopedNoDelegations')}
        </p>
      ) : (
        <>
          <EffectiveLimitsPreview
            overrides={view.overrides}
            dirty={dirtyIds.size > 0}
            scoped
            scopeNote={scopeNote}
          />
          {view.delegations.length > 1 ? (
            <div className="space-y-8">
              {view.delegations.map((delegation) =>
                renderDelegation(delegation, true),
              )}
            </div>
          ) : (
            renderDelegation(view.delegations[0], false)
          )}
        </>
      )}

      <p className={ADMIN_MUTED}>{t('propagationNotice')}</p>
    </div>
  );
};
