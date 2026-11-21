'use client';

import {
  IconArrowDown,
  IconArrowLeft,
  IconArrowRight,
  IconArrowUp,
  IconMinus,
  IconPlus,
} from '@tabler/icons-react';

import { useTranslations } from 'next-intl';

import {
  NATIVE_PDF_FONT_SIZE_STEP,
  NATIVE_PDF_MAX_FONT_SIZE,
  NATIVE_PDF_MIN_FONT_SIZE,
  NATIVE_PDF_SHIFT_STEP,
  NativePdfUnitResult,
  NativePdfUnitStyle,
} from '@/lib/utils/shared/translation/nativePdf';

/** Colour shown for a block whose source colour is not known. */
const UNKNOWN_COLOR = '#000000';

interface FormattedBlockStyleProps {
  /** The block; its `size` and `color` are what the source has. */
  unit: Pick<NativePdfUnitResult, 'n' | 'size' | 'color'>;
  /** The look the person wants; empty means the source's own. */
  style: NativePdfUnitStyle;
  /** The look differs from what is on the page. */
  pending: boolean;
  disabled: boolean;
  /**
   * A move shifts the whole shape the block is in (a presentation's text
   * box, with every paragraph in it), not the block alone; the box says so.
   */
  movesShape?: boolean;
  /** Sets fields of the look; `undefined` puts a field back to the source's. */
  onChange: (change: Partial<NativePdfUnitStyle>) => void;
  /** Drops the whole look. */
  onReset: () => void;
}

/**
 * The look of one text block: font size, position and text colour. Each
 * control changes one thing in small steps; nothing here is on the page
 * until it is re-rendered, though the block's outline moves at once.
 *
 * Moves follow NativePdfUnitStyle's convention: +x is right, +y is down.
 */
export function FormattedBlockStyle({
  unit,
  style,
  pending,
  disabled,
  movesShape = false,
  onChange,
  onReset,
}: FormattedBlockStyleProps) {
  const t = useTranslations('workflows');
  const size = style.size ?? unit.size;
  const color = style.color ?? unit.color?.toLowerCase() ?? UNKNOWN_COLOR;
  const dx = style.dx ?? 0;
  const dy = style.dy ?? 0;
  const styled = Object.keys(style).length > 0;
  const step =
    'inline-flex h-7 w-7 items-center justify-center rounded-md border border-gray-300 text-gray-700 hover:bg-gray-100 disabled:opacity-40 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-surface-dark-elevated';
  const label = 'w-14 shrink-0 text-[11px] text-gray-500 dark:text-gray-400';
  const value = 'text-xs tabular-nums text-gray-700 dark:text-gray-300';
  const signed = (points: number) =>
    `${points > 0 ? '+' : points < 0 ? '−' : ''}${Math.abs(points)}`;
  const moves = [
    {
      key: 'moveLeft',
      Icon: IconArrowLeft,
      change: { dx: dx - NATIVE_PDF_SHIFT_STEP },
    },
    {
      key: 'moveUp',
      Icon: IconArrowUp,
      change: { dy: dy - NATIVE_PDF_SHIFT_STEP },
    },
    {
      key: 'moveDown',
      Icon: IconArrowDown,
      change: { dy: dy + NATIVE_PDF_SHIFT_STEP },
    },
    {
      key: 'moveRight',
      Icon: IconArrowRight,
      change: { dx: dx + NATIVE_PDF_SHIFT_STEP },
    },
  ] as const;

  return (
    <fieldset
      disabled={disabled}
      data-testid="block-style"
      className="flex flex-col gap-1.5 rounded-lg border border-gray-200 px-2.5 py-2 dark:border-gray-700"
    >
      <legend className="px-1 text-[11px] font-medium text-gray-700 dark:text-gray-300">
        {t('translation.formatted.styleTitle')}
      </legend>
      {size !== undefined && (
        <div className="flex items-center gap-1.5">
          <span className={label}>{t('translation.formatted.styleSize')}</span>
          <button
            type="button"
            aria-label={t('translation.formatted.styleSmaller')}
            title={t('translation.formatted.styleSmaller')}
            disabled={size <= NATIVE_PDF_MIN_FONT_SIZE}
            onClick={() => onChange({ size: size - NATIVE_PDF_FONT_SIZE_STEP })}
            className={step}
          >
            <IconMinus size={13} aria-hidden />
          </button>
          <span className={`min-w-[3.5rem] text-center ${value}`}>
            {t('translation.formatted.styleSizeValue', { size })}
          </span>
          <button
            type="button"
            aria-label={t('translation.formatted.styleLarger')}
            title={t('translation.formatted.styleLarger')}
            disabled={size >= NATIVE_PDF_MAX_FONT_SIZE}
            onClick={() => onChange({ size: size + NATIVE_PDF_FONT_SIZE_STEP })}
            className={step}
          >
            <IconPlus size={13} aria-hidden />
          </button>
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <span className={label}>{t('translation.formatted.styleMove')}</span>
        {moves.map(({ key, Icon, change }) => (
          <button
            key={key}
            type="button"
            aria-label={t(`translation.formatted.${key}`)}
            title={t(`translation.formatted.${key}`)}
            onClick={() => onChange(change)}
            className={step}
          >
            <Icon size={13} aria-hidden />
          </button>
        ))}
        {(dx !== 0 || dy !== 0) && (
          <span className={value}>
            {t('translation.formatted.styleOffset', {
              x: signed(dx),
              y: signed(dy),
            })}
          </span>
        )}
      </div>
      {movesShape && (
        <p className="ps-[3.875rem] text-[11px] text-gray-500 dark:text-gray-400">
          {t('translation.formatted.styleMoveShape')}
        </p>
      )}
      <div className="flex items-center gap-1.5">
        <span className={label}>{t('translation.formatted.styleColor')}</span>
        <input
          type="color"
          value={color}
          aria-label={t('translation.formatted.styleColorOf', { n: unit.n })}
          onChange={(event) => onChange({ color: event.target.value })}
          className="h-7 w-9 cursor-pointer rounded-md border border-gray-300 bg-transparent p-0.5 disabled:cursor-default disabled:opacity-40 dark:border-gray-600"
        />
        <span className={`${value} uppercase`}>{color}</span>
      </div>
      {(styled || pending) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5">
          {pending && (
            <span className="text-[11px] text-amber-700 dark:text-amber-400">
              {t('translation.formatted.styleNote')}
            </span>
          )}
          {styled && (
            <button
              type="button"
              onClick={onReset}
              className="text-[11px] text-blue-700 hover:underline dark:text-blue-300"
            >
              {t('translation.formatted.styleReset')}
            </button>
          )}
        </div>
      )}
    </fieldset>
  );
}
