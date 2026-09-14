'use client';

import { IconInfoCircle, IconPlus } from '@tabler/icons-react';
import { FC, useMemo } from 'react';

import { useTranslations } from 'next-intl';

import { MAX_OVERRIDES } from '@/lib/services/limits/policyWriteSchema';
import {
  LimitDelegation,
  LimitEntry,
  LimitOverride,
} from '@/lib/services/limits/types';

import {
  ADMIN_BANNER_WARN,
  ADMIN_BTN_SECONDARY,
  ADMIN_MUTED,
} from '@/components/Admin/adminClasses';
import { DelegationEditor } from '@/components/Limits/DelegationEditor';
import {
  LiftableEntry,
  delegationOverlaps,
  mergeRelevantRules,
  overlapsFor,
  relevantRulesFor,
} from '@/components/Limits/jurisdiction';
import { LIMITS_NOTE_CARD } from '@/components/Limits/limitsClasses';

/** The document's override budget — the server's own constant, design §5. */
export const DOCUMENT_OVERRIDE_CAP = MAX_OVERRIDES;

export interface DelegationsPatch {
  delegations?: LimitDelegation[];
  overrides?: LimitOverride[];
  defaults?: LimitEntry[];
}

interface DelegationsTabProps {
  delegations: LimitDelegation[];
  overrides: LimitOverride[];
  defaults: LimitEntry[];
  /** Delegations created this session (render expanded; PUT omits their id). */
  newIds: Set<string>;
  /**
   * ONE patch per user action. A cascade delete removes the delegation AND
   * its overrides in the same call — two calls would let an intermediate
   * render carry overrides pointing at a delegation that no longer exists,
   * which the PUT rejects (design §5).
   */
  onChange: (patch: DelegationsPatch) => void;
  onAdd: () => void;
  disabled?: boolean;
}

/**
 * Delegations tab (design §6a): one DelegationEditor per delegation, the
 * budget line (global overrides + Σ maxOverrides must fit the document cap,
 * or scoped admins get refused with an error only a global admin can fix),
 * and the overlap hint — informational, not red: §3b makes overlapping
 * jurisdictions deterministic, one delegation per audience is just simpler.
 */
