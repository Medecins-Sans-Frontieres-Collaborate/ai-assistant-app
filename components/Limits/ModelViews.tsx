'use client';

import { FC, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  MapFinding,
  MappedModel,
  ModelFacts,
  ReplacementAccess,
  isRetiringSoon,
  mapFindings,
} from '@/lib/utils/app/modelFacts';
import {
  RETIREMENT_MOVE_DAYS,
  RETIREMENT_NOTICE_DAYS,
} from '@/lib/utils/shared/modelRetirement';

import {
  ADMIN_BANNER_WARN,
  ADMIN_BTN_SECONDARY,
  ADMIN_MUTED,
} from '@/components/Admin/adminClasses';
import {
  ModelFactFormat,
  useModelFactFormat,
} from '@/components/Limits/modelFactFormat';

const PANEL =
  'rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-surface-dark';
const WARN_TEXT = 'font-semibold text-orange-800 dark:text-orange-300';

// ---------------------------------------------------------------------------
// Retirement runway
// ---------------------------------------------------------------------------

/** One model on the runway. */
export interface RunwayModel {
  facts: ModelFacts;
  label: string;
  /** The replacement's label; `undefined` when none is named. */
  replacementLabel: string | undefined;
  /** How access compares with the replacement; `null` when it cannot be checked. */
  access: ReplacementAccess | null;
  /** True when the model has rules of its own that could be carried over. */
  canCarryOver: boolean;
}

/** The shortest span the runway draws, so near dates do not fill the chart. */
const MIN_HORIZON_DAYS = 180;

interface ModelRunwayProps {
  models: readonly RunwayModel[];
  /** Opens a model's row in the access grid. */
  onOpen: (modelId: string) => void;
  /** Copies the model's rules onto its replacement, as a draft. */
  onCarryOver: (modelId: string) => void;
  disabled: boolean;
}

/**
 * When each model goes away, who is on it, and whether its access rules
 * match the replacement's. Models with a date, soonest first; the rest are
 * listed below so "no date" is not mistaken for "not retiring".
 */
