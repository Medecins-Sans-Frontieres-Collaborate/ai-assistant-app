'use client';

import { FC, useId, useState } from 'react';

import { useTranslations } from 'next-intl';

import { LimitValue } from '@/lib/services/limits/types';

import { ValueChip } from '@/components/Limits/visualSyntax';

import { LimitDefinition } from '@/config/limits';

/** The kind of answer a rule gives for one limit. */
export type ValueKind = 'inherit' | 'limit' | 'unlimited' | 'on' | 'off';

/** The kind of a stored value; see the value convention in types.ts. */
export function kindOf(
  value: LimitValue | undefined,
  def: LimitDefinition,
): ValueKind {
  if (value === undefined) return 'inherit';
  if (def.unit === 'boolean') return value === false ? 'off' : 'on';
  if (value === null || value === true) return 'unlimited';
  if (value === 0 || value === false) return 'off';
  return 'limit';
}

/** Kinds offered for a definition, in display order. */
export function kindsFor(
  def: LimitDefinition,
  allowInherit: boolean,
): ValueKind[] {
  const kinds: ValueKind[] =
    def.unit === 'boolean' ? ['on', 'off'] : ['limit', 'unlimited', 'off'];
  return allowInherit ? ['inherit', ...kinds] : kinds;
}

/**
 * The value a kind stores. Switching to Limit keeps a number already in
 * play (this value, else the inherited one) and otherwise seeds 100, clamped
 * to any compiled ceiling; never `null`, which would grant unlimited.
 */
export function valueForKind(
  kind: ValueKind,
  def: LimitDefinition,
  current: LimitValue | undefined,
  inherited: LimitValue | undefined,
): LimitValue | undefined {
  switch (kind) {
    case 'inherit':
      return undefined;
    case 'on':
      return true;
    case 'off':
      return def.unit === 'boolean' ? false : 0;
    case 'unlimited':
      return null;
    case 'limit': {
      const seed =
        typeof current === 'number' && current > 0
          ? current
          : typeof inherited === 'number' && inherited > 0
            ? inherited
            : 100;
      return Math.min(seed, def.hardCeiling ?? Number.POSITIVE_INFINITY);
    }
  }
}

interface ValueChoiceProps {
  def: LimitDefinition;
  /** `undefined` = not set here (inherit). */
  value: LimitValue | undefined;
  onChange: (value: LimitValue | undefined) => void;
  /** What applies when this level sets nothing; shown for Inherit. */
  inherited: LimitValue;
  /** Accessible name of the whole control (usually the limit's name). */
  label: string;
  /** Offer Inherit. False for the org default, where nothing sits below. */
  allowInherit?: boolean;
  /**
   * The kinds to offer, when the definition's own set does not fit (a grant
   * cannot be Off). Defaults to `kindsFor(def, allowInherit)`.
   */
  kinds?: readonly ValueKind[];
  disabled?: boolean;
}

/**
 * The rule editor's control for one limit: WHAT KIND of answer (a segmented
 * radio group with no field inside any option) separate from THE VALUE (a
 * column that is always in the same place). The value column is a number
 * field with its unit when the answer is a limit, and the matching chip
 * otherwise, so every row lines up and reads in the same visual syntax.
 */
export const ValueChoice: FC<ValueChoiceProps> = ({
  def,
  value,
  onChange,
  inherited,
  label,
  allowInherit = true,
  kinds: offered,
  disabled = false,
}) => {
  const t = useTranslations('limits');
  const name = useId();
  const kind = kindOf(value, def);
  const kinds = offered ?? kindsFor(def, allowInherit);
  const unit = t(`unit.${def.unit}` as never);
  const suffix =
    def.window === 'day' || def.window === 'month'
      ? t('console.unitPerWindow', {
          unit,
          window: t(`window.${def.window}` as never),
        })
      : unit;

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div
        role="radiogroup"
        aria-label={label}
        className="grid overflow-hidden rounded-lg border border-gray-300 dark:border-gray-600"
        style={{
          gridTemplateColumns: `repeat(${kinds.length}, minmax(0, 1fr))`,
        }}
      >
        {kinds.map((option) => {
          const checked = option === kind;
          return (
            <label
              key={option}
              className={`relative flex h-9 min-w-[5.5rem] cursor-pointer items-center justify-center whitespace-nowrap border-r border-gray-200 px-3 text-sm last:border-r-0 focus-within:ring-2 focus-within:ring-inset focus-within:ring-blue-500 dark:border-gray-700 ${
                checked
                  ? 'bg-gray-900 font-semibold text-white dark:bg-gray-100 dark:text-gray-900'
                  : 'bg-white text-gray-900 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-100 dark:hover:bg-gray-800'
              } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
            >
              <input
                type="radio"
                className="sr-only"
                name={name}
                checked={checked}
                disabled={disabled}
                onChange={() =>
                  onChange(valueForKind(option, def, value, inherited))
                }
              />
              {t(`console.kind.${option}` as never)}
            </label>
          );
        })}
      </div>

      <div className="flex h-9 min-w-[13rem] items-center gap-2">
        {kind === 'limit' ? (
          <label className="flex h-9 items-center overflow-hidden rounded-lg border border-gray-900 bg-white focus-within:ring-2 focus-within:ring-blue-500 dark:border-gray-300 dark:bg-gray-900">
            <span className="sr-only">
              {t('console.valueFor', { limit: label })}
            </span>
            <LimitNumberInput
              value={typeof value === 'number' ? value : 1}
              max={def.hardCeiling ?? 1_000_000_000}
              disabled={disabled}
              onCommit={onChange}
            />
            <span className="whitespace-nowrap pr-3 text-xs text-gray-600 dark:text-gray-400">
              {suffix}
            </span>
          </label>
        ) : kind === 'inherit' ? (
          <>
            <ValueChip value={inherited} def={def} inherited />
            <span className="text-xs text-gray-600 dark:text-gray-400">
              {t('console.fromBelow')}
            </span>
          </>
        ) : (
          <ValueChip value={value as LimitValue} def={def} />
        )}
      </div>
    </div>
  );
};

/**
 * A whole-number field that lets the admin clear it and type afresh: the
 * text is local, and only a valid number within 1..max is committed. On
 * blur an invalid entry snaps back to the committed value.
 */
const LimitNumberInput: FC<{
  value: number;
  max: number;
  disabled: boolean;
  onCommit: (value: number) => void;
}> = ({ value, max, disabled, onCommit }) => {
  const [text, setText] = useState(String(value));
  const [committed, setCommitted] = useState(value);
  // Adopt a value changed from outside (another control, a reload).
  if (value !== committed) {
    setCommitted(value);
    setText(String(value));
  }
  return (
    <input
      type="number"
      inputMode="numeric"
      min={1}
      max={max}
      value={text}
      disabled={disabled}
      onChange={(event) => {
        setText(event.target.value);
        const parsed = Number.parseInt(event.target.value, 10);
        if (Number.isNaN(parsed) || parsed < 1) return;
        const bounded = Math.min(parsed, max);
        setCommitted(bounded);
        onCommit(bounded);
      }}
      onBlur={() => setText(String(committed))}
      className="h-full w-28 border-0 bg-transparent px-3 text-right text-sm font-semibold tabular-nums text-gray-900 focus:outline-none dark:text-white"
    />
  );
};
