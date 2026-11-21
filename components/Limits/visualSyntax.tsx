'use client';

/**
 * The limits admin's visual vocabulary: one meaning per mark, used on every
 * screen (Overview, Person, Rule editor, Review). Stated once here so no
 * screen re-derives it:
 *
 *  - VALUE CHIP: solid outline = set at this level; dashed and muted =
 *    inherited from below (shown with ↓); ∞ = unlimited; ⊘ = off / blocked;
 *    a thick top edge (the "lid") = a hard ceiling nothing more specific may
 *    exceed; a dashed solid chip = set by a delegated admin; struck through =
 *    set but outranked or held down; a blue ring = the value that decides.
 *  - AUDIENCE SHAPE, least to most specific: ○ everyone, ◇ domain,
 *    △ attribute, □ group, ● person. The order of the shapes IS precedence.
 *  - DIRECTION: ↑ looser (people get more) in blue, ↓ stricter in orange,
 *    ∞ removes a cap (always called out, never folded into ↑). Blue and
 *    orange, never red and green.
 *  - PRESSURE BAR: people by how close they came to their own cap.
 */
import { FC, ReactNode } from 'react';

import { useLocale, useTranslations } from 'next-intl';

import { ChangeDirection } from '@/lib/services/limits/policyChanges';
import { LimitSource } from '@/lib/services/limits/resolver';
import { LimitValue, OverrideScope } from '@/lib/services/limits/types';
import type { PressureBands } from '@/lib/services/limits/wire';

import { LimitDefinition } from '@/config/limits';

/** Audience kinds in precedence order (least specific first). */
export type AudienceKind = 'everyone' | OverrideScope;

export const AUDIENCE_ORDER: readonly AudienceKind[] = [
  'everyone',
  'domain',
  'attribute',
  'group',
  'user',
];

const AUDIENCE_GLYPH: Record<AudienceKind, string> = {
  everyone: '○',
  domain: '◇',
  attribute: '△',
  group: '□',
  user: '●',
};

/** The resolver's layer for an audience kind. */
export function audienceOfSource(source: LimitSource): AudienceKind | null {
  if (source === 'global') return 'everyone';
  if (source === 'catalog') return null;
  return source;
}

/** The glyph alone, hidden from assistive tech (callers say the words). */
export const AudienceShape: FC<{ kind: AudienceKind; className?: string }> = ({
  kind,
  className = '',
}) => (
  <span
    aria-hidden="true"
    className={`inline-block w-4 text-center ${className}`}
  >
    {AUDIENCE_GLYPH[kind]}
  </span>
);

/** How a value chip is drawn; see the module header. */
export interface ValueChipStyle {
  /** Not set here: shown dashed and muted, with ↓. */
  inherited?: boolean;
  /** A global hard ceiling (the lid). */
  ceiling?: boolean;
  /** Set by a delegated admin. */
  delegated?: boolean;
  /** Set, but outranked or held down. */
  lost?: boolean;
  /** The value that decides, in a cascade. */
  winner?: boolean;
}

/**
 * Formats a limit value for a chip: a number in the viewer's locale
 * (compact above ten thousand), ∞ for unlimited, the gate words for booleans.
 */
export function useFormatLimitValue(): (
  value: LimitValue,
  def?: LimitDefinition,
) => { text: string; label: string } {
  const t = useTranslations('limits');
  const locale = useLocale();
  return (value, def) => {
    if (value === null) return { text: '∞', label: t('modeUnlimited') };
    if (value === true)
      return { text: t('modeAllowed'), label: t('modeAllowed') };
    if (value === false || (value === 0 && def?.unit !== 'boolean')) {
      return { text: `⊘ ${t('console.off')}`, label: t('modeBlocked') };
    }
    const formatted = new Intl.NumberFormat(locale, {
      notation: value >= 10_000 ? 'compact' : 'standard',
      maximumFractionDigits: 1,
    }).format(value);
    return { text: formatted, label: formatted };
  };
}

/** One value in the visual syntax. */
export const ValueChip: FC<
  ValueChipStyle & {
    value: LimitValue;
    def?: LimitDefinition;
    prefix?: ReactNode;
  }
> = ({ value, def, inherited, ceiling, delegated, lost, winner, prefix }) => {
  const t = useTranslations('limits');
  const format = useFormatLimitValue();
  const { text, label } = format(value, def);
  const off = value === false || (value === 0 && def?.unit !== 'boolean');
  const classes = [
    'inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-md border px-2 text-xs tabular-nums',
    inherited
      ? 'border-dashed border-gray-400 font-normal text-gray-600 dark:border-gray-500 dark:text-gray-400'
      : off
        ? 'border-gray-400 bg-gray-200 font-semibold text-gray-800 dark:border-gray-500 dark:bg-gray-700 dark:text-gray-100'
        : 'border-gray-900 bg-white font-semibold text-gray-900 dark:border-gray-200 dark:bg-gray-900 dark:text-white',
    delegated && !inherited ? 'border-dashed' : '',
    ceiling ? 'border-t-4' : '',
    lost
      ? 'border-gray-300 font-normal text-gray-500 line-through dark:border-gray-600 dark:text-gray-500'
      : '',
    winner
      ? 'ring-2 ring-blue-600 ring-offset-2 ring-offset-white dark:ring-blue-400 dark:ring-offset-gray-900'
      : '',
  ].join(' ');
  const described = [
    label,
    inherited ? t('console.sr.inherited') : '',
    ceiling ? t('console.sr.ceiling') : '',
    delegated ? t('console.sr.delegated') : '',
    lost ? t('console.sr.lost') : '',
    winner ? t('console.sr.winner') : '',
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <span className={classes} title={described}>
      <span className="sr-only">{described}</span>
      <span aria-hidden="true" className="inline-flex items-center gap-1">
        {inherited && <span>↓</span>}
        {prefix}
        {text}
      </span>
    </span>
  );
};