export const ModelRunway: FC<ModelRunwayProps> = ({
  models,
  onOpen,
  onCarryOver,
  disabled,
}) => {
  const t = useTranslations('limits');
  const format = useModelFactFormat();
  const dated = models
    .filter(
      (model) =>
        model.facts.lifecycle.daysLeft !== undefined &&
        model.facts.lifecycle.phase !== 'past',
    )
    .sort(
      (a, b) =>
        (a.facts.lifecycle.daysLeft as number) -
        (b.facts.lifecycle.daysLeft as number),
    );
  const past = models.filter((model) => model.facts.lifecycle.phase === 'past');
  const forced = models.filter(
    (model) =>
      model.facts.lifecycle.phase === 'forced' &&
      model.facts.lifecycle.daysLeft === undefined,
  );
  const undated = models.filter(
    (model) => model.facts.lifecycle.phase === 'none',
  );
  const horizon = Math.max(
    MIN_HORIZON_DAYS,
    ...dated.map((model) => model.facts.lifecycle.daysLeft as number),
  );
  const soon = dated.filter((model) =>
    isRetiringSoon(model.facts.lifecycle.phase),
  );

  return (
    <div className="space-y-4">
      <p className={ADMIN_MUTED}>{t('modelAccess.runway.lead')}</p>
      {[...forced, ...soon].map((model) => (
        <p key={model.facts.modelId} className={ADMIN_BANNER_WARN} role="note">
          {model.facts.lifecycle.phase === 'forced'
            ? t('modelAccess.runway.alertForced', {
                model: model.label,
                people: model.facts.usage.people,
              })
            : t('modelAccess.runway.alert', {
                model: model.label,
                days: model.facts.lifecycle.daysLeft as number,
                people: model.facts.usage.people,
              })}{' '}
          {model.replacementLabel
            ? t('modelAccess.runway.alertTo', {
                model: model.replacementLabel,
              })
            : t('modelAccess.runway.alertNoReplacement')}
        </p>
      ))}
      {dated.length + forced.length === 0 ? (
        <p className={ADMIN_MUTED}>{t('modelAccess.runway.empty')}</p>
      ) : (
        <div className={`overflow-x-auto ${PANEL}`}>
          <table className="w-full min-w-[60rem] border-collapse text-sm">
            <caption className="sr-only">
              {t('modelAccess.runway.caption')}
            </caption>
            <thead>
              <tr className="text-left text-xs text-gray-600 dark:text-gray-400">
                <th scope="col" className="px-4 py-2 font-semibold">
                  {t('modelAccess.grid.col.model')}
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  {t('modelAccess.runway.col.people')}
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  {t('modelAccess.runway.col.landsOn')}
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  {t('modelAccess.runway.col.access')}
                </th>
                <th scope="col" className="w-[32%] px-3 py-2 font-semibold">
                  <span className="flex justify-between">
                    <span>{t('modelAccess.runway.today')}</span>
                    <span>{format.fromNow(horizon)}</span>
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {[...forced, ...dated].map((model) => (
                <RunwayRow
                  key={model.facts.modelId}
                  model={model}
                  horizon={horizon}
                  format={format}
                  onOpen={onOpen}
                  onCarryOver={onCarryOver}
                  disabled={disabled}
                />
              ))}
            </tbody>
          </table>
          <p className="flex flex-wrap gap-x-4 gap-y-1 border-t border-gray-200 px-4 py-2 text-[11px] text-gray-600 dark:border-gray-700 dark:text-gray-400">
            <LegendSwatch className="bg-blue-200 dark:bg-blue-800">
              {t('modelAccess.runway.legend.service')}
            </LegendSwatch>
            <LegendSwatch className="bg-orange-300 dark:bg-orange-500">
              {t('modelAccess.runway.legend.notice', {
                days: RETIREMENT_NOTICE_DAYS,
              })}
            </LegendSwatch>
            <LegendSwatch className="bg-orange-900 dark:bg-orange-200">
              {t('modelAccess.runway.legend.move', {
                days: RETIREMENT_MOVE_DAYS,
              })}
            </LegendSwatch>
          </p>
        </div>
      )}
      {past.length > 0 && (
        <p className="text-sm text-gray-800 dark:text-gray-200">
          <strong>{t('modelAccess.runway.pastTitle')}</strong>{' '}
          {past
            .map((model) =>
              t('modelAccess.runway.pastItem', {
                model: model.label,
                date: format.date(model.facts.lifecycle.retiresOn as string),
                people: model.facts.usage.people,
              }),
            )
            .join('; ')}
        </p>
      )}
      {undated.length > 0 && (
        <p className="text-sm text-gray-800 dark:text-gray-200">
          <strong>{t('modelAccess.runway.undatedTitle')}</strong>{' '}
          {undated.map((model) => model.label).join(', ')}
        </p>
      )}
      <p className={ADMIN_MUTED}>{t('modelAccess.runway.rulesNote')}</p>
    </div>
  );
};

const LegendSwatch: FC<{ className: string; children: string }> = ({
  className,
  children,
}) => (
  <span className="inline-flex items-center gap-1.5">
    <span className={`inline-block h-2.5 w-5 rounded-sm ${className}`} />
    {children}
  </span>
);

