'use client';

import { FC, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useGroupNames } from '@/client/hooks/useGroupNames';

import { modelAccessDimension } from '@/lib/services/limits/modelAccess';
import {
  OtherChange,
  PolicyChange,
  RuleChange,
  ValueChange,
  cellId,
  summarizeChanges,
} from '@/lib/services/limits/policyChanges';
import { LimitValue, LimitsPolicy } from '@/lib/services/limits/types';
import type { CellInsight, UsageInsights } from '@/lib/services/limits/wire';

import {
  AudienceTerms,
  audienceId,
  ruleDifferences,
} from '@/lib/utils/app/modelAccessGrid';

import {
  ADMIN_BTN_SECONDARY,
  ADMIN_FIELD,
  ADMIN_MUTED,
} from '@/components/Admin/adminClasses';
import { appliesToLine } from '@/components/Limits/summaries';
import {
  AudienceShape,
  DirectionMark,
  ValueChip,
} from '@/components/Limits/visualSyntax';

import { LimitDefinition, getLimitDefinition } from '@/config/limits';

interface ChangeReviewProps {
  changes: readonly PolicyChange[];
  saved: LimitsPolicy | null;
  draft: LimitsPolicy;
  insights: UsageInsights | undefined;
  groupNames: Record<string, string>;
  onUndo: (change: PolicyChange) => void;
  onEditRule: (overrideId: string) => void;
  /** Opens the per-person view on this mail, against the draft. */
  onCheckPerson: (mail: string) => void;
}

/**
 * "Review changes before saving": every difference between the saved policy
 * and the draft as a sentence, with its direction, who it reaches, what the
 * last week's usage says about it, and risk flags. Each change can be undone
 * on its own. Saving happens from the panel's bar.
 */
export const ChangeReview: FC<ChangeReviewProps> = ({
  changes,
  saved,
  draft,
  insights,
  groupNames,
  onUndo,
  onEditRule,
  onCheckPerson,
}) => {
  const t = useTranslations('limits');
  const [mail, setMail] = useState('');
  const summary = summarizeChanges(changes);

  if (changes.length === 0) {
    return (
      <p className="text-sm text-gray-700 dark:text-gray-300">
        {t('console.noChanges')}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <h2 className="text-lg font-bold text-gray-900 dark:text-white">
          {t('console.reviewTitle', { count: summary.total })}
        </h2>
        <span className="flex flex-wrap gap-4 text-sm text-gray-800 dark:text-gray-200">
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
      </header>
      <p className="text-sm text-gray-700 dark:text-gray-300">
        {draft.mode === 'enforce'
          ? t('console.reviewEnforce')
          : t('console.reviewObserve')}
      </p>

      <div className="flex flex-wrap items-start gap-5">
        <ol className="flex min-w-0 flex-[999_1_36rem] flex-col gap-3">
          {changes.map((change, index) => (
            <li key={index}>
              {change.type === 'value' ? (
                <ValueChangeCard
                  change={change}
                  insight={insights?.cells[cellId(change.cell)]}
                  groupNames={groupNames}
                  onUndo={() => onUndo(change)}
                  onEditRule={onEditRule}
                />
              ) : change.type === 'rule' ? (
                <RuleChangeCard
                  change={change}
                  groupNames={groupNames}
                  onUndo={() => onUndo(change)}
                />
              ) : (
                <OtherChangeCard
                  change={change}
                  saved={saved}
                  draft={draft}
                  groupNames={groupNames}
                  onUndo={() => onUndo(change)}
                />
              )}
            </li>
          ))}
        </ol>

        <aside className="flex min-w-[18rem] flex-1 basis-80 flex-col gap-3 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-surface-dark">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
            {t('console.checkPerson')}
          </h3>
          <p className={ADMIN_MUTED}>{t('console.checkPersonHint')}</p>
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (mail.trim()) onCheckPerson(mail.trim().toLowerCase());
            }}
          >
            <input
              type="email"
              className={`min-w-0 flex-1 ${ADMIN_FIELD}`}
              value={mail}
              onChange={(event) => setMail(event.target.value)}
              placeholder={t('previewEmailPlaceholder')}
              aria-label={t('previewEmailLabel')}
            />
            <button
              type="submit"
              className={ADMIN_BTN_SECONDARY}
              disabled={!mail.trim()}
            >
              {t('previewRun')}
            </button>
          </form>
          {saved && <p className={ADMIN_MUTED}>{t('console.historyNote')}</p>}
        </aside>
      </div>
    </div>
  );
};

function audienceName(
  t: ReturnType<typeof useTranslations<'limits'>>,
  change: ValueChange | RuleChange,
  groupNames: Record<string, string>,
): string {
  if (change.audience.kind === 'everyone') return t('console.everyone');
  return (
    change.audience.label ||
    appliesToLine(t, change.audience.scope, change.audience.targets, groupNames)
  );
}

