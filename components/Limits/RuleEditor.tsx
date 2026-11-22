'use client';

import { IconArrowLeft, IconPlus, IconTrash } from '@tabler/icons-react';
import { FC, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useM365PeopleSuggest } from '@/client/hooks/useM365PeopleSuggest';

import {
  LimitCell,
  cellId,
  ruleEffect,
} from '@/lib/services/limits/policyChanges';
import { LimitSource } from '@/lib/services/limits/resolver';
import {
  LimitEntry,
  LimitOverride,
  LimitsPolicy,
  OverrideScope,
} from '@/lib/services/limits/types';
import type { UsageInsights } from '@/lib/services/limits/wire';

import {
  ADMIN_BTN_ICON_DANGER,
  ADMIN_BTN_SECONDARY,
  ADMIN_CHECKBOX,
  ADMIN_FIELD,
  ADMIN_HINT,
  ADMIN_LABEL,
  ADMIN_MUTED,
} from '@/components/Admin/adminClasses';
import { ChipListInput } from '@/components/AgentAccess/ChipListInput';
import { GroupSearchPicker } from '@/components/AgentAccess/GroupSearchPicker';
import { normalizeDomainEntry } from '@/components/AgentAccess/RuleEditor';
import { RuleEffectLine } from '@/components/Limits/RuleEffectLine';
import { ValueChoice } from '@/components/Limits/ValueChoice';
import {
  outOfScopeTargets,
  relevantRulesFor,
  verdictsForTargets,
} from '@/components/Limits/jurisdiction';
import { LIMIT_GROUPS } from '@/components/Limits/limitGroups';
import { entryFor, withEntry } from '@/components/Limits/limitsDraft';
import { appliesToLine } from '@/components/Limits/summaries';
import {
  AudienceShape,
  ValueChip,
  audienceOfSource,
} from '@/components/Limits/visualSyntax';

import { getLimitDefinition } from '@/config/limits';

const SCOPES: OverrideScope[] = ['domain', 'attribute', 'group', 'user'];

interface RuleEditorProps {
  override: LimitOverride;
  /** The draft as a policy, with this override in it. */
  policy: LimitsPolicy;
  onChange: (next: LimitOverride) => void;
  onRemove: () => void;
  onBack: () => void;
  /** Saved delegations a global admin may hand the rule to. */
  delegationOptions: Array<{ id: string; label: string }>;
  groupNames: Record<string, string>;
  insights: UsageInsights | undefined;
  disabled: boolean;
}

/**
 * Editing one rule (an override): who it covers, what else covers the same
 * people, and the limits it sets. Each limit is one row on one grid: the
 * kind of answer (Inherit / Limit / Unlimited / Off), its value, and a
 * sentence saying what members get with it and without it, or why it has no
 * effect as set. Edits go to the draft; nothing changes until Review / Save.
 */
