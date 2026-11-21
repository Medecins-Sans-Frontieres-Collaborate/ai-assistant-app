'use client';

import { FC } from 'react';

import { useTranslations } from 'next-intl';

import {
  CapCeiling,
  ModelFacts,
  UsageSpread,
  isRetiringSoon,
  usageSpread,
} from '@/lib/utils/app/modelFacts';

import {
  ADMIN_CHIP_NEUTRAL,
  ADMIN_CHIP_WARN,
} from '@/components/Admin/adminClasses';
import {
  ModelFactFormat,
  useModelFactFormat,
} from '@/components/Limits/modelFactFormat';

/** The groups of fact columns an admin can show or hide. */
export const FACT_GROUPS = ['cost', 'footprint', 'usage', 'lifecycle'] as const;
export type FactGroup = (typeof FACT_GROUPS)[number];

/** Columns each group adds to the grid; the one place the count lives. */
const GROUP_COLUMNS: Record<FactGroup, number> = {
  cost: 2,
  footprint: 1,
  usage: 2,
  lifecycle: 1,
};

/** How many columns the shown groups add (for the grid's column spans). */
export function factColumnCount(groups: readonly FactGroup[]): number {
  return groups.reduce((sum, group) => sum + GROUP_COLUMNS[group], 0);
}

const HEAD = 'px-3 py-2 font-semibold align-bottom';
const CELL =
  'px-3 py-2 align-middle text-xs text-gray-800 dark:text-gray-200 tabular-nums';
const SUB = 'block text-[11px] text-gray-600 dark:text-gray-400';

/** The header cells for the shown fact groups, in grid order. */
export const FactHeadings: FC<{ groups: readonly FactGroup[] }> = ({
  groups,
}) => {
  const t = useTranslations('limits');
  const shown = new Set(groups);
  return (
    <>
      {shown.has('cost') && (
        <>
          <th scope="col" className={`min-w-[8rem] ${HEAD}`}>
            {t('modelAccess.facts.col.price')}
          </th>
          <th scope="col" className={`min-w-[10rem] ${HEAD}`}>
            {t('modelAccess.facts.col.ceiling')}
          </th>
        </>
      )}
      {shown.has('footprint') && (
        <th scope="col" className={`min-w-[8rem] ${HEAD}`}>
          {t('modelAccess.facts.col.footprint')}
        </th>
      )}
      {shown.has('usage') && (
        <>
          <th scope="col" className={`min-w-[9rem] ${HEAD}`}>
            {t('modelAccess.facts.col.people')}
          </th>
          <th scope="col" className={`min-w-[13rem] ${HEAD}`}>
            {t('modelAccess.facts.col.spread')}
          </th>
        </>
      )}
      {shown.has('lifecycle') && (
        <th scope="col" className={`min-w-[9rem] ${HEAD}`}>
          {t('modelAccess.facts.col.retires')}
        </th>
      )}
    </>
  );
};

interface FactCellsProps {
  groups: readonly FactGroup[];
  /** `null` for a family row: the facts belong to models, so its cells are empty. */
  facts: ModelFacts | null;
  /** What the row's "everyone else" answer can cost one person. */
  ceiling: CapCeiling | null;
  /** The "everyone else" cap in requests a day, when there is one. */
  cap: number | null;
  /** The most people on any one model, so the popularity bars share a scale. */
  mostPeople: number;
  /** The label of the model people land on, when it is known. */
  replacementLabel: string | undefined;
}