const CARD = 'rounded-lg border bg-white p-4 dark:bg-surface-dark';

const ValueChangeCard: FC<{
  change: ValueChange;
  insight: CellInsight | undefined;
  groupNames: Record<string, string>;
  onUndo: () => void;
  onEditRule: (overrideId: string) => void;
}> = ({ change, insight, groupNames, onUndo, onEditRule }) => {
  const t = useTranslations('limits');
  const def = getLimitDefinition(change.cell.limitKey);
  if (!def) return null;
  const removesCap = change.flags.includes('removes-cap');
  const direction = removesCap ? 'removes-cap' : change.direction;
  const kind =
    change.audience.kind === 'everyone' ? 'everyone' : change.audience.scope;
  const rule =
    change.audience.kind === 'everyone' ? 'global' : change.audience.overrideId;
  const evidence = insight?.byRule[rule];
  const label = t(`label.${def.labelKey}` as never);
  const qualifier = change.cell.modelId
    ? ` · ${change.cell.modelId}`
    : change.cell.series
      ? ` · ${t('scopeFamily')} ${change.cell.series}`
      : '';

  return (
    <article
      className={`${CARD} ${removesCap || change.flags.includes('removes-ceiling') ? 'border-orange-400 dark:border-orange-500' : 'border-gray-200 dark:border-gray-700'}`}
    >
      <div className="flex items-start gap-3">
        <DirectionBadge direction={direction} />
        <div className="min-w-0 flex-1 space-y-1.5">
          <h3 className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-white">
            <AudienceShape kind={kind} />
            {audienceName(t, change, groupNames)} · {label}
            {qualifier}:
            <SetValueChip
              value={change.before.value}
              def={def}
              ceiling={change.before.ceiling}
              old
            />
            <span aria-hidden="true">→</span>
            <SetValueChip
              value={change.after.value}
              def={def}
              ceiling={change.after.ceiling}
            />
          </h3>
          <p className="text-sm text-gray-700 dark:text-gray-300">
            {change.audience.kind === 'rule' &&
            change.audience.targets.every((target) => !target.trim())
              ? t('console.change.noTargets')
              : t(
                  change.audience.kind === 'everyone'
                    ? 'console.change.everyoneGets'
                    : change.audience.scope === 'user'
                      ? 'console.change.peopleGet'
                      : 'console.change.membersGet',
                  {
                    before: formatPlain(change.resolvedBefore),
                    after: formatPlain(change.resolvedAfter),
                  },
                )}
          </p>
          {change.flags.map((flag) => (
            <p
              key={flag}
              className="text-sm text-orange-800 dark:text-orange-300"
            >
              {t(`console.flag.${flag}` as never)}
            </p>
          ))}
          <Evidence
            change={change}
            def={def}
            insight={insight}
            evidence={evidence}
          />
        </div>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            className={ADMIN_BTN_SECONDARY}
            onClick={onUndo}
          >
            {t('console.undo')}
          </button>
          {change.audience.kind === 'rule' && (
            <button
              type="button"
              className={ADMIN_BTN_SECONDARY}
              onClick={() =>
                onEditRule(
                  (change.audience as { overrideId: string }).overrideId,
                )
              }
            >
              {t('console.editRule')}
            </button>
          )}
        </div>
      </div>
    </article>
  );
};

/** Plain text for a resolved value inside a sentence. */
function formatPlain(value: LimitValue): string {
  if (value === null) return '∞';
  if (value === true) return '✓';
  if (value === false) return '⊘';
  return String(value);
}

const SetValueChip: FC<{
  value: LimitValue | undefined;
  def: LimitDefinition;
  ceiling: boolean;
  old?: boolean;
}> = ({ value, def, ceiling, old }) => {
  const t = useTranslations('limits');
  if (value === undefined) {
    return (
      <span className="text-xs font-normal text-gray-600 dark:text-gray-400">
        {t('console.kind.inherit')}
      </span>
    );
  }
  return <ValueChip value={value} def={def} ceiling={ceiling} lost={old} />;
};

const DirectionBadge: FC<{
  direction: 'looser' | 'stricter' | 'same' | 'removes-cap';
}> = ({ direction }) => {
  const tone =
    direction === 'looser'
      ? 'bg-blue-50 dark:bg-blue-950'
      : direction === 'stricter'
        ? 'bg-orange-50 dark:bg-orange-950'
        : direction === 'removes-cap'
          ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
          : 'bg-gray-100 dark:bg-gray-800';
  return (
    <span
      className={`flex h-8 w-8 flex-none items-center justify-center rounded-lg text-lg ${tone}`}
    >
      {direction === 'same' ? (
        <span aria-hidden="true">=</span>
      ) : (
        <DirectionMark direction={direction} />
      )}
    </span>
  );
};