export const RuleEditor: FC<RuleEditorProps> = ({
  override,
  policy,
  onChange,
  onRemove,
  onBack,
  delegationOptions,
  groupNames,
  insights,
  disabled,
}) => {
  const t = useTranslations('limits');
  const tPeople = useTranslations('peopleSuggest');
  const peopleSuggest = useM365PeopleSuggest();
  const [pendingAdd, setPendingAdd] = useState('');
  // Cells set to Inherit this session stay on screen, selected as Inherit,
  // so the row does not vanish under the pointer; they are gone from the
  // draft already and leave the rule on save.
  const [inherited, setInherited] = useState<LimitCell[]>([]);

  const delegation = override.delegationId
    ? policy.delegations.find((d) => d.id === override.delegationId)
    : undefined;
  const ceilingAllowed = !override.delegationId;
  const update = (patch: Partial<LimitOverride>) =>
    onChange({ ...override, ...patch });

  const rows = useMemo(() => {
    const set = override.entries.map((entry) => ({
      cell: entry as LimitCell,
      entry,
    }));
    const kept = inherited
      .filter((cell) => !entryFor(override.entries, cell))
      .map((cell) => ({ cell, entry: undefined as LimitEntry | undefined }));
    return [...set, ...kept];
  }, [override.entries, inherited]);

  const others = relevantRulesFor(
    override.scope,
    override.targets,
    { overrides: policy.overrides, delegations: policy.delegations },
    override.id,
  ).filter((rule) => rule.kind === 'override');

  const outOfScope = delegation
    ? outOfScopeTargets(
        verdictsForTargets(
          override.scope,
          override.targets,
          delegation.jurisdiction,
        ),
      )
    : [];

  const setCell = (cell: LimitCell, value: LimitEntry['value'] | undefined) => {
    if (value === undefined) {
      setInherited((cells) =>
        cells.some((c) => cellId(c) === cellId(cell))
          ? cells
          : [...cells, cell],
      );
    }
    update({ entries: withEntry(override.entries, cell, value) });
  };

  const assignDelegation = (delegationId: string) => {
    if (!delegationId) {
      const { delegationId: _dropped, ...rest } = override;
      onChange(rest);
      return;
    }
    // A delegated rule never holds the priority lever and never pins a
    // cell; normalised here so the draft matches what the server stores.
    onChange({
      ...override,
      delegationId,
      priority: 0,
      entries: override.entries.map((entry) => ({ ...entry, ceiling: false })),
    });
  };

  const addable = LIMIT_GROUPS.flatMap((group) => [
    ...(group.gateKey ? [group.gateKey] : []),
    ...group.memberKeys,
  ]).filter((key) => !entryFor(override.entries, { limitKey: key }));

  const title =
    override.label ||
    appliesToLine(t, override.scope, override.targets, groupNames);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={ADMIN_BTN_SECONDARY} onClick={onBack}>
          <IconArrowLeft size={16} aria-hidden="true" />
          {t('console.backToOverview')}
        </button>
        <h2 className="flex min-w-0 flex-1 items-center gap-2 text-lg font-bold text-gray-900 dark:text-white">
          <AudienceShape kind={override.scope} />
          <span className="truncate">{title}</span>
        </h2>
        <label className="flex items-center gap-2 text-sm text-gray-900 dark:text-white">
          <input
            type="checkbox"
            className={ADMIN_CHECKBOX}
            checked={override.enabled}
            onChange={(event) => update({ enabled: event.target.checked })}
            disabled={disabled}
          />
          {t('console.ruleOn')}
        </label>
        <button
          type="button"
          className={ADMIN_BTN_ICON_DANGER}
          onClick={onRemove}
          disabled={disabled}
          aria-label={t('removeOverride')}
        >
          <IconTrash size={18} />
        </button>
      </div>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        {t('console.ruleIntro')}
      </p>

      <div className="flex flex-wrap items-start gap-5">
        <aside className="flex min-w-[18rem] flex-1 basis-80 flex-col gap-4">
          <section className="space-y-3 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-surface-dark">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
              {t('console.whoItCovers')}
            </h3>
            <label className="block">
              <span className={ADMIN_LABEL}>{t('overrideLabelLabel')}</span>
              <input
                type="text"
                className={`w-full ${ADMIN_FIELD}`}
                value={override.label}
                placeholder={t('overrideLabelPlaceholder')}
                onChange={(event) => update({ label: event.target.value })}
                disabled={disabled}
              />
            </label>
            <label className="block">
              <span className={ADMIN_LABEL}>{t('overrideScopeLabel')}</span>
              <select
                className={`w-full ${ADMIN_FIELD}`}
                value={override.scope}
                onChange={(event) =>
                  update({
                    scope: event.target.value as OverrideScope,
                    targets: [],
                  })
                }
                disabled={disabled}
              >
                {SCOPES.map((scope) => (
                  <option key={scope} value={scope}>
                    {t(`scope.${scope}` as never)}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <span className={ADMIN_LABEL}>
                {t(`targetsLabel.${override.scope}` as never)}
              </span>
              {override.scope === 'group' ? (
                <GroupSearchPicker
                  values={override.targets}
                  onChange={(targets) => update({ targets })}
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
              ) : (
                <ChipListInput
                  values={override.targets}
                  onChange={(targets) => update({ targets })}
                  normalize={
                    override.scope === 'domain'
                      ? normalizeDomainEntry
                      : undefined
                  }
                  placeholder={t(
                    `targetsPlaceholder.${override.scope}` as never,
                  )}
                  addHint={t('chipAddHint')}
                  removeLabel={t('removeChip')}
                  disabled={disabled}
                  suggest={
                    override.scope === 'user' ? peopleSuggest : undefined
                  }
                  suggestionsLabel={tPeople('listLabel')}
                  chipTone={(value) =>
                    outOfScope.includes(value) ? 'danger' : undefined
                  }
                />
              )}
              {outOfScope.length > 0 && (
                <p className={ADMIN_HINT} role="status">
                  {t('verdictOutOfScope', { targets: outOfScope.join(', ') })}
                </p>
              )}
              <p className={ADMIN_HINT}>
                {t(`console.rankNote.${override.scope}` as never)}
              </p>
            </div>
          </section>

          <section className="space-y-3 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-surface-dark">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
              {t('console.othersTitle')}
            </h3>
            {others.length === 0 ? (
              <p className={ADMIN_MUTED}>{t('console.othersNone')}</p>
            ) : (
              <ul className="space-y-2 text-sm text-gray-800 dark:text-gray-200">
                {others.map((rule) => (
                  <li key={rule.id} className="flex gap-2">
                    <AudienceShape kind={rule.scope} />
                    <span>
                      <strong>{rule.label || t('untitledOverride')}</strong>
                      {rule.delegationId ? ` (${t('tierScoped')})` : ''}:{' '}
                      {t(
                        `console.othersRelation.${relation(override, rule)}` as never,
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <details className="text-sm text-gray-800 dark:text-gray-200">
              <summary className="flex min-h-8 cursor-pointer items-center">
                {t('console.advanced')}
              </summary>
              <div className="mt-2 space-y-3">
                {ceilingAllowed && (
                  <label className="flex items-center gap-2">
                    {t('priorityLabel')}
                    <input
                      type="number"
                      min={-1000}
                      max={1000}
                      className={`w-24 ${ADMIN_FIELD}`}
                      value={override.priority}
                      onChange={(event) => {
                        const parsed = Number.parseInt(event.target.value, 10);
                        update({
                          priority: Number.isNaN(parsed)
                            ? 0
                            : Math.max(-1000, Math.min(1000, parsed)),
                        });
                      }}
                      disabled={disabled}
                    />
                  </label>
                )}
                <p className={ADMIN_HINT}>{t('priorityHint')}</p>
                <label className="flex flex-wrap items-center gap-2">
                  {t('overrideDelegationLabel')}
                  <select
                    className={ADMIN_FIELD}
                    value={override.delegationId ?? ''}
                    onChange={(event) => assignDelegation(event.target.value)}
                    disabled={disabled}
                  >
                    <option value="">{t('overrideDelegationNone')}</option>
                    {delegationOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <p className={ADMIN_HINT}>{t('overrideDelegationHint')}</p>
              </div>
            </details>
          </section>
        </aside>

        <section className="min-w-0 flex-[999_1_36rem] rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-surface-dark">
          <h3 className="px-4 pb-2 pt-4 text-sm font-semibold text-gray-900 dark:text-white">
            {t('console.whatItSets')}
          </h3>
          {rows.length === 0 && (
            <p className={`px-4 pb-3 ${ADMIN_MUTED}`}>
              {t('console.setsNothing')}
            </p>
          )}
          {rows.map(({ cell, entry }) => {
            const def = getLimitDefinition(cell.limitKey);
            if (!def) return null;
            const label = t(`label.${def.labelKey}` as never);
            const effect = entry ? ruleEffect(policy, override, entry) : null;
            const fallback = effect?.otherwise ?? null;
            const evidence = insights?.cells[cellId(cell)]?.byRule[override.id];
            return (
              <div
                key={cellId(cell)}
                className="space-y-2 border-t border-gray-100 px-4 py-4 dark:border-gray-800"
              >
                <div className="grid grid-cols-1 items-center gap-3 lg:grid-cols-[minmax(12rem,1fr)_auto]">
                  <div>
                    <p className="text-sm font-semibold text-gray-900 dark:text-white">
                      {label}
                      {cell.modelId && ` · ${t('scopeModel')}: ${cell.modelId}`}
                      {cell.series && ` · ${t('scopeFamily')}: ${cell.series}`}
                    </p>
                    {fallback && (
                      <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
                        {t('console.otherwise')}
                        <ValueChip
                          value={fallback.resolved.value}
                          def={def}
                          ceiling={fallback.resolved.ceilingApplied}
                        />
                        <SourceName source={fallback.resolved.source} />
                      </p>
                    )}
                  </div>
                  <ValueChoice
                    def={def}
                    label={label}
                    value={entry?.value}
                    inherited={fallback?.resolved.value ?? def.defaultValue}
                    onChange={(value) => setCell(cell, value)}
                    disabled={disabled}
                  />
                </div>
                {ceilingAllowed &&
                  entry &&
                  entry.value !== null &&
                  def.unit !== 'boolean' && (
                    <label className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
                      <input
                        type="checkbox"
                        className={ADMIN_CHECKBOX}
                        checked={entry.ceiling}
                        onChange={(event) =>
                          update({
                            entries: withEntry(
                              override.entries,
                              cell,
                              entry.value,
                              event.target.checked,
                            ),
                          })
                        }
                        disabled={disabled}
                      />
                      {t('console.ruleCeilingToggle')}
                    </label>
                  )}
                {entry && effect && (
                  <RuleEffectLine effect={effect} def={def} />
                )}
                {entry &&
                  !effect &&
                  override.targets.every((target) => !target.trim()) && (
                    <p className={ADMIN_HINT}>
                      {t('console.effect.noTargets')}
                    </p>
                  )}
                {entry && entry.value === null && (
                  <p className={ADMIN_HINT}>{t('console.unlimitedHint')}</p>
                )}
                {!entry && (
                  <p className={ADMIN_HINT}>{t('console.inheritHint')}</p>
                )}
                {evidence && (
                  <p className={ADMIN_MUTED}>
                    {t('console.ruleEvidence', {
                      people: evidence.people,
                      atCap: evidence.atCap,
                    })}
                  </p>
                )}
              </div>
            );
          })}
          <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 px-4 py-4 dark:border-gray-800">
            <label className="sr-only" htmlFor={`add-limit-${override.id}`}>
              {t('addLimitLabel')}
            </label>
            <select
              id={`add-limit-${override.id}`}
              className={ADMIN_FIELD}
              value={pendingAdd}
              onChange={(event) => setPendingAdd(event.target.value)}
              disabled={disabled || addable.length === 0}
            >
              <option value="">{t('addLimitPlaceholder')}</option>
              {addable.map((key) => {
                const def = getLimitDefinition(key);
                return def ? (
                  <option key={key} value={key}>
                    {t(`label.${def.labelKey}` as never)}
                  </option>
                ) : null;
              })}
            </select>
            <button
              type="button"
              className={ADMIN_BTN_SECONDARY}
              disabled={disabled || !pendingAdd}
              onClick={() => {
                const def = getLimitDefinition(pendingAdd);
                if (!def) return;
                const cell = { limitKey: def.key };
                const otherwise = ruleEffect(
                  policy,
                  {
                    ...override,
                    entries: [
                      ...override.entries,
                      { ...cell, value: 0, ceiling: false },
                    ],
                  },
                  { ...cell, value: 0, ceiling: false },
                )?.otherwise.resolved.value;
                // Start from what members already get, so adding a row
                // changes nothing until the admin picks a new answer.
                const start =
                  def.unit === 'boolean'
                    ? (otherwise ?? true)
                    : typeof otherwise === 'number' && otherwise > 0
                      ? otherwise
                      : 100;
                update({ entries: withEntry(override.entries, cell, start) });
                setPendingAdd('');
              }}
            >
              <IconPlus size={16} aria-hidden="true" />
              {t('console.setAnother')}
            </button>
            <p className={`w-full ${ADMIN_HINT}`}>
              {t('console.notListedInherit')}
            </p>
          </div>
        </section>
      </div>
    </div>
  );
};

/** "how a nearby rule relates to this one", for the overlaps list. */
function relation(
  override: LimitOverride,
  other: { scope: OverrideScope; delegationId?: string },
): 'wins' | 'loses' | 'tie' {
  const rank: Record<OverrideScope, number> = {
    domain: 2,
    attribute: 3,
    group: 4,
    user: 5,
  };
  if (rank[other.scope] > rank[override.scope]) return 'wins';
  if (rank[other.scope] < rank[override.scope]) return 'loses';
  if (!!other.delegationId !== !!override.delegationId) {
    return other.delegationId ? 'loses' : 'wins';
  }
  return 'tie';
}

/** Names the layer a value comes from, with its shape. */
const SourceName: FC<{ source: LimitSource }> = ({ source }) => {
  const t = useTranslations('limits');
  const kind = audienceOfSource(source);
  if (!kind) return <span>{t('console.source.catalog')}</span>;
  return (
    <span className="inline-flex items-center gap-1">
      {t('console.from')} <AudienceShape kind={kind} />
      {t(`console.source.${kind}` as never)}
    </span>
  );
};