const RunwayRow: FC<{
  model: RunwayModel;
  horizon: number;
  format: ModelFactFormat;
  onOpen: (modelId: string) => void;
  onCarryOver: (modelId: string) => void;
  disabled: boolean;
}> = ({ model, horizon, format, onOpen, onCarryOver, disabled }) => {
  const t = useTranslations('limits');
  const { lifecycle, usage, modelId } = model.facts;
  const days = lifecycle.daysLeft;
  const share = (value: number) =>
    `${Math.min(100, Math.max(0, (value / horizon) * 100))}%`;
  const noticeFrom = days === undefined ? 0 : days - RETIREMENT_NOTICE_DAYS;
  const moveFrom = days === undefined ? 0 : days - RETIREMENT_MOVE_DAYS;
  const when =
    lifecycle.phase === 'forced'
      ? t('modelAccess.facts.retires.forced')
      : lifecycle.retiresOn && days !== undefined
        ? `${format.date(lifecycle.retiresOn)}, ${format.fromNow(days)}`
        : '';
  const differs = model.access?.kind === 'differs' ? model.access : null;
  return (
    <tr className="border-t border-gray-100 align-middle dark:border-gray-800">
      <th scope="row" className="px-4 py-2 text-left font-normal">
        <button
          type="button"
          onClick={() => onOpen(modelId)}
          className="rounded text-left font-semibold text-gray-900 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-white"
        >
          {model.label}
        </button>
        <span className="block text-xs text-gray-600 dark:text-gray-400">
          {when}
        </span>
      </th>
      <td className="px-3 py-2 font-semibold tabular-nums text-gray-900 dark:text-white">
        {format.count(usage.people)}
      </td>
      <td
        className={`px-3 py-2 ${model.replacementLabel ? 'text-gray-800 dark:text-gray-200' : WARN_TEXT}`}
      >
        {model.replacementLabel ??
          t('modelAccess.facts.detail.replacementNotSet')}
      </td>
      <td className="px-3 py-2 text-gray-800 dark:text-gray-200">
        {!model.replacementLabel || !model.access ? (
          <span className={WARN_TEXT}>
            {t('modelAccess.runway.access.unknown')}
          </span>
        ) : differs ? (
          <>
            <span className={WARN_TEXT}>
              {differs.everyone && differs.audiences > 0
                ? t('modelAccess.runway.access.both', {
                    count: differs.audiences,
                  })
                : differs.everyone
                  ? t('modelAccess.runway.access.everyone')
                  : t('modelAccess.runway.access.audiences', {
                      count: differs.audiences,
                    })}
            </span>
            {model.canCarryOver && (
              <button
                type="button"
                className={`mt-1 ${ADMIN_BTN_SECONDARY}`}
                onClick={() => onCarryOver(modelId)}
                disabled={disabled}
              >
                {t('modelAccess.runway.carryOver', {
                  model: model.replacementLabel,
                })}
              </button>
            )}
          </>
        ) : (
          t('modelAccess.runway.access.same')
        )}
      </td>
      <td className="px-3 py-2">
        {days !== undefined && (
          <span
            role="img"
            aria-label={when}
            className="relative block h-3.5 border-s-2 border-gray-900 dark:border-white"
          >
            <span
              className="absolute inset-y-0 start-0 rounded-e-sm bg-blue-200 dark:bg-blue-800"
              style={{ width: share(days) }}
            />
            <span
              className="absolute inset-y-0 bg-orange-300 dark:bg-orange-500"
              style={{
                insetInlineStart: share(noticeFrom),
                width: `calc(${share(days)} - ${share(noticeFrom)})`,
              }}
            />
            <span
              className="absolute inset-y-0 rounded-e-sm bg-orange-900 dark:bg-orange-200"
              style={{
                insetInlineStart: share(moveFrom),
                width: `calc(${share(days)} - ${share(moveFrom)})`,
              }}
            />
          </span>
        )}
      </td>
    </tr>
  );
};

// ---------------------------------------------------------------------------
// Spend and popularity map
// ---------------------------------------------------------------------------

/** What a circle's area stands for. */
const SIZE_MEASURES = ['spend', 'footprint', 'requests'] as const;
type SizeMeasure = (typeof SIZE_MEASURES)[number];

const MIN_DOT_PX = 10;
const MAX_DOT_PX = 72;

/** Circle fill by size class; the outline alone marks "size not set". */
const SIZE_FILL: Record<string, string> = {
  nano: 'bg-blue-100 border-blue-900 dark:bg-blue-200 dark:border-blue-100',
  mini: 'bg-blue-100 border-blue-900 dark:bg-blue-200 dark:border-blue-100',
  standard: 'bg-blue-400 border-blue-900 dark:border-blue-100',
  large: 'bg-blue-700 border-blue-900 dark:border-blue-100',
  xl: 'bg-blue-950 border-blue-950 dark:bg-blue-900 dark:border-blue-100',
};
const SIZE_UNSET =
  'bg-white border-dashed border-gray-500 dark:bg-gray-900 dark:border-gray-300';

function measureOf(facts: ModelFacts, measure: SizeMeasure): number {
  if (measure === 'spend') return facts.spendUsd ?? 0;
  if (measure === 'footprint') return facts.footprintGrams ?? 0;
  return facts.usage.requests ?? 0;
}

interface ModelSpendMapProps {
  models: readonly MappedModel[];
  windowDays: number;
  onOpen: (modelId: string) => void;
}

/**
 * Every priced model that was used, as a circle: further right costs more
 * per request, higher has more people, bigger has spent (or emitted, or
 * been asked) more. The same figures follow as a table.
 */