/** What last week's usage says about a value change. */
const Evidence: FC<{
  change: ValueChange;
  def: LimitDefinition;
  insight: CellInsight | undefined;
  evidence: { people: number; atCap: number } | undefined;
}> = ({ change, def, insight, evidence }) => {
  const t = useTranslations('limits');
  if (def.kind !== 'counter') return null;
  if (!insight) {
    return <p className={ADMIN_MUTED}>{t('console.change.noEvidence')}</p>;
  }
  const after = change.resolvedAfter;
  const before = change.resolvedBefore;
  const over =
    typeof after === 'number'
      ? insight.peaks.filter((peak) => peak > after).length
      : 0;
  return (
    <div className="space-y-2">
      {evidence && (
        <p className="text-sm text-gray-700 dark:text-gray-300">
          {t('console.change.ruleReach', {
            people: evidence.people,
            atCap: evidence.atCap,
          })}
        </p>
      )}
      {change.direction === 'stricter' && typeof after === 'number' && (
        <p className="text-sm text-gray-700 dark:text-gray-300">
          {t('console.change.overNewCap', { people: over, cap: after })}
        </p>
      )}
      {insight.events > 0 && (
        <p className={ADMIN_MUTED}>
          {t('console.change.events', {
            events: insight.events,
            people: insight.eventPeople,
          })}
        </p>
      )}
      {insight.peaks.length > 1 && (
        <PeakHistogram
          peaks={insight.peaks}
          before={typeof before === 'number' ? before : undefined}
          after={typeof after === 'number' ? after : undefined}
        />
      )}
    </div>
  );
};

const BINS = 20;

/** Each person's busiest day last week, with the old and new caps marked. */
const PeakHistogram: FC<{
  peaks: number[];
  before?: number;
  after?: number;
}> = ({ peaks, before, after }) => {
  const t = useTranslations('limits');
  const top = Math.max(
    peaks[peaks.length - 1] ?? 0,
    (before ?? 0) * 1.1,
    (after ?? 0) * 1.1,
    1,
  );
  const bins = useMemo(() => {
    const counts = new Array<number>(BINS).fill(0);
    for (const peak of peaks) {
      counts[Math.min(BINS - 1, Math.floor((peak / top) * BINS))] += 1;
    }
    return counts;
  }, [peaks, top]);
  const highest = Math.max(...bins, 1);
  const position = (value: number) => `${Math.min(100, (value / top) * 100)}%`;
  const label = t('console.histogramLabel', {
    people: peaks.length,
    before: before ?? '∞',
    after: after ?? '∞',
  });
  return (
    <figure className="m-0">
      <div
        role="img"
        aria-label={label}
        className="relative mt-5 flex h-24 items-end gap-0.5 border-b border-gray-300 dark:border-gray-600"
      >
        {bins.map((count, index) => {
          const lowEdge = (index / BINS) * top;
          const over = after !== undefined && lowEdge >= after;
          return (
            <span
              key={index}
              className={`flex-1 rounded-t-sm ${over ? 'bg-orange-400 dark:bg-orange-500' : 'bg-slate-300 dark:bg-slate-600'}`}
              style={{ height: `${(count / highest) * 100}%` }}
            />
          );
        })}
        {before !== undefined && (
          <CapLine
            left={position(before)}
            text={t('console.oldCap', { value: before })}
            dashed
          />
        )}
        {after !== undefined && (
          <CapLine
            left={position(after)}
            text={t('console.newCap', { value: after })}
          />
        )}
      </div>
      <figcaption className={`mt-1 ${ADMIN_MUTED}`}>
        {t('console.histogramCaption')}
      </figcaption>
    </figure>
  );
};

const CapLine: FC<{ left: string; text: string; dashed?: boolean }> = ({
  left,
  text,
  dashed,
}) => (
  <>
    <span
      aria-hidden="true"
      className={`absolute bottom-0 top-0 border-l-2 ${dashed ? 'border-dashed border-gray-500' : 'border-orange-700 dark:border-orange-400'}`}
      style={{ left }}
    />
    <span
      aria-hidden="true"
      className={`absolute -top-5 -translate-x-1/2 whitespace-nowrap text-[11px] font-semibold ${dashed ? 'text-gray-600 dark:text-gray-400' : 'text-orange-800 dark:text-orange-300'}`}
      style={{ left }}
    >
      {text}
    </span>
  </>
);

const RuleChangeCard: FC<{
  change: RuleChange;
  groupNames: Record<string, string>;
  onUndo: () => void;
}> = ({ change, groupNames, onUndo }) => {
  const t = useTranslations('limits');
  return (
    <article
      className={`${CARD} flex items-start gap-3 border-gray-200 dark:border-gray-700`}
    >
      <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-800">
        <AudienceShape kind={change.audience.scope} />
      </span>
      <p className="min-w-0 flex-1 text-sm text-gray-800 dark:text-gray-200">
        <strong>{audienceName(t, change, groupNames)}</strong>:{' '}
        {t(`console.ruleChange.${change.change}` as never)}
      </p>
      <button type="button" className={ADMIN_BTN_SECONDARY} onClick={onUndo}>
        {t('console.undo')}
      </button>
    </article>
  );
};