export const DelegationsTab: FC<DelegationsTabProps> = ({
  delegations,
  overrides,
  defaults,
  newIds,
  onChange,
  onAdd,
  disabled = false,
}) => {
  const t = useTranslations('limits');

  const overlaps = useMemo(
    () => delegationOverlaps(delegations),
    [delegations],
  );
  const labelFor = (id: string) =>
    delegations.find((d) => d.id === id)?.label || t('untitledDelegation');

  const globalOverrideCount = overrides.filter((o) => !o.delegationId).length;
  const allocated = delegations.reduce((sum, d) => sum + d.maxOverrides, 0);
  const budgetUsed = globalOverrideCount + allocated;
  const budgetExceeded = budgetUsed > DOCUMENT_OVERRIDE_CAP;

  const ownedBy = (id: string) =>
    overrides.filter((o) => o.delegationId === id);

  const sameCell = (a: LimitEntry, b: LimitEntry) =>
    a.limitKey === b.limitKey &&
    a.modelId === b.modelId &&
    a.series === b.series;

  /** Pin one liftable row — see `liftableEntries` for the three sources. */
  const lift = (item: LiftableEntry) => {
    const { entry } = item;
    switch (item.source) {
      case 'default':
        onChange({
          defaults: defaults.map((candidate) =>
            sameCell(candidate, entry)
              ? { ...candidate, ceiling: true }
              : candidate,
          ),
        });
        return;
      case 'catalog':
        // Configure the compiled default at its own value, pinned: the
        // resolver reads ceilings off entries, so a catalog-only key has
        // nothing to pin until a default exists for it.
        onChange({
          defaults: [
            ...defaults,
            { limitKey: entry.limitKey, value: entry.value, ceiling: true },
          ],
        });
        return;
      case 'override':
        onChange({
          overrides: overrides.map((override) =>
            override.id === item.overrideId
              ? {
                  ...override,
                  entries: override.entries.map((candidate) =>
                    sameCell(candidate, entry)
                      ? { ...candidate, ceiling: true }
                      : candidate,
                  ),
                }
              : override,
          ),
        });
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600 dark:text-gray-400">
        {t('delegationsDescription')}
      </p>
      <p
        className={budgetExceeded ? ADMIN_BANNER_WARN : ADMIN_MUTED}
        role={budgetExceeded ? 'alert' : undefined}
      >
        {budgetExceeded
          ? t('delegationsBudgetExceeded', {
              used: budgetUsed,
              cap: DOCUMENT_OVERRIDE_CAP,
            })
          : t('delegationsBudget', {
              allocated,
              global: globalOverrideCount,
              cap: DOCUMENT_OVERRIDE_CAP,
            })}
      </p>

      {overlaps.length > 0 && (
        <div className={LIMITS_NOTE_CARD} role="note">
          <p className="flex items-center gap-2 font-medium text-black dark:text-white">
            <IconInfoCircle size={16} aria-hidden="true" />
            {t('overlapTitle')}
          </p>
          <p className="mt-1">{t('overlapBody')}</p>
          <ul className="mt-1 list-inside list-disc">
            {overlaps.map((overlap) => (
              <li key={`${overlap.a}|${overlap.b}|${overlap.scope}`}>
                {t('overlapRow', {
                  a: labelFor(overlap.a),
                  b: labelFor(overlap.b),
                  scope: t(`scope.${overlap.scope}` as never),
                  shared:
                    overlap.shared.length > 3
                      ? t('appliesToMore', {
                          targets: overlap.shared.slice(0, 3).join(', '),
                          more: overlap.shared.length - 3,
                        })
                      : overlap.shared.join(', '),
                })}
              </li>
            ))}
          </ul>
        </div>
      )}

      {delegations.length === 0 && (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('noDelegations')}
        </p>
      )}

      {delegations.map((delegation) => {
        const owned = ownedBy(delegation.id);
        return (
          <DelegationEditor
            key={delegation.id}
            delegation={delegation}
            ownedOverrides={owned}
            overlaps={overlapsFor(overlaps, delegation.id)}
            relevantRules={mergeRelevantRules(
              // One query per predicate; a rule meeting two of them (a
              // domain plus a user inside it) must still be listed once.
              delegation.jurisdiction.flatMap((predicate) =>
                relevantRulesFor(
                  predicate.scope,
                  predicate.targets,
                  {
                    overrides: overrides.filter(
                      (o) => o.delegationId !== delegation.id,
                    ),
                    delegations,
                  },
                  delegation.id,
                ),
              ),
            )}
            labelFor={labelFor}
            globalDefaults={defaults}
            globalOverrides={overrides}
            onChange={(next) =>
              onChange({
                delegations: delegations.map((d) =>
                  d.id === delegation.id ? next : d,
                ),
              })
            }
            onRemove={() =>
              onChange({
                delegations: delegations.filter((d) => d.id !== delegation.id),
              })
            }
            onDisable={() =>
              onChange({
                delegations: delegations.map((d) =>
                  d.id === delegation.id ? { ...d, enabled: false } : d,
                ),
              })
            }
            onDeleteWithOverrides={() =>
              onChange({
                delegations: delegations.filter((d) => d.id !== delegation.id),
                overrides: overrides.filter(
                  (o) => o.delegationId !== delegation.id,
                ),
              })
            }
            onLiftDefault={lift}
            disabled={disabled}
            defaultExpanded={newIds.has(delegation.id)}
            isNew={newIds.has(delegation.id)}
          />
        );
      })}

      <button
        type="button"
        className={ADMIN_BTN_SECONDARY}
        onClick={onAdd}
        disabled={disabled}
      >
        <IconPlus size={16} />
        {t('addDelegation')}
      </button>
    </div>
  );
};
