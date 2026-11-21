'use client';

import {
  IconChevronDown,
  IconChevronRight,
  IconPlus,
} from '@tabler/icons-react';
import { FC, useState } from 'react';

import { useTranslations } from 'next-intl';

import { everyoneValue, ruleEffect } from '@/lib/services/limits/policyChanges';
import { LimitValue, LimitsPolicy } from '@/lib/services/limits/types';
import type { CellInsight, UsageInsights } from '@/lib/services/limits/wire';

import {
  ADMIN_BTN_SECONDARY,
  ADMIN_CHECKBOX,
  ADMIN_MUTED,
} from '@/components/Admin/adminClasses';
import { RuleEffectLine } from '@/components/Limits/RuleEffectLine';
import { ValueChoice } from '@/components/Limits/ValueChoice';
import { LIMIT_GROUPS, LimitGroup } from '@/components/Limits/limitGroups';
import {
  LimitsDraft,
  entryFor,
  exceptionCounts,
  rulesForKey,
  withEntry,
} from '@/components/Limits/limitsDraft';
import { appliesToLine } from '@/components/Limits/summaries';
import {
  AudienceShape,
  PressureBar,
  PressureLegend,
  ValueChip,
} from '@/components/Limits/visualSyntax';

import { LimitDefinition, getLimitDefinition } from '@/config/limits';

interface LimitsOverviewProps {
  draft: LimitsDraft;
  /** The draft as a policy (memoised by the panel). */
  policy: LimitsPolicy;
  insights: UsageInsights | undefined;
  groupNames: Record<string, string>;
  onDefaultsChange: (defaults: LimitsDraft['defaults']) => void;
  onEditRule: (overrideId: string) => void;
  /** Starts a new rule that sets `limitKey`. */
  onAddRule: (limitKey: string) => void;
  disabled: boolean;
}

const SCOPE_ORDER = ['domain', 'attribute', 'group', 'user'] as const;

/**
 * "What everyone gets": every limit, grouped by feature, with what everyone
 * gets, how many exceptions of each audience kind exist, and how close
 * people came to their cap yesterday. A row opens in place to edit the org
 * default and to list, explain and open every rule that sets it.
 */
