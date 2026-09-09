'use client';

import {
  IconAlertTriangle,
  IconChevronDown,
  IconChevronRight,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { FC, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useAgentAccessGroupsEnabled } from '@/client/hooks/useAgentAccessGroupsEnabled';
import { useM365PeopleSuggest } from '@/client/hooks/useM365PeopleSuggest';

import {
  JurisdictionPredicate,
  LimitDelegation,
  LimitEntry,
  LimitOverride,
  OverrideScope,
} from '@/lib/services/limits/types';

import {
  ADMIN_BANNER_WARN,
  ADMIN_BTN_ICON_DANGER,
  ADMIN_BTN_SECONDARY,
  ADMIN_CARD,
  ADMIN_CHECKBOX,
  ADMIN_CHIP_NEUTRAL,
  ADMIN_FIELD,
  ADMIN_HINT,
  ADMIN_LABEL,
  ADMIN_MUTED,
  ADMIN_ROW,
} from '@/components/Admin/adminClasses';
import { ChipListInput } from '@/components/AgentAccess/ChipListInput';
import { GroupSearchPicker } from '@/components/AgentAccess/GroupSearchPicker';
import { normalizeDomainEntry } from '@/components/AgentAccess/RuleEditor';
import { RelevantRulesPopover } from '@/components/Limits/RelevantRulesPopover';
import {
  DelegationOverlap,
  RelevantRule,
  isMailAnchored,
  liftableDefaults,
  narrowedOverrideCount,
} from '@/components/Limits/jurisdiction';
import { LIMITS_CHIP_WARN } from '@/components/Limits/limitsClasses';
import { jurisdictionLine } from '@/components/Limits/summaries';

import { getLimitDefinition } from '@/config/limits';

interface DelegationEditorProps {
  delegation: LimitDelegation;
  /** Draft overrides currently carrying this delegation's id. */
  ownedOverrides: LimitOverride[];
  /** Overlaps involving THIS delegation (design §6a). */
  overlaps: DelegationOverlap[];
  /** Other rules that speak to this jurisdiction's targets (self excluded). */
  relevantRules: RelevantRule[];
  /** Delegation id → label, for the overlap chip title and popover chips. */
  labelFor: (id: string) => string;
  /** Draft global defaults, for the liftable-defaults list. */
  globalDefaults: LimitEntry[];
  onChange: (next: LimitDelegation) => void;
  /** Plain removal — offered only while the delegation owns no overrides. */
  onRemove: () => void;
  /** Blocked-delete offer 1: keep the record, set enabled=false. */
  onDisable: () => void;
  /** Blocked-delete offer 2: remove the delegation AND its overrides in ONE patch. */
  onDeleteWithOverrides: () => void;
  /** Tick `ceiling` on one global default (one click from the liftable list). */
  onLiftDefault: (entry: LimitEntry) => void;
  disabled?: boolean;
  defaultExpanded?: boolean;
  /** Created this session — no server id yet; the header says so. */
  isNew?: boolean;
}

const SCOPES: OverrideScope[] = ['domain', 'user', 'group', 'attribute'];

/**
 * One delegation record (design §6a): who the scoped admins are, what
 * jurisdiction confines them, and how many overrides they may hold.
 *
 * Four things this card must make visible, because a delegation is by
 * default authority to RAISE every non-ceiling limit inside its
 * jurisdiction:
 *  - liftable defaults (global defaults without `ceiling`), one click to pin;
 *  - anchoring — a warning when no domain or user predicate anchors the
 *    jurisdiction (§8: group-only jurisdictions inherit the group cache's
 *    failure posture and cannot be previewed by mail);
 *  - overlap with another delegation, as a chip plus the relevant-rules
 *    popover — not an error, §3b makes the outcome deterministic;
 *  - the narrowing preview: how many of its overrides would fall outside
 *    the jurisdiction as currently drafted, BEFORE save.
 *
 * Deleting a delegation that still owns overrides is blocked with the count
 * and two offers (disable / delete with its overrides), so nothing is ever
 * orphaned into the global tier.
 */
export const DelegationEditor: FC<DelegationEditorProps> = ({
  delegation,
  ownedOverrides,
  overlaps,
  relevantRules,
  labelFor,
  globalDefaults,
  onChange,
  onRemove,
  onDisable,
  onDeleteWithOverrides,
  onLiftDefault,
  disabled = false,
  defaultExpanded = true,
  isNew = false,
}) => {
  const t = useTranslations('limits');
  const tPeople = useTranslations('peopleSuggest');
  const peopleSuggest = useM365PeopleSuggest();
  const groupsEnabled = useAgentAccessGroupsEnabled();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const update = (patch: Partial<LimitDelegation>) =>
    onChange({ ...delegation, ...patch });

  const setPredicate = (index: number, next: JurisdictionPredicate) =>
    update({
      jurisdiction: delegation.jurisdiction.map((p, i) =>
        i === index ? next : p,
      ),
    });

  const anchored = isMailAnchored(delegation.jurisdiction);
  const jurisdictionEmpty = delegation.jurisdiction.every(
    (p) => p.targets.length === 0,
  );
  const narrowed = useMemo(
    () => narrowedOverrideCount(delegation.jurisdiction, ownedOverrides),
    [delegation.jurisdiction, ownedOverrides],
  );
  const liftable = useMemo(
    () => liftableDefaults(globalDefaults),
    [globalDefaults],
  );
  const overlapPartners = useMemo(
    () => [
      ...new Set(overlaps.map((o) => (o.a === delegation.id ? o.b : o.a))),
    ],
    [overlaps, delegation.id],
  );
  const count = ownedOverrides.length;

  const requestDelete = () => {
    if (count === 0) {
      onRemove();
      return;
    }
    setConfirmDelete(true);
  };

  const liftableLabel = (entry: LimitEntry): string => {
    const def = getLimitDefinition(entry.limitKey);
    const base = def ? t(`label.${def.labelKey}` as never) : entry.limitKey;
    const qualifier = entry.modelId ?? entry.series;
    return qualifier ? `${base} — ${qualifier}` : base;
  };

  return (
    <div className={ADMIN_CARD}>
      <div className="flex items-start gap-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={
            expanded ? t('collapseDelegation') : t('expandDelegation')
          }
        >
          {expanded ? (
            <IconChevronDown size={16} aria-hidden="true" />
          ) : (
            <IconChevronRight size={16} aria-hidden="true" />
          )}
          <span className="text-sm font-medium text-black dark:text-white">
            {delegation.label || t('untitledDelegation')}
          </span>
          {!delegation.enabled && (
            <span className={ADMIN_CHIP_NEUTRAL}>
              {t('delegationDisabledChip')}
            </span>
          )}
          {isNew && (
            <span className={ADMIN_CHIP_NEUTRAL}>{t('delegationNewChip')}</span>
          )}
          {overlapPartners.length > 0 && (
            <span
              className={LIMITS_CHIP_WARN}
              title={overlapPartners.map(labelFor).join(', ')}
            >
              {t('overlapChip')}
            </span>
          )}
          {!anchored && !jurisdictionEmpty && (
            <span className={LIMITS_CHIP_WARN}>{t('anchorChip')}</span>
          )}
          <span className={`ml-auto ${ADMIN_MUTED}`}>
            {t('delegationAdminsCount', { count: delegation.admins.length })} ·{' '}
            {t('delegationOverrideCount', {
              count,
              max: delegation.maxOverrides,
            })}
          </span>
          {!expanded && (
            <span className={`w-full ${ADMIN_MUTED}`}>
              {jurisdictionLine(t, delegation.jurisdiction)}
            </span>
          )}
        </button>
        <RelevantRulesPopover
          rules={relevantRules}
          delegationLabel={labelFor}
        />
      </div>

      {expanded && (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              className={`min-w-[180px] flex-1 ${ADMIN_FIELD}`}
              value={delegation.label}
              onChange={(e) => update({ label: e.target.value })}
              placeholder={t('delegationLabelPlaceholder')}
              disabled={disabled}
              aria-label={t('delegationLabelLabel')}
            />
            <label className="flex items-center gap-1.5 text-sm text-black dark:text-white">
              <input
                type="checkbox"
                className={ADMIN_CHECKBOX}
                checked={delegation.enabled}
                onChange={(e) => update({ enabled: e.target.checked })}
                disabled={disabled}
              />
              {t('delegationEnabled')}
            </label>
            <label className="flex items-center gap-1.5 text-sm text-black dark:text-white">
              {t('delegationMaxOverridesLabel')}
              <input
                type="number"
                min={0}
                max={100}
                className={`w-20 ${ADMIN_FIELD}`}
                value={delegation.maxOverrides}
                onChange={(e) => {
                  const parsed = Number.parseInt(e.target.value, 10);
                  update({
                    maxOverrides: Number.isNaN(parsed)
                      ? 0
                      : Math.max(0, Math.min(100, parsed)),
                  });
                }}
                disabled={disabled}
                aria-label={t('delegationMaxOverridesLabel')}
              />
            </label>
            <button
              type="button"
              className={ADMIN_BTN_ICON_DANGER}
              onClick={requestDelete}
              disabled={disabled}
              aria-label={t('removeDelegation')}
            >
              <IconTrash size={16} />
            </button>
          </div>
          <p className={`-mt-2 ${ADMIN_HINT}`}>
            {t('delegationMaxOverridesHint')}
          </p>

          {confirmDelete && (
            <div role="alertdialog" className={ADMIN_BANNER_WARN}>
              <p className="flex items-center gap-2">
                <IconAlertTriangle size={16} aria-hidden="true" />
                {t('deleteDelegationBlocked', { count })}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  className={ADMIN_BTN_SECONDARY}
                  onClick={() => {
                    setConfirmDelete(false);
                    onDisable();
                  }}
                  disabled={disabled}
                >
                  {t('deleteDelegationDisable')}
                </button>
                <button
                  type="button"
                  className={ADMIN_BTN_SECONDARY}
                  onClick={() => {
                    setConfirmDelete(false);
                    onDeleteWithOverrides();
                  }}
                  disabled={disabled}
                >
                  {t('deleteDelegationWithOverrides', { count })}
                </button>
                <button
                  type="button"
                  className={ADMIN_BTN_SECONDARY}
                  onClick={() => setConfirmDelete(false)}
                >
                  {t('cancel')}
                </button>
              </div>
              <p className={ADMIN_HINT}>{t('deleteDelegationDisableHint')}</p>
            </div>
          )}

          <div>
            <label className={ADMIN_LABEL}>{t('delegationAdminsLabel')}</label>
            <ChipListInput
              values={delegation.admins}
              onChange={(admins) => update({ admins })}
              normalize={(value) => value.trim().toLowerCase()}
              placeholder={t('delegationAdminsPlaceholder')}
              addHint={t('chipAddHint')}
              removeLabel={t('removeChip')}
              disabled={disabled}
              suggest={peopleSuggest}
              suggestionsLabel={tPeople('listLabel')}
            />
            <p className={ADMIN_HINT}>{t('delegationAdminsHint')}</p>
            {delegation.admins.length === 0 && (
              <p className={ADMIN_HINT}>{t('delegationNoAdminsWarning')}</p>
            )}
          </div>

          <div>
            <label className={ADMIN_LABEL}>
              {t('delegationJurisdictionLabel')}
            </label>
            <p className={`mb-2 ${ADMIN_MUTED}`}>
              {t('delegationJurisdictionHint')}
            </p>
            <div className="space-y-2">
              {delegation.jurisdiction.map((predicate, index) => (
                <div key={index} className={ADMIN_ROW}>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <select
                      className={ADMIN_FIELD}
                      value={predicate.scope}
                      onChange={(e) =>
                        // Scope change resets targets — a domain list is not
                        // a user list (mirrors OverrideEditor).
                        setPredicate(index, {
                          scope: e.target.value as OverrideScope,
                          targets: [],
                        })
                      }
                      disabled={disabled}
                      aria-label={t('delegationPredicateScopeLabel')}
                    >
                      {SCOPES.map((scope) => (
                        <option key={scope} value={scope}>
                          {t(`scope.${scope}` as never)}
                        </option>
                      ))}
                    </select>
                    <span className={ADMIN_MUTED}>
                      {t(`targetsLabel.${predicate.scope}` as never)}
                    </span>
                    <button
                      type="button"
                      className={`ml-auto ${ADMIN_BTN_ICON_DANGER}`}
                      onClick={() =>
                        update({
                          jurisdiction: delegation.jurisdiction.filter(
                            (_, i) => i !== index,
                          ),
                        })
                      }
                      disabled={disabled}
                      aria-label={t('delegationRemovePredicate')}
                    >
                      <IconTrash size={16} />
                    </button>
                  </div>
                  {predicate.scope === 'group' ? (
                    <>
                      <GroupSearchPicker
                        values={predicate.targets}
                        onChange={(targets) =>
                          setPredicate(index, { ...predicate, targets })
                        }
                        labels={{
                          searchPlaceholder: t('groupSearchPlaceholder'),
                          searchHint: t('groupSearchHint'),
                          noResults: t('groupSearchNoResults'),
                          searchError: t('groupSearchError'),
                          chipPlaceholder: t('targetsPlaceholder.group'),
                          addHint: t('chipAddHint'),
                          removeLabel: t('removeChip'),
                          flagOffHint: t('groupsFlagOff'),
                        }}
                        disabled={disabled}
                      />
                      {/* GroupSearchPicker renders nothing for an empty list
                          when the flag is off — say why, or the row is a
                          blank. */}
                      {!groupsEnabled && predicate.targets.length === 0 && (
                        <p className={ADMIN_HINT}>{t('groupsFlagOff')}</p>
                      )}
                    </>
                  ) : (
                    <ChipListInput
                      values={predicate.targets}
                      onChange={(targets) =>
                        setPredicate(index, { ...predicate, targets })
                      }
                      normalize={
                        predicate.scope === 'domain'
                          ? normalizeDomainEntry
                          : (value) => value.trim().toLowerCase()
                      }
                      placeholder={t(
                        `targetsPlaceholder.${predicate.scope}` as never,
                      )}
                      addHint={t('chipAddHint')}
                      removeLabel={t('removeChip')}
                      disabled={disabled}
                      suggest={
                        predicate.scope === 'user' ? peopleSuggest : undefined
                      }
                      suggestionsLabel={tPeople('listLabel')}
                    />
                  )}
                </div>
              ))}
            </div>
            <button
              type="button"
              className={`mt-2 ${ADMIN_BTN_SECONDARY}`}
              onClick={() =>
                update({
                  jurisdiction: [
                    ...delegation.jurisdiction,
                    { scope: 'domain', targets: [] },
                  ],
                })
              }
              disabled={disabled}
            >
              <IconPlus size={16} />
              {t('delegationAddPredicate')}
            </button>
            {jurisdictionEmpty && (
              <p className={ADMIN_HINT}>
                {t('delegationEmptyJurisdictionWarning')}
              </p>
            )}
            {!anchored && !jurisdictionEmpty && (
              <p className={`mt-2 ${ADMIN_BANNER_WARN}`} role="note">
                {t('delegationAnchorWarning')}
              </p>
            )}
            {narrowed > 0 && (
              <p className={`mt-2 ${ADMIN_BANNER_WARN}`} role="status">
                {t('delegationNarrowingPreview', { count: narrowed })}
              </p>
            )}
          </div>

          <div>
            <div className={ADMIN_LABEL}>{t('delegationLiftableTitle')}</div>
            <p className={`mb-1 ${ADMIN_MUTED}`}>
              {t('delegationLiftableHint')}
            </p>
            {liftable.length === 0 ? (
              <p className={ADMIN_MUTED}>{t('delegationLiftableNone')}</p>
            ) : (
              <ul className="space-y-1">
                {liftable.map((entry) => (
                  <li
                    key={`${entry.limitKey}|${entry.modelId ?? ''}|${entry.series ?? ''}`}
                    className="flex flex-wrap items-center justify-between gap-2 text-sm text-black dark:text-white"
                  >
                    <span>
                      {liftableLabel(entry)}
                      <span className={`ml-2 ${ADMIN_MUTED}`}>
                        {String(entry.value)}
                      </span>
                    </span>
                    <button
                      type="button"
                      className={ADMIN_BTN_SECONDARY}
                      onClick={() => onLiftDefault(entry)}
                      disabled={disabled}
                      aria-label={`${t('delegationLiftDefault')} ${liftableLabel(entry)}`}
                    >
                      {t('delegationLiftDefault')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