const DIRECTION_STYLE: Record<'looser' | 'stricter' | 'removes-cap', string> = {
  looser: 'text-blue-700 dark:text-blue-400',
  stricter: 'text-orange-700 dark:text-orange-400',
  'removes-cap': 'text-gray-900 dark:text-white',
};

const DIRECTION_GLYPH: Record<'looser' | 'stricter' | 'removes-cap', string> = {
  looser: '↑',
  stricter: '↓',
  'removes-cap': '∞',
};

/** ↑ / ↓ / ∞ with its words for assistive tech. */
export const DirectionMark: FC<{
  direction: ChangeDirection | 'removes-cap';
  withLabel?: boolean;
}> = ({ direction, withLabel = false }) => {
  const t = useTranslations('limits');
  if (direction === 'same') return null;
  const label = t(`console.direction.${direction}` as never);
  return (
    <span className={`font-bold ${DIRECTION_STYLE[direction]}`}>
      <span aria-hidden="true">{DIRECTION_GLYPH[direction]}</span>
      {withLabel ? (
        <span className="ml-1">{label}</span>
      ) : (
        <span className="sr-only">{label}</span>
      )}
    </span>
  );
};

/** Band colours, least to most pressure. */
export const PRESSURE_COLORS: Record<keyof PressureBands, string> = {
  underHalf: 'bg-slate-300 dark:bg-slate-600',
  toEighty: 'bg-blue-400 dark:bg-blue-500',
  nearCap: 'bg-orange-400 dark:bg-orange-400',
  atCap: 'bg-orange-800 dark:bg-orange-600',
};

const BAND_ORDER: readonly (keyof PressureBands)[] = [
  'underHalf',
  'toEighty',
  'nearCap',
  'atCap',
];

/** People by how close they came to their own cap, as one stacked bar. */
export const PressureBar: FC<{ bands: PressureBands; className?: string }> = ({
  bands,
  className = 'w-28',
}) => {
  const t = useTranslations('limits');
  const total = BAND_ORDER.reduce((sum, band) => sum + bands[band], 0);
  if (total === 0) return null;
  const label = t('console.pressureLabel', {
    underHalf: bands.underHalf,
    toEighty: bands.toEighty,
    nearCap: bands.nearCap,
    atCap: bands.atCap,
  });
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`flex h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800 ${className}`}
    >
      {BAND_ORDER.map((band) =>
        bands[band] > 0 ? (
          <span
            key={band}
            className={PRESSURE_COLORS[band]}
            style={{ width: `${(bands[band] / total) * 100}%` }}
          />
        ) : null,
      )}
    </span>
  );
};

/** The four bands as a small legend. */
export const PressureLegend: FC = () => {
  const t = useTranslations('limits');
  return (
    <span className="flex flex-wrap items-center gap-3 text-xs text-gray-600 dark:text-gray-400">
      <span>{t('console.pressureLegendTitle')}</span>
      {BAND_ORDER.map((band) => (
        <span key={band} className="flex items-center gap-1">
          <span
            aria-hidden="true"
            className={`inline-block h-2.5 w-2.5 ${PRESSURE_COLORS[band]}`}
          />
          {t(`console.band.${band}` as never)}
        </span>
      ))}
    </span>
  );
};

/** The symbol legend shown under the Overview header. */
export const SymbolLegend: FC = () => {
  const t = useTranslations('limits');
  return (
    <section
      aria-label={t('console.legendTitle')}
      className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-600 dark:text-gray-400"
    >
      <span className="flex items-center gap-1.5">
        <ValueChip value={200} /> {t('console.legend.set')}
      </span>
      <span className="flex items-center gap-1.5">
        <ValueChip value={200} inherited /> {t('console.legend.inherited')}
      </span>
      <span className="flex items-center gap-1.5">
        <ValueChip value={null} /> {t('console.legend.unlimited')}
      </span>
      <span className="flex items-center gap-1.5">
        <ValueChip value={false} /> {t('console.legend.off')}
      </span>
      <span className="flex items-center gap-1.5">
        <ValueChip value={2000} ceiling /> {t('console.legend.ceiling')}
      </span>
      <span className="flex items-center gap-1.5">
        <ValueChip value={150} delegated /> {t('console.legend.delegated')}
      </span>
      <span className="flex items-center gap-1" aria-hidden="true">
        {AUDIENCE_ORDER.map((kind) => (
          <AudienceShape key={kind} kind={kind} />
        ))}
      </span>
      <span>{t('console.legend.shapes')}</span>
    </section>
  );
};