export const LimitsOverview: FC<LimitsOverviewProps> = (props) => {
  const t = useTranslations('limits');
  const [open, setOpen] = useState<string | null>(null);
  const columns =
    'grid grid-cols-[minmax(14rem,2fr)_9rem_minmax(12rem,1.6fr)_minmax(12rem,1.2fr)] items-center gap-x-4';

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-surface-dark">
      <div className="min-w-[52rem]">
        <div
          className={`${columns} border-b border-gray-200 px-4 py-2.5 text-xs font-semibold text-gray-600 dark:border-gray-700 dark:text-gray-400`}
        >
          <span>{t('console.col.limit')}</span>
          <span className="flex items-center gap-1">
            <AudienceShape kind="everyone" /> {t('console.everyone')}
          </span>
          <span>{t('console.col.exceptions')}</span>
          <span>{t('console.col.pressure')}</span>
        </div>
        {LIMIT_GROUPS.map((group) => (
          <OverviewGroup
            key={group.id}
            group={group}
            columns={columns}
            open={open}
            onToggle={(key) =>
              setOpen((current) => (current === key ? null : key))
            }
            {...props}
          />
        ))}
        <div className="border-t border-gray-200 px-4 py-3 dark:border-gray-700">
          <PressureLegend />
          {props.insights && (
            <p className={`mt-1 ${ADMIN_MUTED}`}>
              {props.insights.status === 'building'
                ? t('console.evidenceBuilding')
                : t('console.evidenceWindow', {
                    days: props.insights.days.length,
                  })}
              {props.insights.partial ? ` ${t('console.evidencePartial')}` : ''}
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

const OverviewGroup: FC<
  LimitsOverviewProps & {
    group: LimitGroup;
    columns: string;
    open: string | null;
    onToggle: (key: string) => void;
  }
> = ({ group, columns, open, onToggle, ...props }) => {
  const t = useTranslations('limits');
  const keys = [...(group.gateKey ? [group.gateKey] : []), ...group.memberKeys];
  return (
    <section aria-labelledby={`limits-group-${group.id}`}>
      <h3
        id={`limits-group-${group.id}`}
        className="px-4 pb-1 pt-4 text-sm font-bold text-gray-900 dark:text-white"
      >
        {t(`group.${group.id}` as never)}
      </h3>
      {keys.map((key) => {
        const def = getLimitDefinition(key);
        if (!def) return null;
        return (
          <OverviewRow
            key={key}
            def={def}
            columns={columns}
            expanded={open === key}
            onToggle={() => onToggle(key)}
            {...props}
          />
        );
      })}
    </section>
  );
};

const OverviewRow: FC<
  LimitsOverviewProps & {
    def: LimitDefinition;
    columns: string;
    expanded: boolean;
    onToggle: () => void;
  }
> = ({ def, columns, expanded, onToggle, ...props }) => {
  const t = useTranslations('limits');
  const everyone = everyoneValue(props.policy, { limitKey: def.key });
  const defaultEntry = entryFor(props.draft.defaults, { limitKey: def.key });
  const counts = exceptionCounts(props.draft.overrides, def.key);
  const insight = props.insights?.cells[def.key];
  const label = t(`label.${def.labelKey}` as never);
  const panelId = `limits-row-${def.key}`;

  return (
    <div className="border-t border-gray-100 dark:border-gray-800">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={onToggle}
        className={`${columns} w-full px-4 py-2 text-left hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 dark:hover:bg-gray-800/60`}
      >
        <span className="flex items-center gap-1.5 text-sm text-gray-900 dark:text-white">
          {expanded ? (
            <IconChevronDown size={14} aria-hidden="true" />
          ) : (
            <IconChevronRight size={14} aria-hidden="true" />
          )}
          {label}
        </span>
        <span>
          {everyone && (
            <ValueChip
              value={everyone.resolved.value}
              def={def}
              inherited={!defaultEntry}
              ceiling={defaultEntry?.ceiling}
            />
          )}
        </span>
        <span className="flex flex-wrap gap-1.5">
          <ExceptionChips counts={counts} />
        </span>
        <span className="flex items-center gap-2">
          <PressureCell
            def={def}
            insight={insight}
            everyone={everyone?.resolved.value}
          />
        </span>
      </button>
      {expanded && (
        <div
          id={panelId}
          className="bg-gray-50 px-4 pb-4 pt-2 dark:bg-gray-900/40"
        >
          <RowDetail def={def} label={label} insight={insight} {...props} />
        </div>
      )}
    </div>
  );
};

/** Shape chips with counts; dashed when a delegated admin set them. */
const ExceptionChips: FC<{ counts: ReturnType<typeof exceptionCounts> }> = ({
  counts,
}) => {
  const t = useTranslations('limits');
  const chips = SCOPE_ORDER.flatMap((scope) =>
    (['global', 'delegated'] as const)
      .filter((who) => counts[scope][who] > 0)
      .map((who) => ({ scope, who, count: counts[scope][who] })),
  );
  if (chips.length === 0) {
    return (
      <span className="text-xs text-gray-500 dark:text-gray-400">
        {t('console.none')}
      </span>
    );
  }
  return (
    <>
      {chips.map(({ scope, who, count }) => (
        <span
          key={`${scope}-${who}`}
          className={`inline-flex h-6 items-center gap-1 rounded-full border border-gray-300 bg-white px-2 text-xs text-gray-800 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200 ${who === 'delegated' ? 'border-dashed' : ''}`}
          title={t(
            who === 'delegated'
              ? 'console.exceptionChipDelegated'
              : 'console.exceptionChip',
            { count, scope: t(`scope.${scope}` as never) },
          )}
        >
          <AudienceShape kind={scope} />
          <span className="sr-only">
            {t(
              who === 'delegated'
                ? 'console.exceptionChipDelegated'
                : 'console.exceptionChip',
              { count, scope: t(`scope.${scope}` as never) },
            )}
          </span>
          <span aria-hidden="true">{count}</span>
        </span>
      ))}
    </>
  );
};

const PressureCell: FC<{
  def: LimitDefinition;
  insight: CellInsight | undefined;
  everyone: LimitValue | undefined;
}> = ({ def, insight, everyone }) => {
  const t = useTranslations('limits');
  if (def.kind !== 'counter') {
    return (
      <span className="text-xs text-gray-500 dark:text-gray-400">
        {t('console.perRequest')}
      </span>
    );
  }
  if (!insight || insight.yesterday.people === 0) {
    return (
      <span className="text-xs text-gray-500 dark:text-gray-400">
        {everyone === null ? t('console.notMeasured') : t('console.noUsage')}
      </span>
    );
  }
  const { bands } = insight.yesterday;
  return (
    <>
      <PressureBar bands={bands} />
      <span className="text-xs text-gray-700 dark:text-gray-300">
        {bands.atCap > 0
          ? t('console.hitCap', { count: bands.atCap })
          : t('console.nobodyAtCap')}
      </span>
    </>
  );
};

/** The opened row: the org default, then every rule that sets this limit. */
const RowDetail: FC<
  LimitsOverviewProps & {
    def: LimitDefinition;
    label: string;
    insight: CellInsight | undefined;
  }
> = ({
  def,
  label,
  insight,
  draft,
  policy,
  groupNames,
  onDefaultsChange,
  onEditRule,
  onAddRule,
  disabled,
}) => {
  const t = useTranslations('limits');
  const cell = { limitKey: def.key };
  const entry = entryFor(draft.defaults, cell);
  const catalog = everyoneValue(null, cell)?.resolved.value ?? null;
  const rules = rulesForKey(draft.overrides, def.key, def.perModel);
  const everyoneEvidence = insight?.byRule.global;

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-600 dark:text-gray-400">
        {t(`descriptionByKey.${def.labelKey}` as never)}
      </p>

      <div className="space-y-2">
        <h4 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-white">
          <AudienceShape kind="everyone" /> {t('console.everyone')}
        </h4>
        <ValueChoice
          def={def}
          label={t('console.everyoneLimit', { limit: label })}
          value={entry?.value}
          inherited={catalog}
          onChange={(value) =>
            onDefaultsChange(withEntry(draft.defaults, cell, value))
          }
          disabled={disabled}
        />
        {entry && entry.value !== null && def.unit !== 'boolean' && (
          <label className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
            <input
              type="checkbox"
              className={ADMIN_CHECKBOX}
              checked={entry.ceiling}
              disabled={disabled}
              onChange={(event) =>
                onDefaultsChange(
                  withEntry(
                    draft.defaults,
                    cell,
                    entry.value,
                    event.target.checked,
                  ),
                )
              }
            />
            {t('console.ceilingToggle')}
          </label>
        )}
        {everyoneEvidence && (
          <p className={ADMIN_MUTED}>
            {t('console.ruleEvidence', {
              people: everyoneEvidence.people,
              atCap: everyoneEvidence.atCap,
            })}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-white">
          {t('console.exceptionsTitle', { count: rules.length })}
        </h4>
        {rules.length === 0 && (
          <p className={ADMIN_MUTED}>{t('console.noExceptions')}</p>
        )}
        <ul className="space-y-2">
          {rules.map(({ override, entry: ruleEntry }) => {
            const effect = ruleEffect(policy, override, ruleEntry);
            const evidence = insight?.byRule[override.id];
            return (
              <li
                key={`${override.id}-${ruleEntry.modelId ?? ''}-${ruleEntry.series ?? ''}`}
                className="flex flex-wrap items-start gap-x-4 gap-y-1 rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-surface-dark"
              >
                <div className="min-w-[16rem] flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm text-gray-900 dark:text-white">
                    <AudienceShape kind={override.scope} />
                    <span className="font-medium">
                      {override.label ||
                        appliesToLine(
                          t,
                          override.scope,
                          override.targets,
                          groupNames,
                        )}
                    </span>
                    <ValueChip
                      value={ruleEntry.value}
                      def={def}
                      ceiling={ruleEntry.ceiling && !override.delegationId}
                      delegated={!!override.delegationId}
                    />
                    {(ruleEntry.modelId || ruleEntry.series) && (
                      <span className="text-xs text-gray-600 dark:text-gray-400">
                        {ruleEntry.modelId
                          ? `${t('scopeModel')}: ${ruleEntry.modelId}`
                          : `${t('scopeFamily')}: ${ruleEntry.series}`}
                      </span>
                    )}
                    {override.delegationId &&
                      !policy.delegations.some(
                        (d) => d.id === override.delegationId,
                      ) && (
                        <span
                          className="text-xs text-amber-800 dark:text-amber-300"
                          title={t('orphanedDelegationNote')}
                        >
                          {t('orphanedDelegationChip')}
                        </span>
                      )}
                    {!override.enabled && (
                      <span className="text-xs text-gray-600 dark:text-gray-400">
                        {t('overrideDisabledChip')}
                      </span>
                    )}
                  </p>
                  {override.label && (
                    <p className={ADMIN_MUTED}>
                      {appliesToLine(
                        t,
                        override.scope,
                        override.targets,
                        groupNames,
                      )}
                    </p>
                  )}
                  {effect && !ruleEntry.modelId && !ruleEntry.series && (
                    <div className="mt-1">
                      <RuleEffectLine effect={effect} def={def} />
                    </div>
                  )}
                  {!effect &&
                    override.targets.every((target) => !target.trim()) && (
                      <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
                        {t('console.effect.noTargets')}
                      </p>
                    )}
                  {evidence && (
                    <p className={`mt-1 ${ADMIN_MUTED}`}>
                      {t('console.ruleEvidence', {
                        people: evidence.people,
                        atCap: evidence.atCap,
                      })}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  className={ADMIN_BTN_SECONDARY}
                  onClick={() => onEditRule(override.id)}
                >
                  {t('console.editRule')}
                </button>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          className={ADMIN_BTN_SECONDARY}
          onClick={() => onAddRule(def.key)}
          disabled={disabled}
        >
          <IconPlus size={16} aria-hidden="true" />
          {t('console.addException')}
        </button>
      </div>
    </div>
  );
};