/** One row's fact cells for the shown groups, in grid order. */
export const FactCells: FC<FactCellsProps> = ({
  groups,
  facts,
  ceiling,
  cap,
  mostPeople,
  replacementLabel,
}) => {
  const t = useTranslations('limits');
  const format = useModelFactFormat();
  const shown = new Set(groups);
  if (!facts) {
    return (
      <>
        {Array.from({ length: factColumnCount(groups) }, (_, index) => (
          <td key={index} className={CELL} />
        ))}
      </>
    );
  }
  return (
    <>
      {shown.has('cost') && (
        <>
          <td className={CELL}>
            {facts.cost ? (
              <>
                <span className="whitespace-nowrap font-semibold">
                  {t('modelAccess.facts.priceValue', {
                    input: format.price(facts.cost.inputPer1M),
                    output: format.price(facts.cost.outputPer1M),
                  })}
                </span>
              </>
            ) : (
              <Muted>{t('modelAccess.facts.ceiling.unpriced')}</Muted>
            )}
          </td>
          <td className={CELL}>
            <CeilingValue ceiling={ceiling} format={format} />
          </td>
        </>
      )}
      {shown.has('footprint') && (
        <td className={CELL}>
          {facts.footprint ? (
            <>
              <span className="font-semibold">
                {format.co2(facts.footprint.gramsPerRequest)}
              </span>
              <span className={SUB}>
                {t(
                  `modelAccess.facts.size.${facts.footprint.sizeClass}` as never,
                )}
              </span>
            </>
          ) : (
            <Muted>{t('modelAccess.facts.footprint.notSet')}</Muted>
          )}
        </td>
      )}
      {shown.has('usage') && (
        <>
          <td className={CELL}>
            <PeopleValue
              facts={facts}
              mostPeople={mostPeople}
              format={format}
            />
          </td>
          <td className={CELL}>
            <SpreadValue facts={facts} cap={cap} format={format} />
          </td>
        </>
      )}
      {shown.has('lifecycle') && (
        <td className={CELL}>
          <RetiresValue
            facts={facts}
            replacementLabel={replacementLabel}
            format={format}
          />
        </td>
      )}
    </>
  );
};

const Muted: FC<{ children: string }> = ({ children }) => (
  <span className="text-gray-600 dark:text-gray-400">{children}</span>
);

/** What a cap can cost one person in a month, with its long-request range. */
export const CeilingValue: FC<{
  ceiling: CapCeiling | null;
  format: ModelFactFormat;
}> = ({ ceiling, format }) => {
  const t = useTranslations('limits');
  if (!ceiling) return <Muted>{t('modelAccess.facts.ceiling.unpriced')}</Muted>;
  if (ceiling.kind === 'off') {
    return <Muted>{t('modelAccess.facts.ceiling.off')}</Muted>;
  }
  if (ceiling.kind === 'unbounded') {
    return (
      <span className="font-semibold text-orange-800 dark:text-orange-300">
        {t('modelAccess.facts.ceiling.unbounded')}
      </span>
    );
  }
  return (
    <>
      <span className="text-sm font-semibold text-gray-900 dark:text-white">
        {format.usd(ceiling.typical)}
      </span>
      <span className={SUB}>
        {t('modelAccess.facts.ceiling.heavy', {
          amount: format.usd(ceiling.heavy),
        })}
      </span>
    </>
  );
};

const PeopleValue: FC<{
  facts: ModelFacts;
  mostPeople: number;
  format: ModelFactFormat;
}> = ({ facts, mostPeople, format }) => {
  const t = useTranslations('limits');
  const { usage } = facts;
  if (usage.source === 'none') {
    return <Muted>{t('modelAccess.facts.usage.none')}</Muted>;
  }
  const share = mostPeople > 0 ? usage.people / mostPeople : 0;
  return (
    <>
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-gray-900 dark:text-white">
          {format.count(usage.people)}
        </span>
        {facts.spendUsd !== null && (
          <span className="text-[11px] text-gray-600 dark:text-gray-400">
            {t('modelAccess.facts.usage.spend', {
              amount: format.usd(facts.spendUsd),
            })}
          </span>
        )}
      </span>
      <span
        aria-hidden="true"
        className="mt-1 block h-1.5 rounded-full bg-gray-200 dark:bg-gray-700"
      >
        <span
          className="block h-1.5 rounded-full bg-blue-700 dark:bg-blue-400"
          style={{ width: `${Math.max(2, share * 100)}%` }}
        />
      </span>
      {usage.source === 'capped' && (
        <span className={SUB}>{t('modelAccess.facts.usage.cappedOnly')}</span>
      )}
    </>
  );
};

const SpreadValue: FC<{
  facts: ModelFacts;
  cap: number | null;
  format: ModelFactFormat;
}> = ({ facts, cap, format }) => {
  const t = useTranslations('limits');
  const spread = usageSpread(facts.usage.peaks);
  if (!spread) return <Muted>{t('modelAccess.facts.usage.none')}</Muted>;
  return (
    <>
      <SpreadBar spread={spread} cap={cap} />
      <span className={SUB}>
        {t('modelAccess.facts.spread.caption', {
          median: format.count(spread.median),
          p75: format.count(spread.p75),
          max: format.count(spread.max),
        })}
      </span>
    </>
  );
};

/**
 * Where a value sits on the bar, as a percentage. A square-root scale: most
 * people make a handful of requests and a few make very many, and a linear
 * bar would squash the median into the left edge.
 */