export const ModelSpendMap: FC<ModelSpendMapProps> = ({
  models,
  windowDays,
  onOpen,
}) => {
  const t = useTranslations('limits');
  const format = useModelFactFormat();
  const [measure, setMeasure] = useState<SizeMeasure>('spend');
  const plotted = models.filter(
    (model) => model.facts.cost !== null && model.facts.usage.people > 0,
  );
  if (plotted.length === 0) {
    return (
      <p className={ADMIN_MUTED}>
        {t('modelAccess.map.empty', { days: windowDays })}
      </p>
    );
  }
  const costs = plotted.map((model) => model.facts.cost?.typical ?? 0);
  const minLog = Math.log10(Math.min(...costs));
  const maxLog = Math.log10(Math.max(...costs));
  const mostPeople = Math.max(...plotted.map((m) => m.facts.usage.people));
  const largest = Math.max(
    ...plotted.map((m) => measureOf(m.facts, measure)),
    0,
  );
  // Inset so a circle on an edge is not cut off.
  const x = (cost: number): number =>
    maxLog === minLog
      ? 50
      : 8 + ((Math.log10(cost) - minLog) / (maxLog - minLog)) * 84;
  const y = (people: number): number =>
    8 + (1 - Math.sqrt(people / mostPeople)) * 84;
  const size = (value: number): number =>
    largest <= 0
      ? MIN_DOT_PX
      : MIN_DOT_PX + Math.sqrt(value / largest) * (MAX_DOT_PX - MIN_DOT_PX);
  const valueText = (facts: ModelFacts): string =>
    measure === 'spend'
      ? format.usd(facts.spendUsd ?? 0)
      : measure === 'footprint'
        ? facts.footprintGrams === null
          ? t('modelAccess.facts.footprint.notSet')
          : format.co2(facts.footprintGrams)
        : format.count(facts.usage.requests ?? 0);
  const findings = mapFindings(models);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <p className={`min-w-0 flex-[1_1_28rem] ${ADMIN_MUTED}`}>
          {t('modelAccess.map.lead', { days: windowDays })}
        </p>
        <div
          role="group"
          aria-label={t('modelAccess.map.sizeLabel')}
          className="flex flex-wrap items-center gap-2"
        >
          <span className={ADMIN_MUTED}>{t('modelAccess.map.sizeLabel')}</span>
          {SIZE_MEASURES.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={measure === option}
              onClick={() => setMeasure(option)}
              className={`min-h-9 rounded-md border px-3 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                measure === option
                  ? 'border-gray-900 bg-gray-900 font-semibold text-white dark:border-white dark:bg-white dark:text-gray-900'
                  : 'border-gray-300 bg-white text-gray-900 hover:bg-gray-50 dark:border-gray-600 dark:bg-surface-dark dark:text-white dark:hover:bg-gray-800'
              }`}
            >
              {t(`modelAccess.map.size.${option}` as never)}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
        <div className={`p-4 ${PANEL}`}>
          <p className="mb-1 text-xs font-semibold text-gray-700 dark:text-gray-300">
            {t('modelAccess.map.axisPeople', { days: windowDays })}
          </p>
          <div className="relative h-[26rem] border-b border-s border-gray-400 dark:border-gray-500">
            {plotted.map((model) => {
              const px = size(measureOf(model.facts, measure));
              const sizeClass = model.facts.footprint?.sizeClass;
              const label = t('modelAccess.map.dotLabel', {
                model: model.label,
                people: model.facts.usage.people,
                cost: format.perRequest(model.facts.cost?.typical ?? 0),
                value: valueText(model.facts),
              });
              return (
                <button
                  key={model.facts.modelId}
                  type="button"
                  aria-label={label}
                  title={label}
                  onClick={() => onOpen(model.facts.modelId)}
                  className="group absolute flex -translate-x-1/2 -translate-y-1/2 items-center focus:outline-none"
                  style={{
                    insetInlineStart: `${x(model.facts.cost?.typical ?? 0)}%`,
                    top: `${y(model.facts.usage.people)}%`,
                  }}
                >
                  <span
                    className={`block shrink-0 rounded-full border-2 opacity-90 group-hover:opacity-100 group-focus-visible:ring-2 group-focus-visible:ring-blue-500 group-focus-visible:ring-offset-2 ${sizeClass ? SIZE_FILL[sizeClass] : SIZE_UNSET}`}
                    style={{ width: px, height: px }}
                  />
                  <span className="absolute start-full ms-1.5 whitespace-nowrap text-xs">
                    <strong className="text-gray-900 dark:text-white">
                      {model.label}
                    </strong>{' '}
                    <span className="text-gray-600 dark:text-gray-400">
                      {valueText(model.facts)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <p className="mt-1 flex justify-between text-xs tabular-nums text-gray-600 dark:text-gray-400">
            <span>{format.perRequest(Math.min(...costs))}</span>
            <span>{format.perRequest(Math.max(...costs))}</span>
          </p>
          <p className="text-center text-xs font-semibold text-gray-700 dark:text-gray-300">
            {t('modelAccess.map.axisCost')}
          </p>
          <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-600 dark:text-gray-400">
            <span className="font-semibold">
              {t('modelAccess.map.legendTitle')}
            </span>
            {(['mini', 'standard', 'large', 'xl'] as const).map((sizeClass) => (
              <span
                key={sizeClass}
                className="inline-flex items-center gap-1.5"
              >
                <span
                  className={`inline-block h-3 w-3 rounded-full border-2 ${SIZE_FILL[sizeClass]}`}
                />
                {t(`modelAccess.map.legend.${sizeClass}` as never)}
              </span>
            ))}
            <span className="inline-flex items-center gap-1.5">
              <span
                className={`inline-block h-3 w-3 rounded-full border-2 ${SIZE_UNSET}`}
              />
              {t('modelAccess.map.legend.unset')}
            </span>
          </p>
        </div>
        <FindingList findings={findings} format={format} />
      </div>
      <div className={`overflow-x-auto ${PANEL}`}>
        <table className="w-full min-w-[40rem] text-sm">
          <caption className="sr-only">{t('modelAccess.map.caption')}</caption>
          <thead>
            <tr className="text-left text-xs text-gray-600 dark:text-gray-400">
              <th scope="col" className="px-4 py-2 font-semibold">
                {t('modelAccess.grid.col.model')}
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                {t('modelAccess.runway.col.people')}
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                {t('modelAccess.map.col.requests')}
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                {t('modelAccess.map.col.perRequest')}
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                {t('modelAccess.map.size.spend')}
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                {t('modelAccess.map.size.footprint')}
              </th>
            </tr>
          </thead>
          <tbody className="tabular-nums text-gray-800 dark:text-gray-200">
            {[...plotted]
              .sort((a, b) => (b.facts.spendUsd ?? 0) - (a.facts.spendUsd ?? 0))
              .map(({ facts, label }) => (
                <tr
                  key={facts.modelId}
                  className="border-t border-gray-100 dark:border-gray-800"
                >
                  <th scope="row" className="px-4 py-1.5 text-left font-normal">
                    {label}
                  </th>
                  <td className="px-3 py-1.5">
                    {format.count(facts.usage.people)}
                  </td>
                  <td className="px-3 py-1.5">
                    {facts.usage.requests === null
                      ? t('modelAccess.map.unknown')
                      : format.count(facts.usage.requests)}
                  </td>
                  <td className="px-3 py-1.5">
                    {format.perRequest(facts.cost?.typical ?? 0)}
                  </td>
                  <td className="px-3 py-1.5">
                    {facts.spendUsd === null
                      ? t('modelAccess.map.unknown')
                      : format.usd(facts.spendUsd)}
                  </td>
                  <td className="px-3 py-1.5">
                    {facts.footprintGrams === null
                      ? t('modelAccess.map.unknown')
                      : format.co2(facts.footprintGrams)}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const FindingList: FC<{
  findings: readonly MapFinding[];
  format: ModelFactFormat;
}> = ({ findings, format }) => {
  const t = useTranslations('limits');
  if (findings.length === 0) {
    return <p className={ADMIN_MUTED}>{t('modelAccess.map.noFindings')}</p>;
  }
  const text = (finding: MapFinding): string => {
    switch (finding.kind) {
      case 'concentrated':
        return t('modelAccess.map.finding.concentrated', {
          model: finding.label,
          share: format.percent(finding.share),
        });
      case 'reached':
        return t('modelAccess.map.finding.reached', {
          model: finding.label,
          people: finding.people,
          of: finding.of,
          cap: finding.cap,
        });
      case 'unreached':
        return t('modelAccess.map.finding.unreached', {
          model: finding.label,
          cap: finding.cap,
          max: finding.max,
        });
      case 'noCeiling':
        return t('modelAccess.map.finding.noCeiling', {
          models: finding.labels.join(', '),
          max: finding.max,
        });
    }
  };
  return (
    <ul className="space-y-3">
      {findings.map((finding, index) => (
        <li
          key={`${finding.kind}-${index}`}
          className={`p-3 text-sm ${
            finding.kind === 'noCeiling'
              ? ADMIN_BANNER_WARN
              : `${PANEL} text-gray-800 dark:text-gray-200`
          }`}
        >
          <strong className="block">
            {t(`modelAccess.map.findingTitle.${finding.kind}` as never)}
          </strong>
          {text(finding)}
        </li>
      ))}
    </ul>
  );
};