const OtherChangeCard: FC<{
  change: OtherChange;
  saved: LimitsPolicy | null;
  draft: LimitsPolicy;
  groupNames: Record<string, string>;
  onUndo: () => void;
}> = ({ change, saved, draft, groupNames, onUndo }) => {
  const t = useTranslations('limits');
  const enforce =
    change.type === 'setting' &&
    change.subject === 'mode' &&
    change.after === 'enforce';
  return (
    <article
      className={`${CARD} flex items-start gap-3 ${enforce ? 'border-orange-400 dark:border-orange-500' : 'border-gray-200 dark:border-gray-700'}`}
    >
      <div className="min-w-0 flex-1 text-sm text-gray-800 dark:text-gray-200">
        <strong>
          {change.type === 'setting'
            ? t('console.otherChange.setting', { subject: change.subject })
            : change.type === 'delegation'
              ? t('console.otherChange.delegation', { subject: change.subject })
              : t('console.otherChange.model-access', {
                  // Subjects are `model:<id>` or `family:<series>`.
                  subject: change.subject.startsWith('family:')
                    ? `${t('scopeFamily')} ${change.subject.slice(7)}`
                    : change.subject.replace(/^model:/, ''),
                })}
        </strong>
        {change.before !== undefined &&
          change.after !== undefined &&
          `: ${change.before} → ${change.after}`}
        {enforce && (
          <span className="block text-orange-800 dark:text-orange-300">
            {t('console.flag.enforce')}
          </span>
        )}
        {change.type === 'model-access' && (
          <ModelAccessDifferences
            dimension={change.subject}
            saved={saved}
            draft={draft}
            groupNames={groupNames}
          />
        )}
      </div>
      <button type="button" className={ADMIN_BTN_SECONDARY} onClick={onUndo}>
        {t('console.undo')}
      </button>
    </article>
  );
};

/**
 * What a model access change does, line by line: the everyone-else default
 * and each group, domain or person whose terms were added, changed or
 * removed, as before → after chips.
 */
const ModelAccessDifferences: FC<{
  /** `model:<id>` or `family:<series>`, as the change names its subject. */
  dimension: string;
  saved: LimitsPolicy | null;
  draft: LimitsPolicy;
  groupNames: Record<string, string>;
}> = ({ dimension, saved, draft, groupNames }) => {
  const t = useTranslations('limits');
  const requestsDef = getLimitDefinition('model.requests');
  const find = (policy: LimitsPolicy | null) =>
    policy?.modelAccess.find(
      (rule) => modelAccessDimension(rule) === dimension.toLowerCase(),
    );
  const differences = ruleDifferences(find(saved), find(draft));
  const lookedUp = useGroupNames(
    differences.flatMap((difference) =>
      difference.audience !== 'everyone' &&
      difference.audience.scope === 'group'
        ? [difference.audience.target]
        : [],
    ),
  );
  const chip = (terms: AudienceTerms | undefined, inherited: boolean) =>
    terms === undefined ? (
      <span className="text-xs text-gray-600 dark:text-gray-400">
        {t('modelAccess.review.none')}
      </span>
    ) : (
      <ValueChip
        value={terms === false ? 0 : terms}
        def={requestsDef}
        inherited={inherited}
      />
    );
  return (
    <ul className="mt-2 space-y-1">
      {differences.map((difference) => {
        const everyone = difference.audience === 'everyone';
        const name =
          difference.audience === 'everyone'
            ? t('modelAccess.defaultLabel')
            : difference.audience.scope === 'group'
              ? (lookedUp[difference.audience.target] ??
                groupNames[difference.audience.target] ??
                difference.audience.target)
              : difference.audience.target;
        return (
          <li
            key={
              difference.audience === 'everyone'
                ? 'everyone'
                : audienceId(difference.audience)
            }
            className="flex flex-wrap items-center gap-x-2 gap-y-1"
          >
            <AudienceShape
              kind={
                difference.audience === 'everyone'
                  ? 'everyone'
                  : difference.audience.scope
              }
            />
            <span className="[overflow-wrap:anywhere]">{name}</span>
            {chip(difference.before, true)}
            <span aria-hidden="true">→</span>
            <span className="sr-only">{t('modelAccess.review.becomes')}</span>
            {chip(difference.after, false)}
            {!everyone && difference.after === undefined && (
              <span className="text-xs text-gray-600 dark:text-gray-400">
                {t('modelAccess.review.removed')}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
};
