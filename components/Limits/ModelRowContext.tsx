'use client';

import { FC, ReactNode } from 'react';

import { useTranslations } from 'next-intl';

import {
  CapCeiling,
  DAYS_PER_MONTH,
  ModelFacts,
  capCandidates,
  monthlyCeilingUsd,
  replayCaps,
  usageHistogram,
  usageSpread,
} from '@/lib/utils/app/modelFacts';
import {
  RETIREMENT_MOVE_DAYS,
  RETIREMENT_NOTICE_DAYS,
} from '@/lib/utils/shared/modelRetirement';

import { getModelHosting } from '@/types/openai';

import { ADMIN_MUTED } from '@/components/Admin/adminClasses';
import {
  ModelFactFormat,
  useModelFactFormat,
} from '@/components/Limits/modelFactFormat';

const DAY_MS = 24 * 60 * 60 * 1000;

const PANEL =
  'rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-surface-dark';
const PANEL_TITLE = 'text-sm font-semibold text-gray-900 dark:text-white';

/** The calendar day `days` before an ISO day. */
function daysBefore(isoDay: string, days: number): string {
  return new Date(Date.parse(`${isoDay}T00:00:00Z`) - days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

interface ModelRowContextProps {
  facts: ModelFacts;
  /** The "everyone else" cap in requests a day, or `null` when there is none. */
  cap: number | null;
  /** What that answer can cost one person; `null` when unpriced or cost is off. */
  ceiling: CapCeiling | null;
  /** Days of usage behind the figures. */
  windowDays: number;
  /** The label of the model people land on, when one is named. */
  replacementLabel: string | undefined;
}

/**
 * What an admin needs beside a model's access rules to judge a cap: how the
 * model is actually used, what each candidate cap would have done, what it
 * costs and emits, and when it goes away. Read-only.
 */
export const ModelRowContext: FC<ModelRowContextProps> = ({
  facts,
  cap,
  ceiling,
  windowDays,
  replacementLabel,
}) => {
  const t = useTranslations('limits');
  const format = useModelFactFormat();
  return (
    <section
      aria-label={t('modelAccess.facts.detail.region')}
      className="grid gap-3 lg:grid-cols-2"
    >
      <UsagePanel facts={facts} windowDays={windowDays} format={format} />
      <ReplayPanel facts={facts} cap={cap} ceiling={ceiling} format={format} />
      {facts.cost && (
        <Panel
          title={t('modelAccess.facts.detail.costTitle')}
          hint={t('modelAccess.facts.detail.costHint')}
        >
          <Facts>
            <Fact label={t('modelAccess.facts.detail.typicalRequest')}>
              {format.perRequest(facts.cost.typical)}
            </Fact>
            <Fact label={t('modelAccess.facts.detail.longRequest')}>
              {format.perRequest(facts.cost.heavy)}
            </Fact>
            {facts.spendUsd !== null && (
              <>
                <Fact
                  label={t('modelAccess.facts.detail.everyoneWindow', {
                    days: windowDays,
                  })}
                >
                  {format.usd(facts.spendUsd)}
                </Fact>
                {windowDays > 0 && (
                  <Fact label={t('modelAccess.facts.detail.atThisPace')}>
                    {format.usd((facts.spendUsd / windowDays) * DAYS_PER_MONTH)}
                  </Fact>
                )}
              </>
            )}
          </Facts>
        </Panel>
      )}
      <Panel
        title={t('modelAccess.facts.detail.footprintTitle')}
        hint={t('modelAccess.facts.detail.footprintHint')}
      >
        {facts.footprint ? (
          <Facts>
            <Fact label={t('modelAccess.facts.detail.sizeClass')}>
              {t(
                `modelAccess.facts.size.${facts.footprint.sizeClass}` as never,
              )}
            </Fact>
            <Fact label={t('modelAccess.facts.detail.typicalRequest')}>
              {format.co2(facts.footprint.gramsPerRequest)}
            </Fact>
            {facts.footprintGrams !== null && (
              <Fact
                label={t('modelAccess.facts.detail.everyoneWindow', {
                  days: windowDays,
                })}
              >
                {format.co2(facts.footprintGrams)}
              </Fact>
            )}
          </Facts>
        ) : (
          <p className={ADMIN_MUTED}>
            {t('modelAccess.facts.detail.noSizeClass')}
          </p>
        )}
      </Panel>
      <AboutPanel
        facts={facts}
        replacementLabel={replacementLabel}
        format={format}
      />
    </section>
  );
};

const Panel: FC<{ title: string; hint?: string; children: ReactNode }> = ({
  title,
  hint,
  children,
}) => (
  <div className={PANEL}>
    <h5 className={PANEL_TITLE}>{title}</h5>
    {hint && <p className={`mb-3 ${ADMIN_MUTED}`}>{hint}</p>}
    {!hint && <div className="mb-3" />}
    {children}
  </div>
);

const Facts: FC<{ children: ReactNode }> = ({ children }) => (
  <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 text-sm">
    {children}
  </dl>
);

const Fact: FC<{ label: string; children: ReactNode }> = ({
  label,
  children,
}) => (
  <>
    <dt className="text-gray-600 dark:text-gray-400">{label}</dt>
    <dd className="text-right font-semibold tabular-nums text-gray-900 dark:text-white">
      {children}
    </dd>
  </>
);

const Stat: FC<{ label: string; warn?: boolean; children: ReactNode }> = ({
  label,
  warn = false,
  children,
}) => (
  <div>
    <dt
      className={`text-xs ${warn ? 'text-orange-800 dark:text-orange-300' : 'text-gray-600 dark:text-gray-400'}`}
    >
      {label}
    </dt>
    <dd
      className={`text-base font-semibold tabular-nums ${warn ? 'text-orange-800 dark:text-orange-300' : 'text-gray-900 dark:text-white'}`}
    >
      {children}
    </dd>
  </div>
);

const UsagePanel: FC<{
  facts: ModelFacts;
  windowDays: number;
  format: ModelFactFormat;
}> = ({ facts, windowDays, format }) => {
  const t = useTranslations('limits');
  const { usage } = facts;
  const spread = usageSpread(usage.peaks);
  const title = t('modelAccess.facts.detail.usageTitle');
  if (!spread) {
    return (
      <Panel title={title}>
        <p className={ADMIN_MUTED}>
          {t('modelAccess.facts.detail.noUsage', { days: windowDays })}
        </p>
      </Panel>
    );
  }
  const bars = usageHistogram(usage.peaks);
  const tallest = Math.max(...bars.map((bar) => bar.people), 1);
  const rangeLabel = (from: number, to: number | null): string =>
    to === null
      ? t('modelAccess.facts.detail.bucketOpen', { from })
      : from === to
        ? String(from)
        : t('modelAccess.facts.detail.bucketRange', { from, to });
  return (
    <Panel
      title={title}
      hint={t('modelAccess.facts.detail.usageHint', {
        people: usage.people,
        days: windowDays,
      })}
    >
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">{t('modelAccess.facts.detail.bucketHeading')}</th>
            <th scope="col">{t('modelAccess.facts.detail.peopleHeading')}</th>
          </tr>
        </thead>
        <tbody>
          {bars.map((bar) => (
            <tr key={bar.from}>
              <th scope="row">{rangeLabel(bar.from, bar.to)}</th>
              <td>{bar.people}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div aria-hidden="true" className="overflow-x-auto">
        <div
          className="grid min-w-[20rem] items-end gap-1"
          style={{
            gridTemplateColumns: `repeat(${bars.length}, minmax(1.5rem, 1fr))`,
          }}
        >
          {bars.map((bar) => (
            <div
              key={bar.from}
              className="flex h-28 flex-col justify-end text-center"
            >
              <span className="text-[10px] tabular-nums text-gray-700 dark:text-gray-300">
                {bar.people > 0 ? format.count(bar.people) : ''}
              </span>
              <span
                className="rounded-t-sm bg-blue-700 dark:bg-blue-400"
                style={{
                  height: `${(bar.people / tallest) * 80}%`,
                  minHeight: bar.people > 0 ? 2 : 0,
                }}
              />
            </div>
          ))}
          {bars.map((bar) => (
            <span
              key={`label-${bar.from}`}
              className="border-t border-gray-400 pt-1 text-center text-[10px] text-gray-600 dark:border-gray-500 dark:text-gray-400"
            >
              {rangeLabel(bar.from, bar.to)}
            </span>
          ))}
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-6">
        {usage.average !== null && (
          <Stat label={t('modelAccess.facts.detail.average')}>
            {format.decimal(usage.average)}
          </Stat>
        )}
        <Stat label={t('modelAccess.facts.detail.median')}>
          {format.count(spread.median)}
        </Stat>
        <Stat label={t('modelAccess.facts.detail.p75')}>
          {format.count(spread.p75)}
        </Stat>
        <Stat label={t('modelAccess.facts.detail.p95')}>
          {format.count(spread.p95)}
        </Stat>
        <Stat label={t('modelAccess.facts.detail.max')}>
          {format.count(spread.max)}
        </Stat>
        {usage.capPeople > 0 && (
          <Stat label={t('modelAccess.facts.detail.reachedCap')} warn>
            {format.count(usage.capPeople)}
          </Stat>
        )}
      </dl>
      {usage.source === 'capped' && (
        <p className={`mt-3 ${ADMIN_MUTED}`}>
          {t('modelAccess.facts.detail.cappedOnly')}
        </p>
      )}
      {usage.peaksTruncated && (
        <p className={`mt-3 ${ADMIN_MUTED}`}>
          {t('modelAccess.facts.detail.truncated')}
        </p>
      )}
    </Panel>
  );
};

const ReplayPanel: FC<{
  facts: ModelFacts;
  cap: number | null;
  ceiling: CapCeiling | null;
  format: ModelFactFormat;
}> = ({ facts, cap, ceiling, format }) => {
  const t = useTranslations('limits');
  const { peaks } = facts.usage;
  if (peaks.length === 0) return null;
  const rows = replayCaps(capCandidates(cap, peaks), peaks);
  if (rows.length === 0) return null;
  const perRequest = facts.cost?.typical ?? null;
  const unbounded = ceiling?.kind === 'unbounded';
  return (
    <Panel
      title={t('modelAccess.facts.detail.replayTitle')}
      hint={t('modelAccess.facts.detail.replayHint')}
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[20rem] text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-600 dark:text-gray-400">
              <th scope="col" className="py-1 pe-3 font-semibold">
                {t('modelAccess.facts.detail.replayCap')}
              </th>
              <th scope="col" className="py-1 pe-3 font-semibold">
                {t('modelAccess.facts.detail.replayStopped')}
              </th>
              {perRequest !== null && (
                <th scope="col" className="py-1 font-semibold">
                  {t('modelAccess.facts.col.ceiling')}
                </th>
              )}
            </tr>
          </thead>
          <tbody className="tabular-nums text-gray-800 dark:text-gray-200">
            {rows.map((row) => {
              const current = row.cap === cap;
              return (
                <tr
                  key={row.cap}
                  className={`border-t border-gray-100 dark:border-gray-800 ${current ? 'bg-blue-50 font-semibold dark:bg-blue-950/40' : ''}`}
                >
                  <th
                    scope="row"
                    className="py-1.5 pe-3 text-left font-[inherit]"
                  >
                    {t(
                      current
                        ? 'modelAccess.facts.detail.replayNow'
                        : 'modelAccess.facts.detail.replayPerDay',
                      { cap: row.cap },
                    )}
                  </th>
                  <td className="py-1.5 pe-3">
                    {t('modelAccess.facts.detail.replayPeople', {
                      people: row.stopped,
                      share: format.percent(row.share),
                    })}
                  </td>
                  {perRequest !== null && (
                    <td className="py-1.5">
                      {format.usd(monthlyCeilingUsd(row.cap, perRequest))}
                    </td>
                  )}
                </tr>
              );
            })}
            {unbounded && (
              <tr className="border-t border-gray-100 bg-blue-50 font-semibold dark:border-gray-800 dark:bg-blue-950/40">
                <th
                  scope="row"
                  className="py-1.5 pe-3 text-left font-[inherit]"
                >
                  {t('modelAccess.facts.detail.replayUnlimitedNow')}
                </th>
                <td className="py-1.5 pe-3">
                  {t('modelAccess.facts.detail.replayPeople', {
                    people: 0,
                    share: format.percent(0),
                  })}
                </td>
                <td className="py-1.5 text-orange-800 dark:text-orange-300">
                  {t('modelAccess.facts.ceiling.unbounded')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
};

const AboutPanel: FC<{
  facts: ModelFacts;
  replacementLabel: string | undefined;
  format: ModelFactFormat;
}> = ({ facts, replacementLabel, format }) => {
  const t = useTranslations('limits');
  const { model, lifecycle } = facts;
  const abilities = model
    ? [
        model.supportsVision && t('modelAccess.facts.detail.can.images'),
        model.supportsTools && t('modelAccess.facts.detail.can.tools'),
        model.supportsCodeInterpreter &&
          t('modelAccess.facts.detail.can.codeInterpreter'),
        model.supportsReasoningEffort &&
          t('modelAccess.facts.detail.can.reasoningEffort'),
      ].filter((ability): ability is string => typeof ability === 'string')
    : [];
  const about = 'grid grid-cols-[9rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm';
  const term = 'text-gray-600 dark:text-gray-400';
  const value = 'text-gray-900 dark:text-white';
  return (
    <Panel title={t('modelAccess.facts.detail.aboutTitle')}>
      <dl className={about}>
        {lifecycle.lifecycle && (
          <>
            <dt className={term}>{t('modelAccess.facts.detail.status')}</dt>
            <dd className={value}>
              {t(`modelAccess.facts.lifecycle.${lifecycle.lifecycle}` as never)}
            </dd>
          </>
        )}
        <dt className={term}>{t('modelAccess.facts.col.retires')}</dt>
        <dd className={value}>
          {lifecycle.phase === 'forced'
            ? t('modelAccess.facts.detail.retiresForced')
            : lifecycle.retiresOn
              ? t('modelAccess.facts.detail.retiresOn', {
                  date: format.date(lifecycle.retiresOn),
                  notice: format.date(
                    daysBefore(lifecycle.retiresOn, RETIREMENT_NOTICE_DAYS),
                  ),
                  move: format.date(
                    daysBefore(lifecycle.retiresOn, RETIREMENT_MOVE_DAYS),
                  ),
                })
              : t('modelAccess.facts.detail.retiresUnknown')}
        </dd>
        {lifecycle.phase !== 'none' && (
          <>
            <dt className={term}>
              {t('modelAccess.facts.detail.replacement')}
            </dt>
            <dd
              className={
                replacementLabel
                  ? value
                  : 'font-semibold text-orange-800 dark:text-orange-300'
              }
            >
              {replacementLabel ??
                t('modelAccess.facts.detail.replacementNotSet')}
            </dd>
          </>
        )}
        {model?.knowledgeCutoffDate && (
          <>
            <dt className={term}>{t('modelAccess.facts.detail.knowledge')}</dt>
            <dd className={value}>{model.knowledgeCutoffDate.slice(0, 7)}</dd>
          </>
        )}
        {model?.maxLength !== undefined && (
          <>
            <dt className={term}>{t('modelAccess.facts.detail.context')}</dt>
            <dd className={value}>
              {t('modelAccess.facts.detail.contextTokens', {
                tokens: format.count(model.maxLength),
              })}
            </dd>
          </>
        )}
        {abilities.length > 0 && (
          <>
            <dt className={term}>{t('modelAccess.facts.detail.canDo')}</dt>
            <dd className={value}>{abilities.join(', ')}</dd>
          </>
        )}
        {model && (
          <>
            <dt className={term}>{t('modelAccess.facts.detail.hosted')}</dt>
            <dd className={value}>
              {t(
                `modelAccess.facts.detail.hosting.${getModelHosting(model)}` as never,
              )}
            </dd>
          </>
        )}
      </dl>
    </Panel>
  );
};
