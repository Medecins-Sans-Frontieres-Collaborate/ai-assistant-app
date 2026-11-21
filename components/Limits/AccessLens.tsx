'use client';

import { IconSearch } from '@tabler/icons-react';
import { FC, Fragment, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useEffectiveLimitsPreview } from '@/client/hooks/settings/useLimitsAdmin';
import type { PreviewPrincipal } from '@/client/hooks/settings/useMyLimits';
import { useGroupNames } from '@/client/hooks/useGroupNames';
import { useM365PeopleSuggest } from '@/client/hooks/useM365PeopleSuggest';

import { describeModelAccessOverrideId } from '@/lib/services/limits/modelAccess';
import {
  LimitCell,
  RuleEffectStatus,
  cellId,
  directionOf,
  effectStatus,
  memberPrincipal,
} from '@/lib/services/limits/policyChanges';
import {
  LayerExplanation,
  LimitExplanation,
  LimitSource,
  counterCellName,
  explainLimit,
} from '@/lib/services/limits/resolver';
import {
  LimitOverride,
  LimitValue,
  LimitsPolicy,
  OverrideScope,
} from '@/lib/services/limits/types';
import { Principal } from '@/lib/services/shared/principalMatching';

import {
  ADMIN_BANNER_WARN,
  ADMIN_BTN_SECONDARY,
  ADMIN_FIELD,
  ADMIN_MUTED,
} from '@/components/Admin/adminClasses';
import { GroupSearchPicker } from '@/components/AgentAccess/GroupSearchPicker';
import { normalizeDomainEntry } from '@/components/AgentAccess/RuleEditor';
import { ValueChoice } from '@/components/Limits/ValueChoice';
import { LIMIT_GROUPS } from '@/components/Limits/limitGroups';
import {
  audienceRule,
  entryFor,
  withAudienceEntry,
} from '@/components/Limits/limitsDraft';
import { appliesToLine } from '@/components/Limits/summaries';
import {
  AudienceShape,
  DirectionMark,
  ValueChip,
  audienceOfSource,
  useFormatLimitValue,
} from '@/components/Limits/visualSyntax';
import { EmailAutocompleteInput } from '@/components/UI/EmailAutocompleteInput';

import { LimitDefinition, getLimitDefinition } from '@/config/limits';

/** What the check view is looking at. */
export type LensSubjectKind = 'user' | 'group' | 'domain';

/** One person, one security group or one email domain. */
export interface LensSubject {
  kind: LensSubjectKind;
  /** Mail, Entra group object id, or domain; lower case. */
  target: string;
}

interface AccessLensProps {
  saved: LimitsPolicy | null;
  draft: LimitsPolicy;
  /** The draft differs from the saved policy. */
  dirty: boolean;
  groupNames: Record<string, string>;
  /** Opens the rule editor for an override id. */
  onEditRule: (overrideId: string) => void;
  /** Replaces the draft's overrides (an exception set from this view). */
  onOverridesChange: (overrides: LimitOverride[]) => void;
  /** Prefilled subject, e.g. a person from the review screen. */
  initialSubject?: LensSubject;
  disabled?: boolean;
}

const SUBJECT_KINDS: readonly LensSubjectKind[] = ['user', 'group', 'domain'];

/** The cascade columns, least specific first. */
const CASCADE: readonly LimitSource[] = [
  'catalog',
  'global',
  'domain',
  'attribute',
  'group',
  'user',
];

/** Every cell to show: each catalog key once, plus qualified cells in play. */
function cellsFor(
  policy: LimitsPolicy,
  extra: readonly LimitCell[],
): LimitCell[] {
  const cells: LimitCell[] = LIMIT_GROUPS.flatMap((group) => [
    ...(group.gateKey ? [group.gateKey] : []),
    ...group.memberKeys,
  ]).map((limitKey) => ({ limitKey }));
  const seen = new Set(cells.map(cellId));
  const qualified = [
    ...policy.defaults,
    ...policy.overrides.flatMap((o) => o.entries),
    ...extra,
  ].filter((cell) => cell.modelId || cell.series);
  for (const cell of qualified) {
    const id = cellId(cell);
    if (seen.has(id)) continue;
    seen.add(id);
    cells.push({
      limitKey: cell.limitKey,
      ...(cell.modelId ? { modelId: cell.modelId } : {}),
      ...(cell.series ? { series: cell.series } : {}),
    });
  }
  const order = new Map(cells.map((cell, index) => [cell.limitKey, index]));
  return cells.sort(
    (a, b) =>
      (order.get(a.limitKey) ?? 0) - (order.get(b.limitKey) ?? 0) ||
      cellId(a).localeCompare(cellId(b)),
  );
}