function position(value: number, scaleMax: number): number {
  if (scaleMax <= 0) return 0;
  return Math.min(100, Math.sqrt(Math.max(0, value) / scaleMax) * 100);
}

/**
 * People's busiest days as one bar: a line to the 95th percentile, a box
 * from the median to the 75th, a dot for the heaviest person, and the cap as
 * an orange line when there is one.
 */
export const SpreadBar: FC<{ spread: UsageSpread; cap: number | null }> = ({
  spread,
  cap,
}) => {
  const t = useTranslations('limits');
  const scaleMax = Math.max(spread.max, cap ?? 0);
  const at = (value: number) => `${position(value, scaleMax)}%`;
  const label =
    t('modelAccess.facts.spread.label', {
      median: spread.median,
      p75: spread.p75,
      p95: spread.p95,
      max: spread.max,
    }) + (cap !== null ? t('modelAccess.facts.spread.labelCap', { cap }) : '');
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="relative block h-4"
    >
      <span
        className="absolute left-0 top-[7px] h-0.5 bg-gray-400 dark:bg-gray-500"
        style={{ width: at(spread.p95) }}
      />
      <span
        className="absolute top-[3px] h-2.5 rounded-sm bg-blue-700 dark:bg-blue-400"
        style={{
          left: at(spread.median),
          width: `max(3px, calc(${at(spread.p75)} - ${at(spread.median)}))`,
        }}
      />
      <span
        className="absolute top-1 -ml-1 h-2 w-2 rounded-full bg-gray-900 dark:bg-white"
        style={{ left: at(spread.max) }}
      />
      {cap !== null && (
        <span
          className="absolute top-0 -ml-px h-4 w-0.5 bg-orange-700 dark:bg-orange-400"
          style={{ left: at(cap) }}
        />
      )}
    </span>
  );
};

/** What the marks on a {@link SpreadBar} mean. */
export const SpreadLegend: FC = () => {
  const t = useTranslations('limits');
  const item = 'inline-flex items-center gap-1.5';
  return (
    <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-600 dark:text-gray-400">
      <span className={item}>
        <span className="inline-block h-0.5 w-4 bg-gray-400 dark:bg-gray-500" />
        {t('modelAccess.facts.spread.legend.p95')}
      </span>
      <span className={item}>
        <span className="inline-block h-2.5 w-3 rounded-sm bg-blue-700 dark:bg-blue-400" />
        {t('modelAccess.facts.spread.legend.box')}
      </span>
      <span className={item}>
        <span className="inline-block h-2 w-2 rounded-full bg-gray-900 dark:bg-white" />
        {t('modelAccess.facts.spread.legend.max')}
      </span>
      <span className={item}>
        <span className="inline-block h-3.5 w-0.5 bg-orange-700 dark:bg-orange-400" />
        {t('modelAccess.facts.spread.legend.cap')}
      </span>
    </span>
  );
};

/** A model's retirement date as a chip, with how far off it is. */
export const RetiresValue: FC<{
  facts: ModelFacts;
  replacementLabel: string | undefined;
  format: ModelFactFormat;
}> = ({ facts, replacementLabel, format }) => {
  const t = useTranslations('limits');
  const { lifecycle } = facts;
  const to = replacementLabel
    ? t('modelAccess.facts.retires.to', { model: replacementLabel })
    : null;
  if (lifecycle.phase === 'none') {
    return <Muted>{t('modelAccess.facts.retires.none')}</Muted>;
  }
  const urgent = isRetiringSoon(lifecycle.phase) || lifecycle.phase === 'past';
  const chip =
    lifecycle.phase === 'forced'
      ? t('modelAccess.facts.retires.forced')
      : lifecycle.retiresOn
        ? format.date(lifecycle.retiresOn)
        : t('modelAccess.facts.retires.none');
  const when =
    lifecycle.phase === 'past'
      ? t('modelAccess.facts.retires.past')
      : lifecycle.phase !== 'forced' && lifecycle.daysLeft !== undefined
        ? format.fromNow(lifecycle.daysLeft)
        : null;
  return (
    <>
      <span
        className={`whitespace-nowrap ${urgent ? ADMIN_CHIP_WARN : ADMIN_CHIP_NEUTRAL}`}
      >
        {chip}
      </span>
      {(when || to) && (
        <span className={SUB}>{[when, to].filter(Boolean).join(', ')}</span>
      )}
    </>
  );
};
