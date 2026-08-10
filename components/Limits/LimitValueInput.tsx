'use client';

import { FC } from 'react';

import { useTranslations } from 'next-intl';

import {
  ADMIN_CHIP_DANGER,
  ADMIN_FIELD,
  ADMIN_MUTED,
} from '@/components/Admin/adminClasses';

import { LimitDefinition } from '@/config/limits';

export type LimitValueState = number | boolean | null;

interface LimitValueInputProps {
  def: LimitDefinition;
  /**
   * `undefined` = NOT SET (inherit from the layer below).
   * `null` = explicitly unlimited. These are different and must stay so.
   */
  value: LimitValueState | undefined;
  onChange: (value: LimitValueState | undefined) => void;
  /**
   * Hides the "Not set — inherit" option for cells where inheriting has no
   * meaning. NOT for global defaults: an unset global default is the common
   * case, and hiding the option there would render a <select> whose value
   * matches no <option>, so the browser would display the first one and every
   * unconfigured row would read as an explicit "Unlimited".
   */
  allowInherit?: boolean;
  disabled?: boolean;
}

type Mode = 'inherit' | 'unlimited' | 'limited' | 'blocked';

function modeOf(value: LimitValueState | undefined, isBoolean: boolean): Mode {
  if (value === undefined) return 'inherit';
  if (isBoolean) return value === false ? 'blocked' : 'unlimited';
  if (value === null || value === true) return 'unlimited';
  if (value === 0) return 'blocked';
  return 'limited';
}

/**
 * The three-state control for a single limit.
 *
 * This is where admins actually make mistakes, so the states are rendered as
 * explicitly distinct options rather than an empty-means-something text box:
 *
 *  - Not set — inherit from the layer below (absent from the stored entries)
 *  - Unlimited — an explicit `null`, which OVERRIDES a lower layer's cap
 *  - Limited to N — a number
 *  - Blocked — `0` for a counter, `false` for a boolean gate
 *
 * "Clear the field and it goes back to the default" would be wrong for a
 * feature where clearing can mean granting unlimited access.
 */
export const LimitValueInput: FC<LimitValueInputProps> = ({
  def,
  value,
  onChange,
  allowInherit = true,
  disabled = false,
}) => {
  const t = useTranslations('limits');
  const isBoolean = def.unit === 'boolean';
  const mode = modeOf(value, isBoolean);

  const setMode = (next: Mode) => {
    if (next === 'inherit') return onChange(undefined);
    if (next === 'blocked') return onChange(isBoolean ? false : 0);
    if (next === 'unlimited') return onChange(isBoolean ? true : null);
    onChange(typeof value === 'number' && value > 0 ? value : 1);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className={ADMIN_FIELD}
        value={mode}
        onChange={(e) => setMode(e.target.value as Mode)}
        disabled={disabled}
        aria-label={t('valueModeLabel')}
      >
        {allowInherit && <option value="inherit">{t('modeInherit')}</option>}
        <option value="unlimited">
          {isBoolean ? t('modeAllowed') : t('modeUnlimited')}
        </option>
        {!isBoolean && <option value="limited">{t('modeLimited')}</option>}
        <option value="blocked">{t('modeBlocked')}</option>
      </select>

      {mode === 'limited' && (
        <span className="flex items-center gap-1.5">
          <input
            type="number"
            min={1}
            max={def.hardCeiling}
            inputMode="numeric"
            // Chrome paints the number spinners as light UA chrome, which is
            // an unreadable white block on a dark field.
            className={`w-28 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none ${ADMIN_FIELD}`}
            value={typeof value === 'number' ? value : ''}
            onChange={(e) => {
              const parsed = Number.parseInt(e.target.value, 10);
              if (Number.isNaN(parsed)) return onChange(1);
              const clamped =
                def.hardCeiling !== undefined
                  ? Math.min(parsed, def.hardCeiling)
                  : parsed;
              onChange(Math.max(0, clamped));
            }}
            disabled={disabled}
            aria-label={t('valueAmountLabel')}
          />
          <span className={ADMIN_MUTED}>
            {t(`unit.${def.unit}` as never)}
            {def.window !== 'none' && def.window !== 'request'
              ? ` / ${t(`window.${def.window}` as never)}`
              : ''}
          </span>
        </span>
      )}

      {mode === 'blocked' && (
        <span className={ADMIN_CHIP_DANGER}>{t('blockedChip')}</span>
      )}

      {def.hardCeiling !== undefined && (
        <span className={ADMIN_MUTED}>
          {t('hardCeilingHint', { value: def.hardCeiling })}
        </span>
      )}
    </div>
  );
};