/**
 * "Check access": what one person, one security group or one domain gets
 * for every limit, the cascade that decided it (one column per level, the
 * deciding value ringed), and, for a person, what they used today.
 *
 * A person is resolved from the matching facts the server looks up once
 * (domain, attributes, groups). A group or domain is resolved as a TYPICAL
 * MEMBER: someone matched by that audience and nothing else.
 *
 * Opening a row also EDITS: "Exception for ..." sets that limit for exactly
 * the subject being checked, creating its own rule in the draft when it has
 * none, so an admin never has to go and assemble the rule elsewhere.
 */
export const AccessLens: FC<AccessLensProps> = ({
  saved,
  draft,
  dirty,
  groupNames,
  onEditRule,
  onOverridesChange,
  initialSubject,
  disabled = false,
}) => {
  const t = useTranslations('limits');
  const tPeople = useTranslations('peopleSuggest');
  const peopleSuggest = useM365PeopleSuggest();
  const [kind, setKind] = useState<LensSubjectKind>(
    initialSubject?.kind ?? 'user',
  );
  const [input, setInput] = useState(initialSubject?.target ?? '');
  const [subject, setSubject] = useState<LensSubject | null>(
    initialSubject ?? null,
  );
  const [showDraft, setShowDraft] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const mail = subject?.kind === 'user' ? subject.target : null;
  const { result, forbidden, isLoading, error } = useEffectiveLimitsPreview(
    mail,
    { usage: true },
  );
  const lookedUp = useGroupNames(
    subject?.kind === 'group' ? [subject.target] : [],
  );
  const names = useMemo(
    () => ({ ...groupNames, ...lookedUp }),
    [groupNames, lookedUp],
  );

  const principal: Principal | undefined = useMemo(() => {
    if (!subject) return undefined;
    if (subject.kind === 'user') {
      return result?.principal
        ? { userId: '', ...result.principal }
        : undefined;
    }
    return memberPrincipal(subject.kind, subject.target);
  }, [subject, result]);

  const useDraft = dirty && showDraft;
  const policy = useDraft ? draft : saved;
  /** Exceptions are edits to the draft, so they are offered on its side only. */
  const editable = !disabled && (useDraft || !dirty);
  const savedIds = useMemo(
    () => new Set((saved?.overrides ?? []).map((override) => override.id)),
    [saved],
  );
  const ownRule = subject
    ? audienceRule(draft.overrides, subject.kind, subject.target)
    : undefined;

  const usageByCell = useMemo(() => {
    const map = new Map<string, number>();
    if (subject?.kind !== 'user') return map;
    for (const row of result?.limits ?? []) {
      if (row.used !== undefined) map.set(counterCellName(row), row.used);
    }
    return map;
  }, [result, subject]);

  const rows = useMemo(() => {
    if (!principal) return [];
    const extra =
      subject?.kind === 'user'
        ? (result?.limits ?? []).map((row) => ({
            limitKey: row.limitKey,
            ...(row.modelId ? { modelId: row.modelId } : {}),
            ...(row.series ? { series: row.series } : {}),
          }))
        : [];
    return cellsFor(policy ?? draft, extra).flatMap((cell) => {
      const def = getLimitDefinition(cell.limitKey);
      if (!def) return [];
      const explanation = explainLimit(
        def,
        policy,
        principal,
        cell.modelId,
        cell.series,
      );
      const savedValue = dirty
        ? explainLimit(def, saved, principal, cell.modelId, cell.series)
            .resolved.value
        : explanation.resolved.value;
      return [{ cell, def, explanation, savedValue }];
    });
  }, [principal, policy, saved, draft, dirty, result, subject]);

  const check = (target: string = input) => {
    const raw = target.trim().toLowerCase();
    const next = kind === 'domain' ? normalizeDomainEntry(raw) : raw;
    setSubject(next.length > 0 ? { kind, target: next } : null);
    setOpen(null);
  };

  const changeKind = (next: LensSubjectKind) => {
    setKind(next);
    setInput('');
    setSubject(null);
    setOpen(null);
  };

  const subjectName = subject
    ? subject.kind === 'group'
      ? (names[subject.target] ?? subject.target)
      : subject.target
    : '';
  const showUsage = subject?.kind === 'user';
  const columns = (showUsage ? 3 : 2) + CASCADE.length;

  const setException = (
    cell: LimitCell,
    value: LimitValue | undefined,
  ): void => {
    if (!subject) return;
    onOverridesChange(
      withAudienceEntry(
        draft.overrides,
        { scope: subject.kind, target: subject.target },
        cell,
        value,
        { savedIds },
      ),
    );
    setShowDraft(true);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="radiogroup"
          aria-label={t('console.lens.subjectKind')}
          className="grid grid-cols-3 overflow-hidden rounded-lg border border-gray-300 dark:border-gray-600"
        >
          {SUBJECT_KINDS.map((option) => (
            <label
              key={option}
              className={`flex h-9 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap px-3 text-sm focus-within:ring-2 focus-within:ring-inset focus-within:ring-blue-500 ${
                kind === option
                  ? 'bg-gray-900 font-semibold text-white dark:bg-gray-100 dark:text-gray-900'
                  : 'bg-white text-gray-900 dark:bg-gray-900 dark:text-gray-100'
              }`}
            >
              <input
                type="radio"
                className="sr-only"
                name="limits-lens-subject"
                checked={kind === option}
                onChange={() => changeKind(option)}
              />
              <AudienceShape kind={option} />
              {t(`console.lens.kind.${option}`)}
            </label>
          ))}
        </div>
        {kind === 'user' && (
          <EmailAutocompleteInput
            className={`min-w-[18rem] ${ADMIN_FIELD}`}
            value={input}
            onChange={setInput}
            suggest={peopleSuggest}
            suggestionsLabel={tPeople('listLabel')}
            onKeyDown={(event) => {
              if (event.key === 'Enter') check();
            }}
            placeholder={t('previewEmailPlaceholder')}
            aria-label={t('previewEmailLabel')}
          />
        )}
        {kind === 'domain' && (
          <input
            type="text"
            className={`min-w-[18rem] ${ADMIN_FIELD}`}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') check();
            }}
            placeholder={t('targetsPlaceholder.domain')}
            aria-label={t('console.lens.domainLabel')}
          />
        )}
        {kind !== 'group' && (
          <button
            type="button"
            className={ADMIN_BTN_SECONDARY}
            onClick={() => check()}
            disabled={input.trim().length === 0}
          >
            <IconSearch size={16} aria-hidden="true" />
            {t('previewRun')}
          </button>
        )}
        {dirty && (
          <div
            role="radiogroup"
            aria-label={t('console.policyShown')}
            className="ml-auto grid grid-cols-2 overflow-hidden rounded-lg border border-gray-300 dark:border-gray-600"
          >
            {[false, true].map((draftSide) => (
              <label
                key={String(draftSide)}
                className={`flex h-9 cursor-pointer items-center justify-center px-3 text-sm focus-within:ring-2 focus-within:ring-inset focus-within:ring-blue-500 ${
                  showDraft === draftSide
                    ? 'bg-gray-900 font-semibold text-white dark:bg-gray-100 dark:text-gray-900'
                    : 'bg-white text-gray-900 dark:bg-gray-900 dark:text-gray-100'
                }`}
              >
                <input
                  type="radio"
                  className="sr-only"
                  name="limits-lens-policy"
                  checked={showDraft === draftSide}
                  onChange={() => setShowDraft(draftSide)}
                />
                {draftSide ? t('console.withDraft') : t('console.savedPolicy')}
              </label>
            ))}
          </div>
        )}
      </div>
      {kind === 'group' && (
        <div className="max-w-xl">
          {/* The picker hands back what was added; the first pick is checked. */}
          <GroupSearchPicker
            values={[]}
            onChange={(added) => {
              if (added[0]) check(added[0]);
            }}
            labels={{
              searchPlaceholder: t('groupSearchPlaceholder'),
              searchHint: t('console.lens.groupHint'),
              noResults: t('groupSearchNoResults'),
              searchError: t('groupSearchError'),
              chipPlaceholder: t('targetsPlaceholder.group'),
              addHint: t('chipAddHint'),
              removeLabel: t('removeChip'),
              flagOffHint: t('groupsFlagOff'),
            }}
          />
        </div>
      )}

      {subject === null && (
        <p className={ADMIN_MUTED}>{t('console.lens.intro')}</p>
      )}
      {isLoading && (
        <p className={ADMIN_MUTED} role="status">
          {t('previewLoading')}
        </p>
      )}
      {error && (
        <p className={ADMIN_BANNER_WARN} role="alert">
          {t('previewFailed')}
        </p>
      )}
      {forbidden && (
        <p className={ADMIN_BANNER_WARN} role="alert">
          {t('previewForbidden')}
        </p>
      )}
      {subject && principal && (
        <>
          {subject.kind === 'user' && result?.principal ? (
            <MatchedAs
              principal={result.principal}
              policy={policy ?? draft}
              groupNames={names}
            />
          ) : (
            <p className="flex flex-wrap items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
              <AudienceShape kind={subject.kind} />
              <strong>{subjectName}</strong>
              <span className="text-gray-600 dark:text-gray-400">
                {t(`console.lens.typicalMember.${subject.kind}` as never)}
              </span>
            </p>
          )}
          {subject.kind === 'user' &&
            result?.directoryStatus === 'unavailable' && (
              <p className={ADMIN_BANNER_WARN}>{t('previewNotEvaluated')}</p>
            )}
          {subject.kind === 'user' &&
            result?.directoryStatus === 'not-found' && (
              <p className={ADMIN_BANNER_WARN}>
                {t('previewDirectoryNotFound')}
              </p>
            )}
          {ownRule && ownRule.entries.length > 0 && (
            <p className="flex flex-wrap items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
              {t('console.lens.ownRule', {
                count: ownRule.entries.length,
                subject: subjectName,
              })}
              <button
                type="button"
                className="text-blue-700 underline dark:text-blue-400"
                onClick={() => onEditRule(ownRule.id)}
              >
                {t('console.editRule')}
              </button>
            </p>
          )}
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-surface-dark">
            <table className="w-full min-w-[60rem] border-collapse text-sm">
              <caption className="sr-only">
                {t('console.lensCaption', { mail: subjectName })}
              </caption>
              <thead>
                <tr className="text-left text-xs text-gray-600 dark:text-gray-400">
                  <th scope="col" className="px-4 py-2 font-semibold">
                    {t('console.col.limit')}
                  </th>
                  <th scope="col" className="px-2 py-2 font-semibold">
                    {t('console.col.theyGet')}
                  </th>
                  {showUsage && (
                    <th scope="col" className="px-2 py-2 font-semibold">
                      {t('console.col.usedToday')}
                    </th>
                  )}
                  {CASCADE.map((source) => (
                    <th
                      key={source}
                      scope="col"
                      className="px-1 py-2 text-center font-semibold"
                    >
                      <SourceHeading source={source} />
                    </th>
                  ))}
                </tr>
                <tr>
                  <td colSpan={columns - CASCADE.length} />
                  <td
                    colSpan={CASCADE.length}
                    className="pb-1 text-center text-[11px] text-gray-500 dark:text-gray-400"
                  >
                    {t('console.moreSpecificWins')}
                  </td>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ cell, def, explanation, savedValue }) => {
                  const id = cellId(cell);
                  const expanded = open === id;
                  const changed =
                    useDraft && savedValue !== explanation.resolved.value;
                  const used = usageByCell.get(counterCellName(cell));
                  const label = `${t(`label.${def.labelKey}` as never)}${
                    cell.modelId ? ` · ${cell.modelId}` : ''
                  }${cell.series ? ` · ${t('scopeFamily')} ${cell.series}` : ''}`;
                  return (
                    <Fragment key={id}>
                      <tr
                        className={`border-t border-gray-100 dark:border-gray-800 ${changed ? 'bg-orange-50 dark:bg-orange-950/30' : ''}`}
                      >
                        <th
                          scope="row"
                          className="px-4 py-2 text-left font-normal"
                        >
                          <button
                            type="button"
                            aria-expanded={expanded}
                            onClick={() => setOpen(expanded ? null : id)}
                            className="text-left text-gray-900 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-white"
                          >
                            {label}
                          </button>
                        </th>
                        <td className="px-2 py-2">
                          <ValueChip
                            value={explanation.resolved.value}
                            def={def}
                            ceiling={explanation.resolved.ceilingApplied}
                            delegated={explanation.resolved.tier === 'scoped'}
                            inherited={explanation.winnerSource === 'catalog'}
                          />
                        </td>
                        {showUsage && (
                          <td className="px-2 py-2">
                            <UsageMeter
                              used={used}
                              limit={explanation.resolved.value}
                              def={def}
                            />
                          </td>
                        )}
                        {CASCADE.map((source) => (
                          <td key={source} className="px-1 py-2 text-center">
                            <CascadeCell
                              layer={explanation.layers.find(
                                (l) => l.source === source,
                              )}
                              explanation={explanation}
                              def={def}
                            />
                          </td>
                        ))}
                      </tr>
                      {expanded && (
                        <tr
                          className={
                            changed ? 'bg-orange-50 dark:bg-orange-950/30' : ''
                          }
                        >
                          <td colSpan={columns} className="space-y-3 px-4 pb-3">
                            <Why
                              explanation={explanation}
                              def={def}
                              policy={policy ?? draft}
                              groupNames={names}
                              savedValue={changed ? savedValue : undefined}
                              onEditRule={onEditRule}
                            />
                            {editable && (
                              <ExceptionEditor
                                subject={subject}
                                subjectName={subjectName}
                                label={label}
                                def={def}
                                cell={cell}
                                rule={ownRule}
                                policy={draft}
                                principal={principal}
                                onChange={(value) => setException(cell, value)}
                              />
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className={ADMIN_MUTED}>{t('console.lensLegend')}</p>
        </>
      )}
    </div>
  );
};

/**
 * Sets one limit for exactly the subject being checked. The value is the
 * entry on the subject's own rule (created on first use); "Inherit" removes
 * it. The line underneath says what the exception does, or why it does not
 * take effect (a hard ceiling, a higher-ranked rule).
 */
const ExceptionEditor: FC<{
  subject: LensSubject;
  subjectName: string;
  label: string;
  def: LimitDefinition;
  cell: LimitCell;
  rule: LimitOverride | undefined;
  /** The draft policy, which is what an exception edits. */
  policy: LimitsPolicy;
  principal: Principal;
  onChange: (value: LimitValue | undefined) => void;
}> = ({
  subject,
  subjectName,
  label,
  def,
  cell,
  rule,
  policy,
  principal,
  onChange,
}) => {
  const t = useTranslations('limits');
  const format = useFormatLimitValue();
  const entry = rule ? entryFor(rule.entries, cell) : undefined;
  const without: LimitsPolicy = rule
    ? {
        ...policy,
        overrides: policy.overrides.filter((o) => o.id !== rule.id),
      }
    : policy;
  const otherwise = explainLimit(
    def,
    without,
    principal,
    cell.modelId,
    cell.series,
  ).resolved.value;
  const withRule = explainLimit(
    def,
    policy,
    principal,
    cell.modelId,
    cell.series,
  );
  const status: RuleEffectStatus | null =
    rule && entry ? effectStatus(rule, withRule) : null;
  const now = withRule.resolved.value;
  const direction = directionOf(otherwise, now);
  return (
    <section
      aria-label={t('console.lens.exceptionFor', { subject: subjectName })}
      className="space-y-2 rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-surface-dark"
    >
      <h4 className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-white">
        <AudienceShape kind={subject.kind} />
        {t('console.lens.exceptionFor', { subject: subjectName })}
      </h4>
      <ValueChoice
        def={def}
        label={t('console.lens.exceptionLabel', {
          limit: label,
          subject: subjectName,
        })}
        value={entry?.value}
        inherited={otherwise}
        onChange={onChange}
      />
      {status === null ? (
        <p className={ADMIN_MUTED}>
          {t(`console.lens.noException.${subject.kind}` as never)}
        </p>
      ) : (
        <p className="text-sm text-gray-700 dark:text-gray-300">
          {status === 'applies' && direction !== 'same' && (
            <>
              <DirectionMark
                direction={
                  now === null && otherwise !== null ? 'removes-cap' : direction
                }
              />{' '}
            </>
          )}
          {t(
            status === 'applies' && direction === 'same'
              ? 'console.lens.effect.same'
              : `console.lens.effect.${status}`,
            {
              value: format(now, def).text,
              otherwise: format(otherwise, def).text,
            },
          )}
        </p>
      )}
    </section>
  );
};

const SourceHeading: FC<{ source: LimitSource }> = ({ source }) => {
  const t = useTranslations('limits');
  const kind = audienceOfSource(source);
  return (
    <span className="inline-flex items-center gap-1">
      {kind && <AudienceShape kind={kind} />}
      {t(`console.layer.${source}` as never)}
    </span>
  );
};

/** One level in the cascade: its best record, ringed when it decides. */
const CascadeCell: FC<{
  layer: LayerExplanation | undefined;
  explanation: LimitExplanation;
  def: LimitDefinition;
}> = ({ layer, explanation, def }) => {
  if (!layer) {
    return (
      <span aria-hidden="true" className="text-gray-300 dark:text-gray-600">
        ·
      </span>
    );
  }
  const ceiling = explanation.ceiling;
  const decides = ceiling
    ? layer.source === ceiling.source && layer.overrideId === ceiling.overrideId
    : layer.source === explanation.winnerSource;
  return (
    <ValueChip
      value={layer.value}
      def={def}
      ceiling={layer.ceiling}
      delegated={layer.tier === 'scoped'}
      winner={decides}
      lost={!decides}
    />
  );
};

const UsageMeter: FC<{
  used: number | undefined;
  limit: number | boolean | null;
  def: LimitDefinition;
}> = ({ used, limit, def }) => {
  const t = useTranslations('limits');
  const format = useFormatLimitValue();
  if (def.kind !== 'counter') {
    return (
      <span className="text-xs text-gray-500 dark:text-gray-400">
        {t('console.perRequest')}
      </span>
    );
  }
  if (used === undefined) {
    return (
      <span className="text-xs text-gray-500 dark:text-gray-400">
        {limit === null ? t('console.notMeasured') : t('console.noUsage')}
      </span>
    );
  }
  if (typeof limit !== 'number' || limit <= 0) {
    return (
      <span className="text-xs tabular-nums">{format(used, def).text}</span>
    );
  }
  const ratio = Math.min(1, used / limit);
  const text = t('console.usedOf', {
    used: format(used, def).text,
    limit: format(limit, def).text,
  });
  return (
    <span className="flex items-center gap-2">
      <span
        role="img"
        aria-label={text}
        className="relative block h-2 w-20 rounded-full bg-gray-100 dark:bg-gray-800"
      >
        <span
          className={`absolute inset-y-0 left-0 rounded-full ${ratio >= 0.8 ? 'bg-orange-400' : 'bg-blue-400'}`}
          style={{ width: `${ratio * 100}%` }}
        />
      </span>
      <span className="text-xs tabular-nums text-gray-800 dark:text-gray-200">
        {text}
      </span>
    </span>
  );
};

/** The person's domain, attributes and the groups the policy refers to. */
const MatchedAs: FC<{
  principal: PreviewPrincipal;
  policy: LimitsPolicy;
  groupNames: Record<string, string>;
}> = ({ principal, policy, groupNames }) => {
  const t = useTranslations('limits');
  const referenced = new Set(
    policy.overrides
      .filter((o) => o.scope === 'group')
      .flatMap((o) => o.targets.map((g) => g.toLowerCase())),
  );
  const groups = principal.groupIds.filter((id) =>
    referenced.has(id.toLowerCase()),
  );
  const chip =
    'inline-flex h-6 items-center gap-1 rounded-full border border-gray-300 bg-white px-2 text-xs text-gray-800 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200';
  return (
    <section
      aria-label={t('console.matchedAs')}
      className="flex flex-wrap items-center gap-2 text-sm"
    >
      <span className="text-gray-600 dark:text-gray-400">
        {t('console.matchedAs')}
      </span>
      {principal.domain && (
        <span className={chip}>
          <AudienceShape kind="domain" />
          {principal.domain}
        </span>
      )}
      {principal.attributes.map((attribute) => (
        <span key={attribute} className={chip}>
          <AudienceShape kind="attribute" />
          {attribute}
        </span>
      ))}
      {groups.map((id) => (
        <span key={id} className={chip}>
          <AudienceShape kind="group" />
          {groupNames[id] ?? id}
        </span>
      ))}
      {principal.groupIds.length > groups.length && (
        <span className="text-xs text-gray-600 dark:text-gray-400">
          {t('console.otherGroups', {
            count: principal.groupIds.length - groups.length,
          })}
        </span>
      )}
    </section>
  );
};

/** The opened row, in words: every level that has a say, and why one wins. */
const Why: FC<{
  explanation: LimitExplanation;
  def: LimitDefinition;
  policy: LimitsPolicy;
  groupNames: Record<string, string>;
  savedValue: number | boolean | null | undefined;
  onEditRule: (overrideId: string) => void;
}> = ({ explanation, def, policy, groupNames, savedValue, onEditRule }) => {
  const t = useTranslations('limits');
  const format = useFormatLimitValue();
  const nameOf = (layer: LayerExplanation): string => {
    if (layer.source === 'catalog') return t('console.layer.catalog');
    if (!layer.overrideId) return t('console.everyone');
    const access = describeModelAccessOverrideId(layer.overrideId);
    if (access)
      return t('previewSourceModelAccess', {
        list: t(`modelAccess.list.${access.list}` as never),
      });
    const rule = policy.overrides.find((o) => o.id === layer.overrideId);
    return rule
      ? rule.label || appliesToLine(t, rule.scope, rule.targets, groupNames)
      : layer.overrideId;
  };
  const decider =
    explanation.ceiling ??
    explanation.layers.find((l) => l.source === explanation.winnerSource);
  return (
    <div className="space-y-1 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-800 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-200">
      <p>
        <strong>{format(explanation.resolved.value, def).text}</strong>
        {decider &&
          ` ${t('console.why.decidedBy', { rule: nameOf(decider as LayerExplanation) })}`}
        {explanation.ceiling && ` ${t('console.why.ceiling')}`}
        {explanation.resolved.hardCeilingApplied &&
          ` ${t('console.why.hardCeiling')}`}
      </p>
      {savedValue !== undefined && (
        <p>
          {t('console.why.draftChanged', {
            saved: format(savedValue, def).text,
          })}
        </p>
      )}
      <ul className="space-y-0.5">
        {[...explanation.layers].reverse().map((layer) => {
          const kind = audienceOfSource(layer.source);
          return (
            <li
              key={`${layer.source}-${layer.overrideId ?? ''}`}
              className="flex flex-wrap items-center gap-2"
            >
              {kind && <AudienceShape kind={kind} />}
              <span>{nameOf(layer)}</span>
              <ValueChip
                value={layer.value}
                def={def}
                ceiling={layer.ceiling}
                delegated={layer.tier === 'scoped'}
              />
              {layer.outranked > 0 && (
                <span className={ADMIN_MUTED}>
                  {t('console.why.outranked', { count: layer.outranked })}
                </span>
              )}
              {layer.overrideId &&
                policy.overrides.some((o) => o.id === layer.overrideId) && (
                  <button
                    type="button"
                    className="text-xs text-blue-700 underline dark:text-blue-400"
                    onClick={() => onEditRule(layer.overrideId as string)}
                  >
                    {t('console.editRule')}
                  </button>
                )}
            </li>
          );
        })}
      </ul>
      {def.perModel &&
        (explanation.resolved.modelId || explanation.resolved.series) &&
        def.kind === 'counter' && (
          <p className={ADMIN_MUTED}>{t('console.why.envelope')}</p>
        )}
    </div>
  );
};
